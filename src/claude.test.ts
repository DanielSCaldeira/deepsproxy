import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { claudeAuthState, claudeError, claudeModels, parseClaudeStream } from './providers/claude-protocol.ts';
import { installClaudeCapture } from './providers/claude-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { ClaudeProvider } from './providers/claude.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Event shapes follow the names read from the public claude.ai bundles (2026-11-06).
const sse = (value: any) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const answer = (...parts: string[]) => sse({ type: 'message_start', message: { id: 'msg', role: 'assistant', model: 'claude-fixture' } }) +
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  parts.map(text => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })).join('') +
  sse({ type: 'content_block_stop', index: 0 }) +
  sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }) +
  sse({ type: 'message_limit', message_limit: { type: 'within_limit' } }) + sse({ type: 'message_stop' });
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const loggedOut = { type: 'error', error: { type: 'permission_error', message: 'Invalid authorization',
  details: { error_visibility: 'user_facing', error_code: 'account_session_invalid' } } };

test('Claude catalog, routing, login probe and error classification', () => {
  assert.equal(providerId('claude'), 'claude'); assert.equal(providerIdForModel('claude/auto'), 'claude');
  assert.equal(providerIdForModel('claude-sonnet-4-6'), null);
  assert.deepEqual(claudeModels({ account: { models: [{ model: 'claude-fixture-1', name: 'Fixture 1' },
    { model: 'claude-locked', name: 'Locked', disabled_reason: 'plan' }, { model: 'not-claude', name: 'Other' }] } }),
    [{ id: 'claude/claude-fixture-1', label: 'Fixture 1', contextLength: 0 }]);
  assert.deepEqual(claudeModels({ account: null }), []);
  const args = interactiveWorkerArguments('/profile', 'https://claude.ai/login');
  assert.equal(args.at(-1), 'https://claude.ai/login'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  // Observed unauthenticated answer of GET /api/organizations.
  assert.equal(claudeAuthState({ status: 403, json: true, organizations: 0, code: 'account_session_invalid', type: 'permission_error' }), 'login_required');
  assert.equal(claudeAuthState({ status: 200, json: true, organizations: 1 }), 'authenticated');
  // A Cloudflare HTML challenge is not an expired login.
  assert.equal(claudeAuthState({ status: 403, json: false, organizations: 0 }), 'unavailable');
  assert.equal(claudeAuthState({ status: 403, json: true, organizations: 0, type: 'permission_error' }), 'unavailable');
  assert.equal(claudeError(403).status, 403); assert.doesNotMatch(claudeError(403).message, /suspended|login/);
  assert.equal(claudeError(403, 'account_session_invalid', 'permission_error').status, 401);
  assert.match(claudeError(403, 'account_banned').message, /account is suspended/);
  assert.equal(claudeError(429).status, 429); assert.equal(claudeError(502, undefined, 'rate_limit_error').status, 429);
  assert.equal(claudeError(529, undefined, 'overloaded_error').status, 503);
});

test('Claude SSE keeps only text blocks, CRLF, split Unicode and finishes once', async () => {
  const input = (sse({ type: 'message_start', message: { id: 'msg' } }) +
    sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
    sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'privado' } }) +
    sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Olá' } }) +
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' 🌍 olá\n```ts\nx()\n```' } }) +
    sse({ type: 'content_block_delta', index: 1, delta: { type: 'citation_start_delta', citation: { uuid: 'c' } } }) +
    sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'web_search' } }) +
    sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":1}' } }) +
    'event: ping\ndata: {"type":"ping"}\n\n' +
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
    sse({ type: 'message_stop' }) + sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'after' } })).replace(/\n/g, '\r\n');
  const values = await collect(parseClaudeStream(chunks(input)));
  assert.equal(values.filter(v => v.type === 'content').map(v => v.text).join(''), 'Olá 🌍 olá\n```ts\nx()\n```');
  assert.deepEqual(values.filter(v => v.type !== 'content'), [{ type: 'usage', completionTokens: 7 }, { type: 'finish' }]);
  const legacy = await collect(parseClaudeStream(chunks('data: {"type":"completion","completion":"Oi","stop_reason":null}\n\n' +
    'data: {"type":"completion","completion":"!","stop_reason":"stop_sequence"}\n\n', 5)));
  assert.deepEqual(legacy, [{ type: 'content', text: 'Oi' }, { type: 'content', text: '!' }, { type: 'finish' }]);
});

test('Claude decoding fails explicitly on limits, errors, retractions, truncation and malformed data', async () => {
  const start = sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const limited = [
    sse({ type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: 'usage_limit' } }) + sse({ type: 'message_stop' }),
    sse({ type: 'message_limit', message_limit: { type: 'exceeded_limit', resetsAt: 1 } }),
    sse({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }),
  ];
  for (const input of limited) await assert.rejects(() => collect(parseClaudeStream(chunks(input))), (e: any) => e.status === 429);
  await assert.rejects(() => collect(parseClaudeStream(chunks(sse(loggedOut)))), (e: any) => e.status === 401);
  await assert.rejects(() => collect(parseClaudeStream(chunks(sse({ type: 'error', error: { type: 'overloaded_error' } })))), (e: any) => e.status === 503);
  for (const input of ['data: nope\n\n', start + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }),
    sse({ type: 'message_stop' }), start + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }) +
      sse({ type: 'content_block_retract', index: 0 }) + sse({ type: 'message_stop' })]) {
    await assert.rejects(() => collect(parseClaudeStream(chunks(input))), UpstreamError);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseClaudeStream(chunks(answer('text')), controller.signal)));
});

test('Claude decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseClaudeStream(chunks(answer(text.slice(0, 20), text.slice(20)), 7)),
    'chatcmpl-fixture', 'claude/auto', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Claude browser capture correlates plain and gzip bodies, ignores other requests and enforces model', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://claude.ai/new', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://claude.ai/new');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await page.evaluate(installClaudeCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      const url = '/api/organizations/org/chat_conversations/conv/completion';
      // No named helpers: tsx keepNames would reference __name inside the page.
      const body = { prompt: '', model: 'claude-fixture', rendering_mode: 'messages' };
      scope.__proxyClaude = { prompt: 'hello\n\nworld', model: 'auto', chunks: [], bytes: 0, done: false };
      await fetch('/api/organizations/org/chat_conversations/conv/completion_status?poll=true');
      await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, prompt: 'another prompt' }) });
      const afterOthers = !!scope.__proxyClaude.claimed;
      const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, prompt: 'hello world' }) });
      const reader = response.body!.getReader(); const first = await reader.read();
      scope.__proxyClaude.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyClaude.chunks.join('');
      // Large bodies are gzip-compressed by the frontend.
      scope.__proxyClaude = { prompt: 'compressed', model: 'claude-fixture', chunks: [], bytes: 0, done: false };
      const gzip = new Uint8Array(await new Response(new Blob([JSON.stringify({ ...body, prompt: 'compressed' })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      await fetch(url.replace(/completion$/, 'completion2'), { method: 'POST', headers: { 'Content-Encoding': 'gzip' }, body: gzip });
      const gzipClaimed = !!scope.__proxyClaude.claimed && !scope.__proxyClaude.error;
      scope.__proxyClaude = { prompt: 'hello', model: 'claude-specific', chunks: [], bytes: 0, done: false };
      try { await fetch(url, { method: 'POST', body: JSON.stringify({ ...body, prompt: 'hello' }) }); } catch { /* expected mismatch */ }
      return { afterOthers, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted, gzipClaimed,
        mismatch: scope.__proxyClaude.error, calls: scope.originalCalls.length };
    });
    assert.equal(result.afterOthers, false); assert.match(result.first, /message_stop/);
    assert.equal(result.aborted, true); assert.equal(result.gzipClaimed, true);
    assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 4);
    assert.match(result.captured, /message_stop/);
  } finally { await browser.close(); }
});

const composer = `<fieldset><div data-testid="chat-input" contenteditable="true" role="textbox" aria-label="Write your prompt to Claude"></div>
  <button data-testid="model-selector-dropdown" type="button">Fixture default</button>
  <div id="menu" hidden><div role="menuitemradio" data-testid="model-selector-option">Fixture 1Modelo de teste</div>
    <div role="menuitemradio" data-testid="model-selector-option">Fixture 2Não seleciona</div></div>
  <button data-testid="chat-input-send" aria-label="Send message" disabled>Send</button></fieldset>
  <script>
    let selected = 'claude-default';
    const input = document.querySelector('[data-testid=chat-input]'), send = document.querySelector('[data-testid=chat-input-send]');
    input.oninput = () => { send.disabled = !input.innerText.trim(); };
    document.querySelector('[data-testid=model-selector-dropdown]').onclick = () => { document.getElementById('menu').hidden = false; };
    document.querySelectorAll('[data-testid=model-selector-option]')[0].onclick = () => { selected = 'claude-fixture-1'; document.getElementById('menu').hidden = true; };
    document.querySelectorAll('[data-testid=model-selector-option]')[1].onclick = () => { document.getElementById('menu').hidden = true; };
    document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('menu').hidden = true; });
    send.onclick = async () => {
      const prompt = input.innerText;
      history.pushState(null, '', '/chat/00000000-0000-4000-8000-000000000000');
      const response = await fetch('/api/organizations/org/chat_conversations/00000000-0000-4000-8000-000000000000/completion',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, model: selected, rendering_mode: 'messages' }) });
      await response.text();
    };
  </script>`;

test('Claude frontend fixture: authenticated account, model selection, generation, quota, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'claude';
  const browser = await chromium.launch();
  const provider = getProvider() as ClaudeProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installClaudeCapture);
    const page = await context.newPage();
    let authenticated = true, quota = false;
    const requests: any[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard,
      catalog: [{ id: 'claude/claude-fixture-1', label: 'Fixture 1', contextLength: 0 }, { id: 'claude/claude-fixture-2', label: 'Fixture 2', contextLength: 0 },
        { id: 'claude/claude-hidden', label: 'Hidden', contextLength: 0 }] });
    await page.route('https://claude.ai/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/organizations') return route.fulfill(authenticated ? { json: [{ uuid: 'org', name: 'Fixture' }] } : { status: 403, json: loggedOut });
      if (/\/completion$/.test(pathname)) {
        requests.push(route.request().postDataJSON());
        return route.fulfill(quota ?
          { status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: JSON.stringify({ type: 'exceeded_limit', resetsAt: Math.floor(Date.now() / 1000) + 300 }) } } } :
          { contentType: 'text/event-stream', body: answer('Olá ', 'do fixture') });
      }
      return route.fulfill({ contentType: 'text/html', body: composer });
    });
    await page.goto('https://claude.ai/new');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual((await provider.models()).map(m => m.id), ['claude/auto', 'claude/claude-fixture-1', 'claude/claude-fixture-2']);
    const result = await collect(await provider.generate('Teste\n\ncom parágrafos', 'claude/auto', false));
    assert.equal(result.filter(v => v.type === 'content').map(v => v.text).join(''), 'Olá do fixture');
    assert.equal(guard.status().busy, false);
    assert.equal(requests.at(-1).model, 'claude-default');
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    await collect(await provider.generate('Modelo explícito', 'claude/claude-fixture-1', false));
    assert.equal(requests.at(-1).model, 'claude-fixture-1'); assert.equal(requests.at(-1).prompt, 'Modelo explícito');
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    // The option exists but the frontend keeps another model: never fall back silently.
    await assert.rejects(async () => collect(await provider.generate('Troca ignorada', 'claude/claude-fixture-2', false)), (e: any) => e.status === 400);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    await assert.rejects(() => provider.generate('x', 'claude/claude-hidden', false), (e: any) => e.status === 400);
    assert.equal(guard.status().busy, false);
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'claude/auto');
    assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'claude/auto', stream,
          tools: [{type:'function',function:{name:'lookup',description:'Read the requested information.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
          messages: [
          { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
          { role: 'user', content: 'Continue' },
        ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /do fixture/);
      const prompt = requests.at(-1).prompt;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/);
      assert.match(prompt, /User: Primeiro turno/);
      assert.match(prompt, /Assistant:.*<tool_call>/s);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'claude/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Claude web/);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'claude/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(async () => collect(await provider.generate('Teste', 'claude/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 280_000);
    assert.equal(guard.status().busy, false);
    authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Claude login is required.', 401), 'claude_login_required').error;
    assert.equal(error.help_url, 'https://claude.ai/'); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|ChatGPT|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'claude-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new ClaudeProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://claude.ai/**', route => new URL(route.request().url()).pathname === '/api/organizations' ?
        route.fulfill(authenticated ? { json: [{ uuid: 'org' }] } : { status: 403, json: loggedOut }) :
        route.fulfill({ contentType: 'text/html', body: '<p>Chat</p>' }));
      await page.goto('https://claude.ai/new');
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
