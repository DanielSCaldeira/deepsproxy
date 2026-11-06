import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { applyPerplexityPatch, parsePerplexityStream, perplexityError, perplexityModels } from './providers/perplexity-protocol.ts';
import { installPerplexityCapture } from './providers/perplexity-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { PerplexityProvider } from './providers/perplexity.ts';
import { getProvider } from './providers/registry.ts';
import { getProfileDirectory } from './services/session-store.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Shapes from the public /rest/models/config/v2 response and the pplx-stream bundle (2026-11-06).
const CONFIG = { config_schema: 'v2', default_models: { search: 'turbo' }, search_config: [
  { label: 'Best', non_reasoning_model: 'turbo', reasoning_model: null },
  { label: 'Claude Sonnet 5.5', non_reasoning_model: 'claude55sonnet', reasoning_model: 'claude55sonnetthinking' },
  { label: 'GPT-6 Astra', non_reasoning_model: 'gpt6_astra', reasoning_model: 'gpt6_astra_thinking' },
  { label: 'Claude Sonnet 5', non_reasoning_model: 'comet_browser_agent_sonnet', reasoning_model: null },
  { label: 'Broken', non_reasoning_model: '../x' },
] };
const message = (value: unknown) => `event: message\ndata: ${JSON.stringify(value)}\n\n`;
const endOfStream = (value: unknown = {}) => `event: end_of_stream\ndata: ${JSON.stringify(value)}\n\n`;
const markdown = (chunks: string[], extra: any = {}) => ({ status: 'PENDING', blocks: [{ intended_usage: 'ask_text',
  markdown_block: { chunks, answer: chunks.join(''), progress: 'IN_PROGRESS' } }], ...extra });
const diff = (patches: unknown[], extra: any = {}) => ({ status: 'PENDING', blocks: [{ intended_usage: 'ask_text',
  diff_block: { field: 'markdown_block', patches } }], ...extra });
const sources = { intended_usage: 'web_results', web_result_block: { web_results: [
  { name: 'Fonte A', url: 'https://a.example/x', snippet: 'ignored' }, { name: 'Fonte B', url: 'https://b.example/' },
  { name: 'Unsafe', url: 'javascript:alert(1)' }, { name: 'Duplicate', url: 'https://a.example/x' }] } };
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const text = (values: any[]) => values.filter(v => v.type === 'content').map(v => v.text).join('');

test('Perplexity catalog, routing, profile and errors do not invent models or diagnoses', () => {
  assert.equal(providerId('perplexity'), 'perplexity');
  assert.equal(providerIdForModel('perplexity/claude55sonnet'), 'perplexity');
  assert.equal(providerIdForModel('sonar-pro'), null);
  assert.deepEqual(perplexityModels(CONFIG).map(m => [m.id, m.label, m.contextLength]), [
    ['perplexity/turbo', 'Best', 0], ['perplexity/claude55sonnet', 'Claude Sonnet 5.5', 0], ['perplexity/gpt6_astra', 'GPT-6 Astra', 0]]);
  assert.deepEqual(perplexityModels({ models: {} }), []);
  const previous = process.env.PROVIDER, profile = process.env.PROVIDER_PROFILE_DIR;
  try {
    process.env.PROVIDER = 'perplexity'; delete process.env.PROVIDER_PROFILE_DIR;
    assert.equal(path.basename(getProfileDirectory()), path.basename(process.env.PERPLEXITY_PROFILE_DIR || 'perplexity_profile'));
    const error = apiError(new UpstreamError('Perplexity login is required.', 401), 'perplexity_login_required').error;
    assert.equal(error.help_url, 'https://www.perplexity.ai/');
    assert.match(error.user_action, /Perplexity.*código por e-mail, Google ou Apple/s); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previous;
    if (profile !== undefined) process.env.PROVIDER_PROFILE_DIR = profile;
  }
  assert.equal(perplexityError(403).status, 403); assert.doesNotMatch(perplexityError(403).message, /suspended|login/);
  assert.equal(perplexityError(403, undefined, true).status, 503);
  assert.match(perplexityError(403, undefined, true).message, /anti-bot/);
  assert.equal(perplexityError(429).status, 429);
  assert.equal(perplexityError(403, 'VIEWER_TIER_RESTRICTED').status, 400);
  assert.equal(perplexityError(401).status, 401);
});

test('Perplexity diff blocks apply JSON Patch, CRLF and split Unicode and append sources once', async () => {
  const stream = (message({ status: 'PENDING', blocks: [] }) +
    'event: ping\ndata: {}\n\n' + 'event: info\ndata: {"x":1}\n\n' +
    message(diff([{ op: 'add', path: '/chunks', value: [] }, { op: 'add', path: '/chunks/-', value: 'Olá ' }])) +
    message(diff([{ op: 'add', path: '/chunks/-', value: 'mundo [1]' }])) +
    message({ status: 'PENDING', blocks: [sources] }) +
    message(diff([{ op: 'add', path: '/chunks/-', value: '\n```ts\nx()\n```' }, { op: 'replace', path: '/progress', value: 'DONE' }],
      { status: 'COMPLETED', final: true })) + endOfStream()).replace(/\n/g, '\r\n');
  const values = await collect(parsePerplexityStream(chunks(stream, 3)));
  assert.equal(text(values), 'Olá mundo [1]\n```ts\nx()\n```\n\nFontes:\n[1] Fonte A - https://a.example/x\n[2] Fonte B - https://b.example/');
  assert.equal(values.filter(v => v.type === 'finish').length, 1);
  assert.equal(values.at(-1).type, 'finish');
});

test('Perplexity snapshots, structured usages, chunk windows and end_of_stream complete without duplication', async () => {
  const windowed = message(markdown(['a', 'b'])) +
    message({ status: 'PENDING', blocks: [{ intended_usage: 'ask_text', markdown_block: { chunks: ['c'], chunk_starting_offset: 2 } }] }) +
    message(markdown(['a', 'b', 'c', 'd'])) + endOfStream();
  assert.equal(text(await collect(parsePerplexityStream(chunks(windowed)))), 'abcd');
  const structured = message({ status: 'PENDING', structured_answer_block_usages: ['ask_text_0', 'ask_text_1'], blocks: [
    { intended_usage: 'ask_text_0', markdown_block: { answer: 'Primeiro' } },
    { intended_usage: 'ask_text_1', markdown_block: { chunks: ['Seg', 'undo'] } },
    { intended_usage: 'pro_search_steps', plan_block: { goals: [{ description: 'interno' }] } }] }) +
    endOfStream({ status: 'COMPLETED', final: true, blocks: [] });
  assert.equal(text(await collect(parsePerplexityStream(chunks(structured, 7)))), 'Primeiro\n\nSegundo');
  // A transient revision is not streamed; the consistent final snapshot continues the text.
  const transient = message(markdown(['abc'])) + message(markdown(['xbc'])) + message(markdown(['abcd'], { status: 'COMPLETED', final: true }));
  assert.equal(text(await collect(parsePerplexityStream(chunks(transient)))), 'abcd');
  const previous = process.env.PERPLEXITY_SOURCES; process.env.PERPLEXITY_SOURCES = 'none';
  try {
    const values = await collect(parsePerplexityStream(chunks(message({ ...markdown(['x']), blocks: [...markdown(['x']).blocks, sources] }) + endOfStream())));
    assert.equal(text(values), 'x');
  } finally { if (previous === undefined) delete process.env.PERPLEXITY_SOURCES; else process.env.PERPLEXITY_SOURCES = previous; }
});

test('Perplexity decoding fails explicitly on revisions, unsafe patches, failures, truncation and malformed data', async () => {
  for (const input of ['event: message\ndata: nope\n\n', message(markdown(['unfinished'])), endOfStream(),
    message(markdown(['abc'])) + message(markdown(['xyz'], { status: 'COMPLETED', final: true })),
    message(diff([{ op: 'add', path: '/__proto__/polluted', value: true }])),
    message(diff([{ op: 'unknown', path: '/x' }])),
    message({ status: 'FAILED', blocks: [] })]) {
    await assert.rejects(() => collect(parsePerplexityStream(chunks(input))), UpstreamError);
  }
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(applyPerplexityPatch({ a: [1, 2] }, [{ op: 'move', from: '/a/0', path: '/b' }, { op: 'copy', from: '/b', path: '/c' }, { op: 'remove', path: '/a' }]), { b: 1, c: 1 });
  await assert.rejects(() => collect(parsePerplexityStream(chunks(message({ status: 'FAILED', error_code: 'RATE_LIMITED' })))), (e: any) => e.status === 429);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parsePerplexityStream(chunks(message(markdown(['x']))), controller.signal)));
});

test('Perplexity tool calls use the shared OpenAI parser and omit the sources footer', async () => {
  const call = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const stream = message({ status: 'COMPLETED', final: true, blocks: [{ intended_usage: 'ask_text', markdown_block: { chunks: [call] } }, sources] });
  const values = await collect(parsePerplexityStream(chunks(stream)));
  assert.equal(text(values), call);
  const parsed = await parseProviderStreamToOpenAI(parsePerplexityStream(chunks(stream)), 'chatcmpl-fixture', 'perplexity/auto', 10,
    [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Perplexity browser capture ignores other requests and prompts, enforces model and cancels the real request', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://www.perplexity.ai/', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://www.perplexity.ai/');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('event: message\ndata: {}\n\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await page.evaluate(installPerplexityCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyPerplexity = { prompt: 'olá\n\nmundo', model: 'auto', chunks: [], bytes: 0, done: false };
      const request = [['olá mundo', 'turbo'], ['outra pergunta', 'turbo'], ['x', 'turbo']].map(([query, model]) =>
        ({ method: 'POST', body: JSON.stringify({ params: { model_preference: model }, query_str: query }) }));
      await fetch('/rest/sse/perplexity_clarifying_answer', request[0]);
      await fetch('/rest/sse/perplexity_ask', request[1]);
      const afterOthers = !!scope.__proxyPerplexity.claimed;
      const response = await fetch(new URL('/rest/sse/perplexity_ask?version=2.18', location.href), request[0]);
      const reader = response.body!.getReader(); const first = await reader.read();
      scope.__proxyPerplexity.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyPerplexity.chunks.join('');
      scope.__proxyPerplexity = { prompt: 'x', model: 'claude55sonnet', chunks: [], bytes: 0, done: false };
      try { await fetch('/rest/sse/perplexity_ask', request[2]); } catch { /* expected mismatch */ }
      return { afterOthers, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted,
        mismatch: scope.__proxyPerplexity.error, calls: scope.originalCalls.length };
    });
    assert.equal(result.afterOthers, false); assert.equal(result.first, 'event: message\ndata: {}\n\n');
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 3);
    assert.equal(result.captured, 'event: message\ndata: {}\n\n');
  } finally { await browser.close(); }
});

/** Composer modeled on the public capture: Lexical textbox without ID, Submit only after typing, Model menu. */
const COMPOSER = `<div contenteditable="true" role="textbox" aria-label="Ask anything…" data-lexical-editor="true"></div>
  <textarea hidden></textarea><button aria-label="Submit" hidden>Old</button>
  <button aria-haspopup="menu" aria-label="Model" type="button">Model</button>
  <button aria-label="Search sessions" type="button"></button>
  <script>
    let model = 'turbo';
    const editor = document.querySelector('[data-lexical-editor]');
    editor.onfocus = () => editor.setAttribute('aria-label', 'Type @ for connectors');
    editor.oninput = () => {
      if (document.querySelector('button[aria-label=Submit]:not([hidden])')) return;
      const send = document.createElement('button'); send.type = 'button'; send.setAttribute('aria-label', 'Submit'); send.textContent = '↑';
      send.onclick = async () => {
        const response = await fetch('/rest/sse/perplexity_ask?version=2.18&source=default', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ params: { model_preference: model, mode: 'copilot', use_schematized_api: true }, query_str: editor.innerText }) });
        history.pushState(null, '', '/search/fixture-slug');
        await response.text();
      };
      document.body.append(send);
    };
    document.querySelector('[aria-label=Model]').onclick = () => {
      const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
      for (const [label, id, badge, disabled] of [['Best', 'turbo'], ['Claude Sonnet 5.5', 'claude55sonnet'], ['GPT-6 Astra', 'gpt6_astra', 'Max', true]]) {
        const item = document.createElement('div'); item.setAttribute('role', 'menuitem');
        if (disabled) item.setAttribute('aria-disabled', 'true');
        item.innerHTML = '<div>' + label + '</div>' + (badge ? '<div>' + badge + '</div>' : '');
        item.onclick = () => { model = id; menu.remove(); };
        menu.append(item);
      }
      menu.onkeydown = () => menu.remove();
      document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.remove(); }, { once: true });
      document.body.append(menu);
    };
  </script>`;

test('Perplexity frontend fixture: login, models, generation, tools via /v1, quota, challenge, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'perplexity-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'perplexity';
  const browser = await chromium.launch();
  const provider = getProvider() as PerplexityProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installPerplexityCapture);
    const page = await context.newPage();
    let authenticated = true, quota = false, challenge = false;
    const requests: any[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard, catalog: perplexityModels(CONFIG) });
    await page.route('https://www.perplexity.ai/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/session') {
        if (challenge) return route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html', body: '<title>Just a moment...</title>' });
        return route.fulfill({ json: authenticated ? { user: { id: 'fixture', email: 'fixture@example.invalid' }, expires: new Date(Date.now() + 86400000).toISOString() } : {} });
      }
      if (pathname === '/rest/sse/perplexity_ask') {
        requests.push(route.request().postDataJSON());
        return route.fulfill(quota ? { status: 429, headers: { 'retry-after': '120' }, json: { detail: { error_code: 'RATE_LIMITED' } } } :
          { contentType: 'text/event-stream', body: message(markdown(['Olá ', 'do fixture [1]'])) +
            message({ status: 'COMPLETED', final: true, blocks: [sources] }) + endOfStream() });
      }
      return route.fulfill({ contentType: 'text/html', body: COMPOSER });
    });
    await page.goto('https://www.perplexity.ai/');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'perplexity/auto', contextLength: 0 },
      { id: 'perplexity/turbo', contextLength: 0 }, { id: 'perplexity/claude55sonnet', contextLength: 0 }]);
    const result = await collect(await provider.generate('Pergunta\n\ncom parágrafos', 'perplexity/auto', false));
    assert.match(text(result), /^Olá do fixture \[1\]\n\nFontes:\n\[1\] Fonte A - https:\/\/a\.example\/x/);
    assert.equal(requests.at(-1).query_str.replace(/\s+/g, ' '), 'Pergunta com parágrafos');
    assert.equal(requests.at(-1).params.model_preference, 'turbo', 'auto restores the site default entry when listed');
    assert.equal(guard.status().busy, false);
    await collect(await provider.generate('Modelo específico', 'perplexity/claude55sonnet', false));
    assert.equal(requests.at(-1).params.model_preference, 'claude55sonnet');
    await assert.rejects(async () => collect(await provider.generate('Bloqueado', 'perplexity/gpt6_astra', false)), (e: any) => e.status === 400);
    assert.equal(guard.status().busy, false);
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'perplexity/auto');
    assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'perplexity/auto', stream,
          tools: [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          messages: [
            { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
            { role: 'user', content: 'Primeiro turno' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
            { role: 'user', content: 'Continue' },
          ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /Olá do fixture/);
      const prompt = requests.at(-1).query_str as string;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/);
      assert.match(prompt, /User: Primeiro turno/);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'perplexity/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Perplexity web/);
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'perplexity/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(async () => collect(await provider.generate('Teste', 'perplexity/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true, 'a usage limit keeps the login');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    challenge = true;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 503);
    assert.equal(provider['state'], 'unavailable', 'a Cloudflare challenge is not an expired login');
    challenge = false; authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Perplexity early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'perplexity-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new PerplexityProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      // A guest also sees the editor; only the session endpoint proves authentication.
      await page.route('https://www.perplexity.ai/**', route => new URL(route.request().url()).pathname === '/api/auth/session' ?
        route.fulfill({ json: authenticated ? { user: { email: 'fixture@example.invalid' }, expires: new Date(Date.now() + 60000).toISOString() } : {} }) :
        route.fulfill({ contentType: 'text/html', body: COMPOSER }));
      await page.goto('https://www.perplexity.ai/');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
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
