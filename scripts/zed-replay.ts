// Replays the real Zed Agent protocol against the gateway, one model at a time.
// The system prompt, the 16 tool definitions and the request parameters come from a private
// capture of a real Zed session (.cache/zed-agent-validation/http-evidence.json); the agent loop
// executes the tool calls locally, confined to a disposable workspace, and formats the results
// the way Zed does. Credentials stay in memory; transcripts stay in .cache/.
//
// Usage: npx tsx scripts/zed-replay.ts <model> [<model> ...]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const origin = process.env.DSP_LAB_ORIGIN || 'http://localhost:3440';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Replay only targets the local lab');
const capturePath = process.env.DSP_ZED_CAPTURE || '.cache/zed-agent-validation/http-evidence.json';
const outputDir = '.cache/zed-replay';
const maxTurns = Number(process.env.DSP_REPLAY_TURNS || 25);
const timeout = Number(process.env.DSP_TEST_TIMEOUT_MS || 240_000);
const official = new Set(['nvidia', 'openrouter']);
const blockedHttp = [401, 403, 409, 429, 503];
const models = process.argv.slice(2);
if (!models.length) throw new Error('Usage: tsx scripts/zed-replay.ts <model> [<model> ...]');

const load = async (path: string) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- Captured Zed request -------------------------------------------------------------------
const capture = await load(capturePath);
const template = capture.requests.find((r: any) => r.path === '/v1/chat/completions' && r.request?.tools?.length)?.request;
assert.ok(template, 'Capture has no Zed chat request with tools');
const capturedSystem: string = template.messages[0].content;
const capturedRoot = capturedSystem.match(/root directories:\s*- `([^`]+)`/)?.[1];
const capturedModelName = capturedSystem.match(/You are powered by the model named (.+?)\.\r?\n/)?.[1];
assert.ok(capturedRoot && capturedModelName, 'Capture system prompt layout not recognised');
const rootName = basename(capturedRoot.replace(/\\/g, '/'));

// --- Panel (temporary key, provider wake/sleep) ---------------------------------------------
const admin = await load('.cache/proxy-ia-live-admin.json');
const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(admin) });
assert.equal(login.status, 200, 'Local lab authentication failed');
const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json()).csrf;
async function panel(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  const json: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Panel ${path}: HTTP ${response.status}: ${json.error?.message || 'request failed'}`);
  return json;
}
async function wake(provider: string, model: string) {
  const operation = await panel(`/api/me/accounts/${provider}/connection/recover`, 'POST', {});
  const deadline = Date.now() + 240_000;
  while (true) {
    const state = await panel('/api/me/operations/' + operation.operationId);
    if (state.status === 'failed') throw new Error(state.error);
    if (state.status === 'done') break;
    if (Date.now() > deadline) throw new Error('Worker startup exceeded 240 seconds');
    await wait(2000);
  }
  // The catalog is filled after the page loads; sending earlier is rejected as an unknown model.
  const catalogDeadline = Date.now() + 90_000;
  while (true) {
    const status = await panel(`/api/me/accounts/${provider}/status`);
    if (status.accountState !== 'authenticated' || (status.models || []).includes(model) || Date.now() > catalogDeadline) return status;
    await wait(3000);
  }
}

// --- Workspace tools (Zed-compatible results, confined to the workspace root) ----------------
class Workspace {
  constructor(public root: string) {}
  resolve(input: unknown) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Path is required');
    let path = input.trim().replace(/\//g, sep).replace(/\\/g, sep);
    const prefix = rootName + sep;
    if (path === rootName) path = this.root;
    else if (path.startsWith(prefix)) path = join(this.root, path.slice(prefix.length));
    else if (path.toLowerCase().startsWith(capturedRoot!.replace(/\//g, sep).toLowerCase())) path = join(this.root, path.slice(capturedRoot!.length));
    else if (!isAbsolute(path)) path = join(this.root, path);
    const full = resolve(path), rel = relative(this.root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path ${input} is outside the project`);
    return full;
  }
  display(full: string) { return [rootName, ...relative(this.root, full).split(sep).filter(Boolean)].join('\\'); }
  async walk(dir = this.root, out: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await this.walk(full, out); else out.push(full);
    }
    return out;
  }
}

function shellWords(command: string) {
  // POSIX sh word splitting, as Zed's default shell on this machine ("sh") would do.
  const words: string[] = []; let word = '', inWord = false, quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else if (ch === '\\' && '$`"\\\n'.includes(command[i + 1] ?? '')) word += command[++i];
      else word += ch;
      continue;
    }
    if (/\s/.test(ch)) { if (inWord) words.push(word); word = ''; inWord = false; continue; }
    inWord = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') word += command[++i] ?? '';
    else word += ch;
  }
  if (quote) throw new Error('Unterminated quote');
  if (inWord) words.push(word);
  return words;
}

function runNode(args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ code: number; output: string }>(done => {
    execFile(process.execPath, args, { cwd, timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (error: any, stdout, stderr) => {
      const output = (String(stdout) + String(stderr)).trimEnd();
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output });
    });
  });
}

async function executeTool(ws: Workspace, name: string, args: any, trace: any) {
  switch (name) {
    case 'list_directory': {
      const dir = ws.resolve(args.path);
      const entries = await readdir(dir, { withFileTypes: true });
      const folders = entries.filter(e => e.isDirectory()).map(e => ws.display(join(dir, e.name)));
      const files = entries.filter(e => !e.isDirectory()).map(e => ws.display(join(dir, e.name)));
      return `${folders.length ? '# Folders:\n' + folders.join('\n') + '\n' : ''}${files.length ? (folders.length ? '\n' : '') + '# Files:\n' + files.join('\n') + '\n' : ''}` || `${args.path} is empty.\n`;
    }
    case 'read_file': {
      const lines = (await readFile(ws.resolve(args.path), 'utf8')).split('\n');
      const start = Math.max(1, Number(args.start_line) || 1), end = Math.min(lines.length, Number(args.end_line) || lines.length);
      return lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(6)}\t${line}`).join('\n') + '\n';
    }
    case 'create_directory': {
      const dir = ws.resolve(args.path); await mkdir(dir, { recursive: true });
      return `Created directory ${dir}`;
    }
    case 'write_file': {
      const file = ws.resolve(args.path);
      if (typeof args.content !== 'string') throw new Error('content must be a string');
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, args.content);
      trace.filesWritten.add(relative(ws.root, file).split(sep).join('/'));
      return `Edited ${file} successfully`;
    }
    case 'edit_file': {
      const file = ws.resolve(args.path);
      let edits = args.edits;
      if (typeof edits === 'string') { try { edits = JSON.parse(edits); } catch (e: any) { throw new Error(`${e.message}\nNo edits were made.`); } }
      if (!Array.isArray(edits)) throw new Error('edits must be an array\nNo edits were made.');
      let text = await readFile(file, 'utf8');
      for (const edit of edits) {
        if (text.includes(edit.old_text)) { text = text.replace(edit.old_text, edit.new_text); continue; }
        const loose = (s: string) => s.replace(/\s+/g, ' ').trim();
        const lines = text.split('\n'), wanted = loose(edit.old_text);
        let hit = -1, span = 0;
        for (let i = 0; i < lines.length && hit < 0; i++) for (let j = i; j < lines.length; j++) {
          const chunk = loose(lines.slice(i, j + 1).join('\n'));
          if (chunk === wanted) { hit = i; span = j - i + 1; break; }
          if (chunk.length > wanted.length) break;
        }
        if (hit < 0) throw new Error(`Could not find the text to replace in ${file}.\nNo edits were made.`);
        lines.splice(hit, span, edit.new_text); text = lines.join('\n');
      }
      await writeFile(file, text);
      trace.filesWritten.add(relative(ws.root, file).split(sep).join('/'));
      return `Edited ${file} successfully`;
    }
    case 'find_path': {
      const pattern = new RegExp('^' + String(args.glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\u0000/g, '.*') + '$', 'i');
      const hits = (await ws.walk()).map(f => [rootName, ...relative(ws.root, f).split(sep)].join('/')).filter(p => pattern.test(p) || pattern.test(p.slice(rootName.length + 1)) || pattern.test(basename(p)));
      return hits.length ? `Found ${hits.length} total matches.\n${hits.map(h => h.replace(/\//g, '\\')).join('\n')}` : 'No matches found';
    }
    case 'grep': {
      const regex = new RegExp(args.regex, args.case_sensitive ? '' : 'i'), out: string[] = [];
      for (const file of await ws.walk()) {
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, i) => { if (regex.test(line)) out.push(`## Matches in ${ws.display(file)}\n### L${i + 1}\n\`\`\`\n${line}\n\`\`\``); });
      }
      return out.length ? out.join('\n\n') : 'No matches found';
    }
    case 'terminal': {
      const command = String(args.command || '');
      const cwd = args.cd ? ws.resolve(args.cd) : ws.root;
      trace.commands.push(command);
      let words: string[];
      try { words = shellWords(command); } catch (e: any) { return `Command "${command}" failed with exit code 2.\n\n\`\`\`\nsh: ${e.message}\n\`\`\``; }
      if (/[;&|<>`]|\$\(/.test(command) || words[0] !== 'node')
        return `Command "${command}" failed with exit code 127.\n\n\`\`\`\nThis validation workspace only allows \`node\` commands.\n\`\`\``;
      // Any path argument must stay inside the workspace.
      for (const word of words.slice(1)) if (!word.startsWith('-') && /[\\/]|\.m?js$/.test(word)) {
        try { ws.resolve(isAbsolute(word) ? word : join(cwd, word)); } catch { return `Command "${command}" failed with exit code 1.\n\n\`\`\`\nPath outside the project: ${word}\n\`\`\``; }
      }
      const result = await runNode(words.slice(1), cwd, Math.min(Number(args.timeout_ms) || 60_000, 120_000));
      // `node --test x` and `node x.test.mjs` both run node:test suites and print the same summary.
      if (words.includes('--test') || /ℹ tests \d+/.test(result.output))
        trace.testRuns.push({ code: result.code, pass: Number(result.output.match(/ℹ pass (\d+)/)?.[1] || 0), fail: Number(result.output.match(/ℹ fail (\d+)/)?.[1] || 0) });
      return result.code === 0 ? `\`\`\`\n${result.output}\n\`\`\`` : `Command "${command}" failed with exit code ${result.code}.\n\n\`\`\`\n${result.output}\n\`\`\``;
    }
    default:
      throw new Error(`Tool ${name} is not available in this validation workspace.`);
  }
}

// --- Gateway call with Zed-style SSE accumulation --------------------------------------------
class CallError extends Error { constructor(message: string, public http: number) { super(message); } }
async function call(key: string, body: any) {
  const started = Date.now();
  const response = await fetch(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const raw = await response.text();
  const evidence: any = { http: response.status, elapsedMs: Date.now() - started, contentType: response.headers.get('content-type') };
  if (!response.ok) {
    let message = raw.slice(0, 300); try { message = JSON.parse(raw).error?.message || message; } catch { /* non-JSON */ }
    throw Object.assign(new CallError(`HTTP ${response.status}: ${message}`, response.status), { evidence });
  }
  let content = '', finishReason = '', done = false;
  const parts = new Map<number, any>();
  for (const block of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data.trim() === '[DONE]') { done = true; continue; }
    const event = JSON.parse(data);
    if (event.error) throw Object.assign(new CallError(event.error.message || 'SSE error', response.status), { evidence });
    for (const choice of event.choices || []) {
      if (choice.finish_reason) finishReason = choice.finish_reason;
      content += choice.delta?.content || '';
      for (const delta of choice.delta?.tool_calls || []) {
        const c = parts.get(delta.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (delta.id) c.id = delta.id;
        if (delta.function?.name) c.function.name += delta.function.name;
        if (delta.function?.arguments) c.function.arguments += delta.function.arguments;
        parts.set(delta.index, c);
      }
    }
  }
  const calls = [...parts.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
  Object.assign(evidence, { done, finishReason, toolCalls: calls.map(c => c.function.name), contentChars: content.length });
  return { content, calls, finishReason, done, evidence };
}

// --- Run --------------------------------------------------------------------------------------
await mkdir(outputDir, { recursive: true });
const summaryPath = join(outputDir, 'summary.json');
const summary: any = await load(summaryPath).catch(() => ({ results: [] }));
const temporary = await panel('/api/me/keys', 'POST', { name: 'Temporary Zed protocol replay' });
let revoked = false;
const revoke = async () => {
  if (revoked) return; revoked = true;
  try { await panel('/api/me/keys/' + temporary.id, 'DELETE'); } catch { console.error('Revoke the temporary replay key through the local panel'); }
};
process.on('SIGINT', () => { void revoke().then(() => process.exit(130)); });

try {
  for (const model of models) {
    const provider = model.startsWith('deepseek-') ? 'deepseek' : model.split('/')[0];
    const slug = model.replace(/[^a-z0-9.-]+/gi, '_');
    const base = resolve(outputDir, slug), root = join(base, rootName);
    await rm(base, { recursive: true, force: true }); await mkdir(root, { recursive: true });
    await writeFile(join(root, 'README.md'), 'Disposable integration test workspace. Only edit files inside this folder.\n');
    const ws = new Workspace(root), folder = provider;
    const trace: any = { filesWritten: new Set<string>(), commands: [], testRuns: [] };
    const result: any = { model, provider, startedAt: new Date().toISOString(), status: 'running', turns: 0, http: [], finishReasons: [], toolCalls: {}, invalidArguments: 0, toolErrors: 0 };
    const transcript: any = { model, turns: [] };
    log(`Replaying Zed protocol with ${model}`);
    try {
      if (!official.has(provider)) {
        const status = await wake(provider, model);
        if (status.accountState !== 'authenticated') throw Object.assign(new CallError(`Sessão indisponível: ${status.accountState}`, 503), { evidence: {} });
        if (!(status.models || []).includes(model)) throw new Error(`Modelo não anunciado pela conta: ${(status.models || []).join(', ') || '(nenhum)'}`);
      }
      const system = capturedSystem.split(capturedRoot).join(root).split(capturedModelName).join(`Validation ${model}`);
      const prompt = `Integration validation in this disposable workspace only. Create ${folder}/sum.mjs exporting sum(a,b) returning a+b and ${folder}/sum.test.mjs using node:test and node:assert/strict with positive, negative and zero cases. Use your file tools to create the files, then run the tests using your execution tool and report the actual result. Do not merely print code or claim an action without a tool result. Stay inside this workspace; do not inspect parent folders or credentials.`;
      const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
      let final = '';
      for (let turn = 0; turn < maxTurns; turn++) {
        const body = { ...template, model, messages };
        delete body.prompt_cache_key;
        const reply = await call(temporary.key, body);
        result.turns++; result.http.push(reply.evidence.http); result.finishReasons.push(reply.finishReason);
        transcript.turns.push({ evidence: reply.evidence, content: reply.content, calls: reply.calls });
        assert.equal(reply.done, true, 'SSE missing [DONE]');
        assert.doesNotMatch(reply.content, /DSML|<\/?tool_call|<\/?function_calls/, 'Internal tool markers leaked into content');
        if (!reply.calls.length) {
          final = reply.content;
          assert.equal(reply.finishReason, 'stop', `Final turn finish_reason=${reply.finishReason}`);
          break;
        }
        assert.equal(reply.finishReason, 'tool_calls', `Tool turn finish_reason=${reply.finishReason}`);
        messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.calls });
        for (const c of reply.calls) {
          result.toolCalls[c.function.name] = (result.toolCalls[c.function.name] || 0) + 1;
          let output: string;
          try {
            let args: any;
            try { args = JSON.parse(c.function.arguments || '{}'); } catch (e: any) { result.invalidArguments++; throw new Error(`Failed to parse tool input: ${e.message}`); }
            output = await executeTool(ws, c.function.name, args, trace);
          } catch (e: any) { result.toolErrors++; output = e.message; }
          transcript.turns.at(-1).results ||= [];
          transcript.turns.at(-1).results.push({ id: c.id, output: output.slice(0, 4000) });
          messages.push({ role: 'tool', content: output, tool_call_id: c.id });
        }
      }
      // Independent verification of what the agent claims.
      const files = [...trace.filesWritten];
      result.filesWritten = files;
      result.terminalCommands = trace.commands.length;
      result.agentTestRuns = trace.testRuns;
      result.testCommands = trace.testRuns.length;
      const testFile = join(root, folder, 'sum.test.mjs');
      const verify = await stat(testFile).then(() => runNode(['--test', testFile], root, 60_000), () => ({ code: -1, output: 'sum.test.mjs not created' }));
      result.independentTest = { code: verify.code, pass: Number(verify.output.match(/pass (\d+)/)?.[1] || 0), fail: Number(verify.output.match(/fail (\d+)/)?.[1] || 0) };
      result.finalChars = final.length;
      const problems: string[] = [];
      if (!final) problems.push(`no final answer within ${maxTurns} turns`);
      if (!files.includes(`${folder}/sum.mjs`) || !files.includes(`${folder}/sum.test.mjs`)) problems.push('files not created through tool calls');
      if (!result.testCommands) problems.push('tests not run through the terminal tool');
      if (verify.code !== 0 || !result.independentTest.pass) problems.push('independent node --test failed');
      result.status = problems.length ? 'failed' : 'passed';
      if (problems.length) result.reason = problems.join('; ');
    } catch (error: any) {
      result.status = error instanceof CallError && blockedHttp.includes(error.http) ? 'blocked' : 'failed';
      result.reason = error.message.split('\n')[0].slice(0, 300);
      if (error.evidence?.http) result.http.push(error.evidence.http);
    } finally {
      result.finishedAt = new Date().toISOString();
      result.elapsedMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
      if (!official.has(provider)) { try { await panel(`/api/me/accounts/${provider}/connection/sleep`, 'POST', {}); } catch { /* best effort */ } }
      await writeFile(join(outputDir, slug + '.json'), JSON.stringify({ ...transcript, result }, null, 2) + '\n');
      summary.results = summary.results.filter((r: any) => r.model !== model).concat(result);
      summary.updatedAt = new Date().toISOString();
      await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n');
      log(`${model}: ${result.status}${result.reason ? ' — ' + result.reason : ''} (turns=${result.turns}, tools=${JSON.stringify(result.toolCalls)})`);
    }
  }
} finally { await revoke(); }
