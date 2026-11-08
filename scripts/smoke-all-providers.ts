import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { serializeOpenAIMessages, appendToolInstructions } from '../src/routes/serialization.ts';

// Real gateway checks. Credentials stay in memory and never enter the report.
const base = (process.env.DSP_API_BASE || 'http://localhost:3440/v1').replace(/\/$/, '');
const origin = new URL(base).origin;
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname),
  'This runner uses local lab credentials; DSP_API_BASE must be a loopback address.');
const output = process.env.DSP_REPORT || '.cache/all-providers-live-result';
const timeout = Number(process.env.DSP_TEST_TIMEOUT_MS || 180_000);
const selected = process.env.DSP_TEST_PROVIDERS?.split(',');
const selectedModels = process.env.DSP_TEST_MODELS?.split(',');
const retryBlocked = process.env.DSP_TEST_RETRY_BLOCKED === '1';
const continueOn502 = process.env.DSP_TEST_CONTINUE_ON_502 === '1';
const responseModes = process.env.DSP_TEST_STREAMS === 'stream' ? [true] : process.env.DSP_TEST_STREAMS === 'json' ? [false] : [false, true];
const load = async (path: string) => {
  const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON file: ${path}`); }
};
let session = await load('.cache/proxy-ia-live-session.json').catch(() => ({ cookie: '', csrf: '' }));
let key = process.env.DSP_API_KEY || '';
let temporaryKeyId = '';
const report: any = process.env.DSP_TEST_RESUME === '1'
  ? await load(output + '.json')
  : { startedAt: new Date().toISOString(), base, transport: 'real authenticated gateway HTTP', providers: [] };
delete report.finishedAt;
// Keep completed evidence when resuming; discard empty duplicate preparations.
report.providers = report.providers.filter((p: any, i: number, all: any[]) =>
  !all.some((other: any, j: number) => j !== i && other.provider === p.provider &&
    ((other.finishedAt && !p.finishedAt) || (j < i && Boolean(other.finishedAt) === Boolean(p.finishedAt)))));
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function panel(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<any> {
  const response = await fetch(origin + path, { method, headers: {
    Cookie: session.cookie, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json',
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const json: any = await response.json();
  if (!response.ok) throw new Error(`Panel ${path}: HTTP ${response.status}: ${json.error?.message || 'request failed'}`);
  return json;
}

async function authenticatePanel() {
  try { const me = await panel('/api/me'); session.csrf = me.csrf; return; } catch { /* Renew expired local lab session. */ }
  const credentials = await load('.cache/proxy-ia-live-admin.json');
  const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Panel login: HTTP ${response.status}`);
  const json: any = await response.json();
  session = { cookie: response.headers.get('set-cookie')!.split(';')[0], csrf: json.csrf };
}

async function save() {
  report.updatedAt = new Date().toISOString();
  await mkdir('.cache', { recursive: true });
  await writeFile(output + '.json', JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Testes reais de todos os provedores', '', `Início: ${report.startedAt}`, `API: ${base}`, '',
    '| Provedor | Modelos | Aprovados | Falhas | Bloqueados | Observação |', '| --- | ---: | ---: | ---: | ---: | --- |'];
  for (const provider of report.providers) {
    const cases = provider.cases || [];
    lines.push(`| ${provider.provider} | ${(provider.models || []).length} | ${cases.filter((c: any) => c.status === 'passed').length} | ${cases.filter((c: any) => c.status === 'failed').length} | ${cases.filter((c: any) => c.status === 'blocked').length} | ${(provider.error || provider.state || '').replace(/[|\r\n]/g, ' ')} |`);
  }
  if (report.error) lines.push('', `Erro geral: ${report.error}`);
  for (const provider of report.providers) {
    lines.push('', `## ${provider.provider}`, '');
    for (const test of provider.cases || []) lines.push(`- ${test.model} / ${test.name}: **${test.status}**${test.error ? ' — ' + test.error.replace(/[\r\n]/g, ' ') : ''}`);
  }
  await writeFile(output + '.md', lines.join('\n') + '\n');
}

class CallError extends Error {
  constructor(message: string, public http: number, public code: string, public evidence: any) { super(message); }
}
async function completion(body: any) {
  const started = Date.now();
  const serialized = serializeOpenAIMessages(body.messages);
  const evidence: any = { request: body, expectedSerialization: {
    prompt: serialized.prompt, systemPrompt: appendToolInstructions(serialized.systemPrompt, body),
  } };
  const response = await fetch(base + '/chat/completions', { method: 'POST', headers: {
    Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  evidence.http = response.status;
  evidence.contentType = response.headers.get('content-type');
  evidence.retryAfter = response.headers.get('retry-after');
  const raw = await response.text();
  evidence.elapsedMs = Date.now() - started;
  if (!response.ok) {
    let error: any;
    try { error = JSON.parse(raw).error; } catch { /* Non-JSON upstream error. */ }
    evidence.response = error || raw.slice(0, 2000);
    throw new CallError(`HTTP ${response.status}: ${error?.message || raw.slice(0, 300)}`, response.status, error?.code || error?.type || '', evidence);
  }
  let content = '', calls: any[] = [], finishReason = '', done = false;
  if (!body.stream) {
    evidence.response = JSON.parse(raw);
    const choice = evidence.response.choices?.[0];
    content = choice?.message?.content || '';
    calls = choice?.message?.tool_calls || [];
    finishReason = choice?.finish_reason;
  } else {
    assert.match(evidence.contentType || '', /text\/event-stream/);
    const parts = new Map<number, any>();
    evidence.events = [];
    for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (data.trim() === '[DONE]') { done = true; continue; }
      const event = JSON.parse(data);
      evidence.events.push(event);
      if (event.error) throw new CallError(event.error.message || 'SSE error', response.status, event.error.code || event.error.type || '', evidence);
      for (const choice of event.choices || []) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        content += choice.delta?.content || '';
        for (const delta of choice.delta?.tool_calls || []) {
          const call = parts.get(delta.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.function.name += delta.function.name;
          if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
          parts.set(delta.index, call);
        }
      }
    }
    calls = [...parts.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  }
  return { evidence, content, calls, finishReason, done };
}

const fixturePath = 'ide-protocol-fixture.txt';
const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read the test fixture from the IDE client.', parameters: {
    type: 'object', properties: { path: { type: 'string', enum: [fixturePath] } }, required: ['path'], additionalProperties: false,
  } } },
  { type: 'function', function: { name: 'echo_text', description: 'Return the given text from the IDE client.', parameters: {
    type: 'object', properties: { text: { type: 'string', enum: ['ECHO_OK'] } }, required: ['text'], additionalProperties: false,
  } } },
];
const names = (process.env.DSP_TEST_CASES || 'text,auto,required,forced,multiple,none').split(',');
assert.ok(names.every(name => ['text', 'auto', 'required', 'forced', 'multiple', 'none'].includes(name)), 'Unknown test case');
const blocked = (error: unknown) => error instanceof CallError && (
  [401, 403, 409, 429, 503].includes(error.http) || /login|auth|suspend|rate_limit|challenge|captcha|capacity|browser_unavailable/.test(error.code));

async function scenario(provider: any, model: string, stream: boolean, name: string) {
  const test: any = { model, name: `${name}/${stream ? 'stream' : 'json'}`, status: 'running', calls: [] };
  provider.cases.push(test); await save();
  const capability = provider.capabilities?.find((m: any) => m.id === model);
  if (capability && name !== 'text' && (!capability.supported_parameters.includes('tools') ||
      (name !== 'auto' && !capability.supported_parameters.includes('tool_choice')))) {
    test.status = 'unsupported'; test.error = 'Recurso não anunciado no catálogo do modelo.';
    await save(); return '';
  }
  let fatal = '';
  try {
    const system = 'You are an IDE coding agent. Follow the requested output exactly. The IDE client executes tools; wait for its result before reporting file contents. Never guess file contents.';
    let prompt = '', choice: any;
    const expected = 'TESTE_PROXY_OK';
    if (name === 'text' || name === 'none') { prompt = `Responda apenas: ${expected}`; if (name === 'none') choice = 'none'; }
    if (name === 'auto' || name === 'required' || name === 'forced') {
      prompt = `Use read_file to read ${fixturePath}. After the client returns its result, respond only with the exact value of IDE_PROTOCOL_VALUE.`;
      choice = name === 'auto' ? 'auto' : name === 'required' ? 'required' : { type: 'function', function: { name: 'read_file' } };
    }
    if (name === 'multiple') { prompt = `Call both tools in this response: read_file with path ${fixturePath}, and echo_text with text ECHO_OK. Wait for the client results. After the client returns both results, respond only with the exact value of IDE_PROTOCOL_VALUE.`; choice = 'required'; }
    const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
    const body: any = { model, messages, stream, ...(name === 'text' ? {} : { tools, tool_choice: choice }) };
    if (name === 'auto' && capability && !capability.supported_parameters.includes('tool_choice')) delete body.tool_choice;
    const result = await completion(body); test.calls.push(result.evidence);
    if (stream) assert.equal(result.done, true, 'SSE missing [DONE]');
    assert.doesNotMatch(result.content, /DSML|<\/?tool_call/, 'Internal tool markers leaked into content');
    if (name === 'text' || name === 'none') {
      assert.equal(result.calls.length, 0); assert.equal(result.finishReason, 'stop'); assert.equal(result.content.trim(), expected);
    } else {
      assert.equal(result.finishReason, 'tool_calls');
      assert.equal(result.calls.length, name === 'multiple' ? 2 : 1);
      assert.equal(new Set(result.calls.map(c => c.id)).size, result.calls.length);
      assert.deepEqual(result.calls.map(c => c.function.name).sort(), name === 'multiple' ? ['echo_text', 'read_file'] : ['read_file']);
      const value = 'fixture-' + randomBytes(8).toString('hex');
      const results: any[] = [];
      for (const call of result.calls) {
        assert.ok(call.id && call.type === 'function');
        const args = JSON.parse(call.function.arguments);
        if (call.function.name === 'read_file') {
          assert.deepEqual(args, { path: fixturePath });
          // Only a controlled in-memory fixture is read; no model-generated paths are accessed.
          results.push({ role: 'tool', tool_call_id: call.id, content: `IDE_PROTOCOL_VALUE=${value}\n` });
        } else { assert.deepEqual(args, { text: 'ECHO_OK' }); results.push({ role: 'tool', tool_call_id: call.id, content: args.text }); }
      }
      test.clientExecuted = results.map((r, i) => ({ name: result.calls[i].function.name, tool_call_id: r.tool_call_id, result: r.content }));
      // Required calls exercise the full history round trip in both response modes.
      if (['auto', 'required', 'forced', 'multiple'].includes(name)) {
        const assistant = !stream && result.evidence.response?.choices?.[0]?.message || { role: 'assistant', content: result.content || null, tool_calls: result.calls };
        const continuation: any = { model, messages: [...messages, assistant, ...results], tools, tool_choice: 'none', stream };
        if (capability && !capability.supported_parameters.includes('tool_choice')) { delete continuation.tool_choice; delete continuation.tools; }
        const final = await completion(continuation); test.calls.push(final.evidence);
        assert.equal(final.content.trim(), value); assert.equal(final.finishReason, 'stop'); assert.equal(final.calls.length, 0);
        if (stream) assert.equal(final.done, true);
      }
    }
    test.status = 'passed';
  } catch (error) {
    test.status = blocked(error) ? 'blocked' : 'failed';
    test.error = error instanceof Error ? error.message : String(error);
    if (error instanceof CallError) {
      test.calls.push(error.evidence); test.code = error.code;
      if (blocked(error)) fatal = test.error;
      if (error.http === 400 && /model|mode|select/i.test(error.message)) fatal = 'MODEL: ' + test.error;
      // Repeating an unavailable composer cannot exercise another tool schema.
      const transport = error.http >= 500 && error.code !== 'invalid_tool_call';
      const recent = provider.cases.filter((c: any) => c.model === model && ['passed', 'failed'].includes(c.status)).slice(-2);
      if (!continueOn502 && transport && recent.length === 2 && recent.every((c: any) => c.status === 'failed' && c.code === error.code))
        fatal = (/interaction failed|browser unavailable|supported conversation request/i.test(error.message) ? '' : 'MODEL: ') + 'Falha repetida no transporte do site: ' + test.error;
    } else if (error instanceof Error && /timeout|aborted/i.test(error.message) &&
      provider.cases.filter((c: any) => c.model === model && ['passed', 'failed'].includes(c.status)).slice(-2).length === 2 &&
      provider.cases.filter((c: any) => c.model === model && ['passed', 'failed'].includes(c.status)).slice(-2).every((c: any) => c.status === 'failed' && /timeout|aborted/i.test(c.error || ''))) {
      fatal = 'MODEL: Timeout repetido no transporte do site: ' + test.error;
    }
  }
  log(`${provider.provider} ${model} ${test.name}: ${test.status}${test.error ? ' ' + test.error : ''}`);
  await save(); return fatal;
}

// Refuse stale resumes before entering the report-writing/cleanup block.
{
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'package.json', 'package-lock.json'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update(await readFile(file)); }
  const fingerprint = hash.digest('hex');
  if (process.env.DSP_TEST_RESUME === '1') assert.equal(report.fingerprint, fingerprint, 'Code changed or legacy report: start a new report instead of reusing stale approvals');
  report.fingerprint = fingerprint;
  report.revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  report.runtime = { node: process.version, base };
  try { report.runtime.images = execFileSync('docker', ['ps', '--format', '{{.Names}} {{.Image}}'], { encoding: 'utf8' }).trim().split(/\r?\n/); } catch { /* Docker is optional for an externally started lab. */ }
}
try {
  await authenticatePanel();
  if (!key) {
    const created = await panel('/api/me/keys', { name: 'Teste completo de provedores ' + new Date().toISOString() });
    key = created.key; temporaryKeyId = created.id; report.temporaryKeyCreated = true;
    report.temporaryKeyId = temporaryKeyId;
  }
  const accounts = (await panel('/api/me/accounts')).accounts;
  for (const id of ['deepseek','qwen','chatgpt','claude','perplexity','cohere','ernie','gemini','copilot','kimi','mistral','quillbot','meta','grok']) {
    if (!accounts.some((a: any) => a.provider === id)) accounts.push({ provider: id, missingAccount: true });
  }
  const credentials = await panel('/api/me/provider-credentials');
  for (const id of ['nvidia', 'openrouter']) {
    const configured = credentials.credentials.some((entry: any) => entry.provider === id);
    accounts.push({ provider: id, official: true, configured });
  }
  const catalogResponse = await fetch(base + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  assert.equal(catalogResponse.status, 200);
  const currentCatalog = await catalogResponse.json();
  report.initialCatalog ||= currentCatalog;
  report.catalogSnapshots ||= [];
  report.catalogSnapshots.push({ timestamp: new Date().toISOString(), catalog: currentCatalog });
  for (const account of accounts) {
    if (selected && !selected.includes(account.provider)) continue;
    if (!retryBlocked && report.providers.some((p: any) => p.provider === account.provider && p.finishedAt &&
      (p.error || p.models.filter((m: string) => !selectedModels || selectedModels.includes(m)).every((m: string) =>
        responseModes.every(stream => names.every(name => p.cases.some((c: any) => c.model === m && c.name === `${name}/${stream ? 'stream' : 'json'}` && c.status !== 'running'))))))) continue;
    const previous = report.providers.find((p: any) => p.provider === account.provider);
    const provider: any = previous || { provider: account.provider, initialState: account.accountState, models: account.models || [], cases: [] };
    provider.previousCases ||= [];
    provider.previousCases.push(...provider.cases.filter((c: any) => c.status === 'running').map((c: any) => ({ ...c, status: 'cancelled', error: 'Interrupted run; response was not evaluated.' })));
    provider.cases = provider.cases.filter((c: any) => c.status !== 'running');
    if (!previous) report.providers.push(provider);
    log(`Preparing ${account.provider}`); await save();
    try {
      if (account.missingAccount) throw new Error('Conta não configurada no laboratório.');
      if (account.official) {
        if (!account.configured) throw new Error('Credencial não configurada.');
        const catalog = await panel(`/api/me/provider-credentials/${account.provider}/models`, {});
        provider.state = 'authenticated'; provider.models = catalog.models.map((m: any) => m.id);
        provider.capabilities = catalog.models;
      } else {
      if (account.loginActive || account.busy) throw new Error('Conta ocupada ou login em andamento; sessão preservada.');
      const operation = await panel(`/api/me/accounts/${account.provider}/connection/recover`, {});
      const deadline = Date.now() + 240_000;
      while (true) {
        const state = await panel('/api/me/operations/' + operation.operationId);
        if (state.status === 'failed') throw new Error(state.error);
        if (state.status === 'done') break;
        if (Date.now() > deadline) throw new Error('Worker startup exceeded 240 seconds');
        await wait(2000);
      }
      const status = await panel(`/api/me/accounts/${account.provider}/status`);
      provider.state = status.accountState; provider.models = status.models || [];
      provider.liveStatus = status;
      }
      log(`${account.provider}: state=${provider.state}, models=${provider.models.join(',') || '(none)'}`);
      let blocker = provider.state === 'authenticated' ? '' : `Sessão indisponível: ${provider.state}`;
      if (!provider.models.length) throw new Error(blocker || 'Nenhum modelo anunciado para esta conta.');
      for (const model of provider.models.filter((id: string) => !selectedModels || selectedModels.includes(id))) {
       let modelBlocker = provider.cases.find((c: any) => c.model === model && c.status === 'failed' && c.calls?.some((call: any) => call.http === 400) && /model|mode|select/i.test(c.error || ''))?.error || '';
       for (const stream of responseModes) for (const name of names) {
        const existingIndex = provider.cases.findIndex((c: any) => c.model === model && c.name === `${name}/${stream ? 'stream' : 'json'}`);
        if (existingIndex !== -1) {
          if (!retryBlocked || provider.cases[existingIndex].status !== 'blocked') continue;
          provider.previousCases ||= [];
          provider.previousCases.push(...provider.cases.splice(existingIndex, 1));
        }
        if (blocker || modelBlocker) { provider.cases.push({ model, name: `${name}/${stream ? 'stream' : 'json'}`, status: 'blocked', error: blocker || modelBlocker, attempted: false }); continue; }
        const failure = await scenario(provider, model, stream, name);
        if (failure.startsWith('MODEL: ')) modelBlocker = failure.slice(7);
        else blocker = failure;
       }
      }
    } catch (error) { provider.error = error instanceof Error ? error.message : String(error); log(`${account.provider}: ${provider.error}`); }
    finally {
      if (!account.missingAccount && !account.official && !account.loginActive && !account.busy) {
        try { provider.browserReleased = (await panel(`/api/me/accounts/${account.provider}/connection/sleep`, {})).released; }
        catch (error) { provider.cleanupError = error instanceof Error ? error.message : String(error); }
      }
      provider.finishedAt = new Date().toISOString(); await save();
    }
  }
} catch (error) { report.error = error instanceof Error ? error.message : String(error); log(report.error); }
finally {
  if (temporaryKeyId && process.env.DSP_TEST_KEEP_KEY !== '1') {
    try { await panel('/api/me/keys/' + temporaryKeyId, undefined, 'DELETE'); report.temporaryKeyRevoked = true; }
    catch (error) { report.cleanupError = error instanceof Error ? error.message : String(error); }
  }
  if (temporaryKeyId && process.env.DSP_TEST_KEEP_KEY === '1') report.temporaryKeyCleanupPending = true;
  report.finishedAt = new Date().toISOString(); await save();
  const cases = report.providers.flatMap((p: any) => p.cases);
  const summary = { providers: report.providers.length, passed: cases.filter((c: any) => c.status === 'passed').length,
    failed: cases.filter((c: any) => c.status === 'failed').length, blocked: cases.filter((c: any) => c.status === 'blocked').length,
    unavailable: report.providers.filter((p: any) => p.error).length, error: report.error };
  log(JSON.stringify(summary));
  if (summary.failed || summary.blocked || summary.unavailable || summary.error) process.exitCode = 1;
}
