import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Route } from 'playwright';
import { cohereError, cohereModels, parseCohereStream } from './providers/cohere-protocol.ts';
import { installCohereCapture } from './providers/cohere-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { CohereProvider, COHERE_CHAT_URL } from './providers/cohere.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Event shapes follow the documented Cohere chat streams (v2 SSE and v1 NDJSON).
// The authenticated playground traffic itself was not observable without an account.
const sse = (value: any) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const delta = (text: string) => ({ type: 'content-delta', index: 0, delta: { message: { content: { text } } } });
const end = (finish_reason = 'COMPLETE', output_tokens = 7) => ({ type: 'message-end', delta: { finish_reason, usage: { tokens: { input_tokens: 3, output_tokens } } } });
const v2 = (...texts: string[]) => sse({ type: 'message-start', id: 'fixture', delta: { message: { role: 'assistant' } } }) +
  sse({ type: 'content-start', index: 0, delta: { message: { content: { type: 'text', text: '' } } } }) +
  texts.map(t => sse(delta(t))).join('') + sse({ type: 'content-end', index: 0 }) + sse(end());
const ndjson = (...values: any[]) => values.map(v => JSON.stringify(v) + '\n').join('');
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };

test('Cohere routing, catalog and error mapping do not invent models or suspensions', () => {
  assert.equal(providerId('cohere'), 'cohere'); assert.equal(providerIdForModel('cohere/auto'), 'cohere');
  assert.equal(providerIdForModel('command-a-03-2025'), null);
  assert.deepEqual(cohereModels({ models: [
    { name: 'command-a-03-2025', endpoints: ['generate', 'chat'], context_length: 256000 },
    { name: 'embed-english-v3.0', endpoints: ['embed'] },
    { name: 'command-old', endpoints: ['chat'], is_deprecated: true },
    { name: 'bad name', endpoints: ['chat'] },
  ] }), [{ id: 'cohere/command-a-03-2025', label: 'command-a-03-2025', contextLength: 0 }]);
  assert.deepEqual(cohereModels({ data: [] }), []);
  const args = interactiveWorkerArguments('/profile', COHERE_CHAT_URL);
  assert.equal(args.at(-1), 'https://dashboard.cohere.com/playground/chat'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(cohereError(403).status, 403); assert.doesNotMatch(cohereError(403).message, /suspended|login/);
  assert.match(cohereError(403, 'organization_disabled').message, /account is suspended/);
  assert.equal(cohereError(401).status, 401); assert.equal(cohereError(502, 'too_many_requests').status, 429);
});

test('Cohere v2 SSE: CRLF, split Unicode, thinking ignored, usage and a single finish', async () => {
  const thinking = sse({ type: 'content-delta', index: 0, delta: { message: { content: { thinking: 'private' } } } });
  const input = (thinking + v2('Olá ', 'mundo ✓\n```ts\nx()\n```')).replace(/\n/g, '\r\n');
  const values = await collect(parseCohereStream(chunks(input)));
  assert.equal(values.filter(v => v.type === 'content').map(v => v.text).join(''), 'Olá mundo ✓\n```ts\nx()\n```');
  assert.deepEqual(values.slice(-2), [{ type: 'usage', completionTokens: 7 }, { type: 'finish' }]);
  assert.ok(!values.some(v => v.text === 'private'));
});

test('Cohere v1 NDJSON: text-generation deltas and stream-end', async () => {
  const input = ndjson({ is_finished: false, event_type: 'stream-start', generation_id: 'g' },
    { is_finished: false, event_type: 'text-generation', text: 'ha' }, { is_finished: false, event_type: 'text-generation', text: 'ha' },
    { is_finished: true, event_type: 'stream-end', finish_reason: 'COMPLETE', response: { text: 'haha', meta: { billed_units: { output_tokens: 2 } } } },
    { event_type: 'text-generation', text: 'ignored after end' });
  const values = await collect(parseCohereStream(chunks(input, 5)));
  assert.deepEqual(values, [{ type: 'content', text: 'ha' }, { type: 'content', text: 'ha' }, { type: 'usage', completionTokens: 2 }, { type: 'finish' }]);
});

test('Cohere decoding fails explicitly on malformed, truncated, empty and failed streams', async () => {
  for (const input of ['data: nope\n', sse(delta('unfinished')), sse(end()), v2('x').replace('COMPLETE', 'ERROR'),
    ndjson({ event_type: 'text-generation', text: 'x' }, { event_type: 'stream-end', finish_reason: 'ERROR_TOXIC' }), 'null\n']) {
    await assert.rejects(() => collect(parseCohereStream(chunks(input))), UpstreamError);
  }
  await assert.rejects(() => collect(parseCohereStream(chunks(sse({ type: 'error', status: 429 })))), (e: any) => e.status === 429);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseCohereStream(chunks(v2('text')), controller.signal)));
});

test('Cohere decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseCohereStream(chunks(v2(text.slice(0, 20), text.slice(20)))),
    'chatcmpl-fixture', 'cohere/auto', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Cohere browser capture ignores other requests, rejects stale history and model mismatch, cancels the real request', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://dashboard.cohere.com/**', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto(COHERE_CHAT_URL);
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('event: message-end\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await page.evaluate(installCohereCapture);
    // Built in Node: named helpers inside page functions would reference tsx's __name.
    const request = (messages: any[]) => ({ method: 'POST', body: JSON.stringify({ model: 'command-a-03-2025', stream: true, messages }) });
    const requests = {
      other: request([{ role: 'user', content: 'other prompt' }]), embed: request([{ role: 'user', content: 'hello world' }]),
      matching: request([{ role: 'system', content: 'rules' }, { role: 'user', content: [{ type: 'text', text: 'hello\nworld' }] }]),
      stale: request([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'hello' }]),
    };
    const result = await page.evaluate(async requests => {
      const scope = globalThis as any;
      scope.__proxyCohere = { prompt: 'hello  world', model: 'auto', chunks: [], bytes: 0, done: false };
      await fetch('https://api.cohere.com/v2/chat', requests.other);
      await fetch('https://api.cohere.com/v2/embed', requests.embed);
      await fetch('https://api.cohere.com/v2/chat', { method: 'GET' });
      const afterOthers = !!scope.__proxyCohere.claimed;
      const response = await fetch('https://api.cohere.com/v2/chat', requests.matching);
      const reader = response.body!.getReader(); const first = await reader.read();
      scope.__proxyCohere.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyCohere.chunks.join('');
      scope.__proxyCohere = { prompt: 'hello', model: 'command-r7b', chunks: [], bytes: 0, done: false };
      try { await fetch('https://api.cohere.com/v1/chat', { method: 'POST', body: JSON.stringify({ model: 'command-a-03-2025', message: 'hello' }) }); } catch { /* expected */ }
      const mismatch = scope.__proxyCohere.error;
      scope.__proxyCohere = { prompt: 'hello', model: 'auto', chunks: [], bytes: 0, done: false };
      try { await fetch('https://api.cohere.com/v2/chat', requests.stale); } catch { /* expected */ }
      return { afterOthers, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted,
        mismatch, stale: scope.__proxyCohere.error, calls: scope.originalCalls.length };
    }, requests);
    assert.equal(result.afterOthers, false); assert.equal(result.first, 'event: message-end\n');
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.stale, 'stale_history');
    assert.equal(result.calls, 4, 'mismatched or stale requests never reach the network');
    assert.equal(result.captured, 'event: message-end\n');
  } finally { await browser.close(); }
});

const cors = { 'access-control-allow-origin': 'https://dashboard.cohere.com', 'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  // Retry-After is readable cross-origin only when exposed; otherwise the 60 s minimum applies.
  'access-control-expose-headers': 'retry-after' };
const preflight = (route: Route) => route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors }).then(() => true) : Promise.resolve(false);

/** Simulated playground: a system field that must never be filled, the message field, model menu and send button. */
const playground = `<label>System<textarea placeholder="System message (optional)"></textarea></label>
  <button aria-label="Select model" id="model">command-a-03-2025</button>
  <div role="listbox" id="menu" hidden><div role="option">command-a-03-2025</div><div role="option">command-r7b</div></div>
  <textarea placeholder="Message..." aria-label="Message"></textarea><button aria-label="Send message">Send</button>
  <script>
  if (!document.cookie.includes('access_token=') && document.cookie.includes('refresh_token=')) document.cookie = 'access_token=fixture; path=/';
  const model = document.getElementById('model'), menu = document.getElementById('menu');
  model.onclick = () => { menu.hidden = false; };
  for (const option of menu.children) option.onclick = () => { model.textContent = option.textContent; menu.hidden = true; };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.hidden = true; });
  document.querySelector('[aria-label="Send message"]').onclick = async () => {
    const [system, message] = document.querySelectorAll('textarea');
    const response = await fetch('https://api.cohere.com/v2/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.textContent, stream: true, messages: [{ role: 'system', content: system.value }, { role: 'user', content: message.value }] }) });
    await response.text();
  };
  </script>`;

test('Cohere playground fixture: session RPC, generation, model selection, quota, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cohere-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'cohere';
  const browser = await chromium.launch();
  const provider = getProvider() as CohereProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installCohereCapture);
    const page = await context.newPage();
    let sessionValid = true, quota = false;
    const prompts: string[] = [], models: string[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://production.api.os.cohere.com/**', async route => {
      if (await preflight(route)) return;
      const valid = sessionValid && route.request().headers().authorization === 'Bearer fixture';
      return route.fulfill({ status: valid ? 200 : 401, headers: cors, json: valid ? { user: { id: 'fixture', organization: {} } } : { message: 'unauthorized' } });
    });
    await page.route('https://api.cohere.com/**', async route => {
      if (await preflight(route)) return;
      const body = route.request().postDataJSON();
      prompts.push(body.messages.at(-1).content); models.push(body.model);
      return route.fulfill(quota ? { status: 429, headers: { ...cors, 'retry-after': '120' }, json: { message: 'trial key limit' } } :
        { headers: { ...cors, 'content-type': 'text/event-stream' }, body: v2('Olá ', 'do fixture') });
    });
    await page.route('https://dashboard.cohere.com/**', route => route.fulfill({ contentType: 'text/html', body: playground }));
    await context.addCookies([{ name: 'access_token', value: 'fixture', url: 'https://dashboard.cohere.com' },
      { name: 'refresh_token', value: 'fixture-refresh', url: 'https://dashboard.cohere.com' }]);
    await page.goto(COHERE_CHAT_URL);
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'cohere/auto', contextLength: 0 }], 'no catalog observed: only the site default');
    const result = await collect(await provider.generate('Teste', 'cohere/auto', false));
    assert.equal(result.filter(v => v.type === 'content').map(v => v.text).join(''), 'Olá do fixture');
    assert.equal(guard.status().busy, false); assert.equal(prompts.at(-1), 'Teste');
    assert.equal(await page.locator('textarea').first().inputValue(), '', 'the system field is never filled');
    // Explicit models must be selectable in the menu and honored by the request.
    Object.assign(provider, { catalog: [{ id: 'cohere/command-r7b', label: 'command-r7b', contextLength: 0 },
      { id: 'cohere/locked', label: 'locked', contextLength: 0 }] });
    assert.deepEqual((await provider.models()).map(m => m.id), ['cohere/auto', 'cohere/command-r7b']);
    await collect(await provider.generate('Modelo específico', 'cohere/command-r7b', false));
    assert.equal(models.at(-1), 'command-r7b');
    await assert.rejects(() => provider.generate('x', 'cohere/locked', false), (e: any) => e.status === 400);
    assert.equal(guard.status().busy, false);
    // An expired access cookie is renewed once by the dashboard when a refresh cookie exists.
    await context.clearCookies({ name: 'access_token' });
    Object.assign(provider, { checkedAt: null });
    assert.equal((await provider.status()).state, 'authenticated');
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const catalog = await (await app.request('/v1/models', { headers })).json();
    assert.ok(catalog.data.some((m: any) => m.id === 'cohere/auto'));
    assert.equal(catalog.data[0].context_limit_source, 'unknown'); assert.equal(catalog.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'cohere/auto', stream,
          tools: [{type:'function',function:{name:'lookup',description:'Read the requested information.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
          messages: [
          { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
          { role: 'user', content: 'Continue' },
        ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /do fixture/);
      assert.match(prompts.at(-1)!, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompts.at(-1)!, /Tools:.*"name":"lookup"/);
      assert.match(prompts.at(-1)!, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'cohere/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400);
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'cohere/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(async () => collect(await provider.generate('Teste', 'cohere/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    sessionValid = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Cohere login is required.', 401), 'cohere_login_required').error;
    assert.equal(error.help_url, COHERE_CHAT_URL); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Cohere early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cohere-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new CohereProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      // The login page has no access_token cookie; after login the dashboard sets it.
      if (authenticated) await context.addCookies([{ name: 'access_token', value: 'fixture', url: 'https://dashboard.cohere.com' }]);
      const page = await context.newPage();
      await page.route('https://production.api.os.cohere.com/**', async route => (await preflight(route)) ? undefined :
        route.fulfill({ headers: cors, json: { user: { id: 'fixture' } } }));
      await page.route('https://dashboard.cohere.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Playground</p>' }));
      await page.goto(COHERE_CHAT_URL);
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.confirmLogin(), /Concluir login/);
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    authenticated = true;
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true); assert.equal(status.authenticated, true);
    assert.equal(humanRunning, false);
    const page = provider.getActivePage(); await provider.initialize(false); assert.equal(provider.getActivePage(), page);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
