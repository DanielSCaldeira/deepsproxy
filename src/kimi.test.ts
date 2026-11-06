import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { connectFrame, decodeConnectFrames, kimiError, kimiModels, parseKimiStream, KIMI_CHAT_PATH } from './providers/kimi-protocol.ts';
import { installKimiCapture } from './providers/kimi-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { KimiProvider } from './providers/kimi.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

const ORIGIN = 'https://www.kimi.ai';
// Shapes follow the public GetAvailableModels response captured on 2026-11-06 (sanitized).
const CATALOG = { availableModels: [
  { scenario: 'SCENARIO_OK_COMPUTER', displayName: 'K3.1 Pro', kimiPlusId: 'ok-computer', key: 'k3d1-agent', id: 'k3d1-agent' },
  { scenario: 'SCENARIO_CHAT', displayName: 'Instant', key: 'k2d6', id: 'k2d6-chat',
    reasoningEffortOptions: [{ effort: 'REASONING_EFFORT_NONE' }, { effort: 'REASONING_EFFORT_LOW' }] },
], moreModels: [{ scenario: 'SCENARIO_OK_COMPUTER', displayName: 'K3', kimiPlusId: 'ok-computer', key: 'k3', id: 'k3-agent' }],
defaultChatModel: 'k2d6-chat' };
const frames = (...values: Array<[unknown, number?]>) => Buffer.concat(values.map(([v, f]) => Buffer.from(connectFrame(v, f ?? 0))));
const userEcho = { op: 'set', message: { id: 'user-1', role: 'user', blocks: [{ id: 'u', text: { content: 'prompt' } }] } };
const assistant = { op: 'set', message: { id: 'answer', role: 'assistant', status: 'MESSAGE_STATUS_GENERATING' } };
const text = (content: string, op = 'append', id = 'b1', mask = 'block.text.content') =>
  ({ op, mask, block: { id, messageId: 'answer', text: { content } } });
async function* bytes(data: Uint8Array, size = 1) { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };

test('Kimi routing, chat-only catalog and error mapping', () => {
  assert.equal(providerId('kimi'), 'kimi'); assert.equal(providerIdForModel('kimi/k2d6-chat'), 'kimi');
  assert.equal(providerIdForModel('kimi'), null);
  assert.deepEqual(kimiModels(CATALOG), [{ id: 'kimi/k2d6-chat', label: 'Instant', aliases: ['k2d6-chat', 'k2d6'], contextLength: 0 }]);
  assert.deepEqual(kimiModels({}), []); assert.deepEqual(kimiModels({ availableModels: [{ scenario: 'SCENARIO_CHAT', id: '../x', displayName: 'X' }] }), []);
  const args = interactiveWorkerArguments('/profile', `${ORIGIN}/`);
  assert.equal(args.at(-1), `${ORIGIN}/`); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(kimiError(403).status, 403); assert.doesNotMatch(kimiError(403).message, /suspended|login/);
  assert.match(kimiError(403, 'permission_denied', 'REASON_ACCOUNT_BANNED').message, /account is suspended/);
  assert.equal(kimiError(200, 'resource_exhausted').status, 429);
  assert.equal(kimiError(502, undefined, 'REASON_TEXT_USAGE_EXCEEDED').status, 429);
  assert.equal(kimiError(502, undefined, 'REASON_ANONYMOUS_REQUIRE_LOGIN').status, 401);
  assert.equal(kimiError(401, 'unauthenticated').status, 401);
});

test('Kimi Connect frames survive arbitrary byte splits and split Unicode', async () => {
  const data = frames([{ block: { id: 'x', text: { content: 'Olá 🌍' } } }], [{}, 2]);
  const decoded = await collect(decodeConnectFrames(bytes(data, 1)));
  assert.deepEqual(decoded, [{ end: false, value: { block: { id: 'x', text: { content: 'Olá 🌍' } } } }, { end: true, value: {} }]);
  await assert.rejects(() => collect(decodeConnectFrames(bytes(data.subarray(0, data.length - 1)))), UpstreamError);
  await assert.rejects(() => collect(decodeConnectFrames(bytes(frames([{}, 1])))), /Compressed/);
});

test('Kimi stream appends, honors block set, ignores user echo and hidden thinking', async () => {
  const data = frames([userEcho], [assistant],
    [{ op: 'set', block: { id: 't', messageId: 'answer', think: { content: 'private plan' } } }],
    [text('Olá')], [text(' mundo')], [text('Olá mundo!\n```ts\nx()\n```', 'set', 'b1', 'block')],
    [{ op: 'set', block: { id: 'u2', messageId: 'user-1', text: { content: 'echo' } } }],
    [{ heartbeat: {} }], [{ done: {} }], [{}, 2]);
  const values = await collect(parseKimiStream(bytes(data, 3)));
  assert.deepEqual(values, [{ type: 'content', text: 'Olá' }, { type: 'content', text: ' mundo' },
    { type: 'content', text: '!\n```ts\nx()\n```' }, { type: 'finish' }]);
  const withThinking = await collect(parseKimiStream(bytes(data, 7), undefined, { thinking: true }));
  assert.deepEqual(withThinking[0], { type: 'reasoning', text: 'private plan' });
});

test('Kimi decoding fails explicitly on truncation, revisions, errors and limits', async () => {
  for (const data of [frames([text('unfinished')]), frames([text('abc')], [text('xyz', 'set', 'b1', 'block')], [{ done: {} }]),
    frames([{ done: {} }]), Buffer.from([0, 0, 0, 0, 3, 110, 111, 112])]) {
    await assert.rejects(() => collect(parseKimiStream(bytes(data, 2))), UpstreamError);
  }
  const limit = frames([text('a')], [{ error: { code: 'resource_exhausted', details: [{ debug: { reason: 'REASON_TEXT_USAGE_EXCEEDED' } }] } }, 2]);
  await assert.rejects(() => collect(parseKimiStream(bytes(limit))), (e: any) => e.status === 429);
  const login = frames([{ error: { code: 'unauthenticated' } }, 2]);
  await assert.rejects(() => collect(parseKimiStream(bytes(login))), (e: any) => e.status === 401);
  const blocked = frames([assistant], [{ op: 'set', message: { id: 'answer', role: 'assistant', error: { reason: 'REASON_RATE_LIMIT_EXCEEDED' } } }]);
  await assert.rejects(() => collect(parseKimiStream(bytes(blocked))), (e: any) => e.status === 429);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseKimiStream(bytes(frames([text('x')], [{ done: {} }])), controller.signal)));
});

test('Kimi decoded tool calls use the shared OpenAI parser', async () => {
  const call = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseKimiStream(bytes(frames([text(call)], [{ done: {} }]), 5)),
    'chatcmpl-fixture', 'kimi/k2d6-chat', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Kimi browser capture claims only the matching Chat request, enforces model and cancels it', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new Uint8Array([0, 0, 0, 0, 2, 123, 125]));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'application/connect+json' } });
      };
    });
    await page.evaluate(installKimiCapture);
    const body = (prompt: string, model: string) => [...connectFrame({ message: { role: 'user', blocks: [{ text: { content: prompt } }] }, options: { model } })];
    const bodies = { resume: body('hello world', 'k2d6-chat'), other: body('other prompt', 'k2d6-chat'),
      match: body('hello\nworld', 'k2d6-chat'), mismatch: body('hello', 'k3-agent') };
    const result = await page.evaluate(async ({ path, bodies }) => {
      const scope = globalThis as any;
      const headers = { 'content-type': 'application/connect+json' };
      scope.__proxyKimi = { prompt: 'hello  world', aliases: ['k2d6-chat', 'k2d6'], chunks: [], bytes: 0, done: false };
      await fetch('/apiv2/kimi.gateway.chat.v1.ChatService/ResumeChat', { method: 'POST', headers, body: new Uint8Array(bodies.resume) });
      await fetch(path, { method: 'POST', headers, body: new Uint8Array(bodies.other) });
      const afterOthers = !!scope.__proxyKimi.claimed;
      const response = await fetch(path, { method: 'POST', headers, body: new Uint8Array(bodies.match) });
      const reader = response.body!.getReader(); const first = await reader.read();
      await new Promise(r => setTimeout(r, 20));
      const captured = scope.__proxyKimi.chunks.slice();
      scope.__proxyKimi.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      scope.__proxyKimi = { prompt: 'hello', aliases: ['k2d6-chat'], chunks: [], bytes: 0, done: false };
      try { await fetch(path, { method: 'POST', headers, body: new Uint8Array(bodies.mismatch) }); } catch { /* expected mismatch */ }
      return { afterOthers, first: Array.from(first.value!), captured, aborted: scope.aborted,
        mismatch: scope.__proxyKimi.error, calls: scope.originalCalls.length };
    }, { path: KIMI_CHAT_PATH, bodies });
    assert.equal(result.afterOthers, false); assert.deepEqual(result.first, [0, 0, 0, 0, 2, 123, 125]);
    assert.deepEqual([...Buffer.from(result.captured.join(''), 'base64')], [0, 0, 0, 0, 2, 123, 125]);
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 3);
  } finally { await browser.close(); }
});

/** Minimal frontend modeled on the captured composer: Lexical textbox, div send
 * control toggled by classes, model menu with data-testid and Connect transport. */
const FRONTEND = `<div class="chat-editor-wrap"><div class="chat-editor" data-testid="chat-editor">
  <div class="chat-input-editor" contenteditable="true" role="textbox" data-lexical-editor="true"></div>
  <div class="chat-editor-action"><div class="current-model" data-testid="model-select-trigger" aria-haspopup="menu"><div class="model-name">K3 High</div></div>
  <div class="send-button-container disabled"><svg class="send-icon" width="16" height="16"></svg></div></div></div></div>
  <div role="menu" id="menu" hidden data-testid="model-list-options">
    <button role="menuitemradio" class="model-item" data-testid="model-option" data-id="k3d1-agent"><span class="model-name">K3.1 Pro</span></button>
    <button role="menuitemradio" class="model-item" data-testid="model-option" data-id="k2d6-chat"><span class="model-name">Instant</span></button>
  </div>
  <script>
  const ed=document.querySelector('.chat-input-editor'), send=document.querySelector('.send-button-container');
  const trigger=document.querySelector('[data-testid=model-select-trigger]'), menu=document.getElementById('menu');
  ed.addEventListener('input',()=>send.classList.toggle('disabled',!ed.innerText.trim()));
  trigger.onclick=()=>{menu.hidden=!menu.hidden};
  document.addEventListener('keydown',e=>{if(e.key==='Escape')menu.hidden=true});
  for(const b of menu.querySelectorAll('[data-testid=model-option]')) b.onclick=()=>{trigger.querySelector('.model-name').textContent=b.innerText.trim();window.model=b.dataset.id;menu.hidden=true};
  send.onclick=async()=>{
    if(send.classList.contains('disabled')) return;
    if(send.classList.contains('stop')) { window.stopped=true; return; }
    const json=new TextEncoder().encode(JSON.stringify({chat_id:'',scenario:'SCENARIO_CHAT',message:{role:'user',blocks:[{text:{content:ed.innerText}}]},options:{thinking:true,model:window.model}}));
    const body=new Uint8Array(5+json.length);new DataView(body.buffer).setUint32(1,json.length);body.set(json,5);
    send.classList.add('stop');
    try{const r=await fetch('${KIMI_CHAT_PATH}',{method:'POST',headers:{'content-type':'application/connect+json','connect-protocol-version':'1'},body});await r.arrayBuffer();}catch{}
    finally{send.classList.remove('stop');ed.textContent='';send.classList.add('disabled');}
  };
  const auth=localStorage.getItem('access_token');
  fetch('/apiv2/kimi.gateway.account.v1.UserService/GetCurrentUser',{method:'POST',headers:auth?{authorization:'Bearer '+auth}:{},body:'{}'}).catch(()=>{});
  </script>`;

test('Kimi frontend fixture: login evidence, catalog, generation, IDE prompt, quota, cancel and expiry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'kimi';
  const browser = await chromium.launch();
  const provider = getProvider() as KimiProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installKimiCapture);
    const page = await context.newPage();
    let authenticated = true, quota = false;
    const prompts: string[] = [], models: Array<string | undefined> = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route(`${ORIGIN}/**`, async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      const authorization = (await request.allHeaders()).authorization;
      if (pathname.endsWith('.UserService/GetCurrentUser')) return route.fulfill(authenticated && authorization === 'Bearer fixture-access'
        ? { json: { user: { id: 'fixture-user', nickname: 'Fixture' } } }
        : { status: 401, json: { code: 'unauthenticated', details: [{ debug: { reason: 'REASON_INVALID_AUTH_TOKEN' } }] } });
      if (pathname.endsWith('.ConfigService/GetAvailableModels')) return route.fulfill({ json: CATALOG });
      if (pathname === KIMI_CHAT_PATH) {
        const body = JSON.parse(request.postDataBuffer()!.subarray(5).toString('utf8'));
        prompts.push(body.message.blocks[0].text.content); models.push(body.options.model);
        return route.fulfill({ contentType: 'application/connect+json', body: quota
          ? frames([{ error: { code: 'resource_exhausted', details: [{ debug: { reason: 'REASON_TEXT_USAGE_EXCEEDED' } }] } }, 2])
          : frames([userEcho], [assistant], [text('Olá do')], [text(' fixture')], [{ done: {} }], [{}, 2]) });
      }
      return route.fulfill({ contentType: 'text/html', body: FRONTEND });
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => { localStorage.setItem('access_token', 'fixture-access'); localStorage.setItem('refresh_token', 'fixture-refresh'); });
    await provider.confirmLogin(true);
    const status = await provider.status();
    assert.equal(status.authenticated, true); assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true);
    assert.deepEqual(await provider.models(), [{ id: 'kimi/k2d6-chat', contextLength: 0 }]);
    const result = await collect(await provider.generate('Teste', 'kimi/k2d6-chat', false));
    assert.deepEqual(result, [{ type: 'content', text: 'Olá do' }, { type: 'content', text: ' fixture' }, { type: 'finish' }]);
    assert.equal(prompts.at(-1), 'Teste'); assert.equal(models.at(-1), 'k2d6-chat'); assert.equal(guard.status().busy, false);
    await assert.rejects(() => provider.generate('x', 'kimi/k3d1-agent', false), (e: any) => e.status === 400);
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const listed = await (await app.request('/v1/models', { headers })).json();
    assert.equal(listed.data[0].id, 'kimi/k2d6-chat');
    assert.equal(listed.data[0].context_limit_source, 'unknown'); assert.equal(listed.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'kimi/k2d6-chat', stream,
          tools: [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          messages: [
            { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
            { role: 'user', content: 'Primeiro turno' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
            { role: 'user', content: 'Continue' },
          ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /Olá do/);
      assert.match(prompts.at(-1)!, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompts.at(-1)!, /Tools:.*"name":"lookup"/);
      assert.match(prompts.at(-1)!, /To call a listed tool, output <tool_call>/);
      assert.match(prompts.at(-1)!, /Assistant:.*<tool_call>/s);
      assert.match(prompts.at(-1)!, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'kimi/k2d6-chat', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Kimi web/);
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'kimi/k2d6-chat', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 300 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = true;
    await assert.rejects(async () => collect(await provider.generate('Limite', 'kimi/k2d6-chat', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true, 'a usage limit keeps the login');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 59000);
    assert.equal(guard.status().busy, false);
    // Expired access token with a refresh token: one reload, then login required.
    authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    // Guests have no refresh token; a visible editor never counts as login.
    await page.evaluate(() => localStorage.clear());
    authenticated = true;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal(await page.locator('.chat-input-editor').isVisible(), true);
    const error = apiError(new UpstreamError('Kimi login is required.', 401), 'kimi_login_required').error;
    assert.equal(error.help_url, 'https://www.kimi.ai/'); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Kimi early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new KimiProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route(`${ORIGIN}/**`, route => new URL(route.request().url()).pathname.endsWith('/GetCurrentUser') ?
        route.fulfill(authenticated ? { json: { user: { id: 'fixture-user' } } } : { status: 401, json: { code: 'unauthenticated' } }) :
        route.fulfill({ contentType: 'text/html', body: FRONTEND }));
      await page.goto(`${ORIGIN}/`);
      await page.evaluate(() => { localStorage.setItem('access_token', 'a'); localStorage.setItem('refresh_token', 'r'); });
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
