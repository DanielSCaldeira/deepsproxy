import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Route } from 'playwright';
import { parseQuillBotStream, QUILLBOT_MODELS, quillBotError } from './providers/quillbot-protocol.ts';
import { installQuillBotCapture } from './providers/quillbot-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { QuillBotProvider, QUILLBOT_LOGIN_URL } from './providers/quillbot.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Event shapes from the public ai-chat-core bundle (v0.27.2): one JSON object per line.
const line = (value: unknown) => JSON.stringify(value) + '\n';
const answer = (...parts: string[]) => parts.map(content => line({ type: 'content', content })).join('') +
  line({ type: 'status', status: 'completed' });
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const text = (values: any[]) => values.filter(v => v.type === 'content').map(v => v.text).join('');

test('QuillBot routing exposes one chat model and maps service errors without guessing suspensions', () => {
  assert.equal(providerId('quillbot'), 'quillbot');
  assert.equal(providerIdForModel('quillbot/chat'), 'quillbot');
  assert.equal(providerIdForModel('chat'), null);
  assert.deepEqual(QUILLBOT_MODELS, [{ id: 'quillbot/chat', contextLength: 0 }]);
  const args = interactiveWorkerArguments('/profile', QUILLBOT_LOGIN_URL);
  assert.equal(args.at(-1), 'https://quillbot.com/login?returnUrl=/ai-chat');
  assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(quillBotError(403).status, 403); assert.doesNotMatch(quillBotError(403).message, /suspended|login/);
  assert.equal(quillBotError(403, 'COM_FORBIDDEN').status, 403);
  assert.match(quillBotError(403, 'auth/user-disabled').message, /account is suspended/);
  assert.equal(quillBotError(401).status, 401);
  for (const code of ['USER_GENERATIONS_HOURLY_LIMIT', 'USER_GENERATIONS_LIMIT', 'UNVERIFIED_GENERATIONS_LIMIT', 'rate_limited'])
    assert.equal(quillBotError(502, code).status, 429);
});

test('QuillBot NDJSON deltas keep formatting, CRLF, split Unicode, parts and usage', async () => {
  const input = (line({ type: 'title', title: 'Fixture' }) + line({ type: 'status', status: 'processing' }) +
    line({ type: 'content', content: 'Olá 👋' }) + line({ type: 'content', content: ' Olá\n```ts\nx()\n```' }) +
    line({ type: 'message_part', index: 1 }) + line({ type: 'content', content: 'Parte 2' }) +
    line({ type: 'annotation', annotation: { type: 'url_citation', start_index: 0, end_index: 1, title: 't', url: 'https://example.test' } }) +
    line({ type: 'status', status: 'completed' }) + line({ type: 'usage', input_tokens: 10, output_tokens: 7, model: 'fixture' })).replace(/\n/g, '\r\n');
  const values = await collect(parseQuillBotStream(chunks(input)));
  assert.equal(text(values), 'Olá 👋 Olá\n```ts\nx()\n```\n\nParte 2');
  assert.deepEqual(values.filter(v => v.type === 'usage'), [{ type: 'usage', completionTokens: 7 }]);
  assert.deepEqual(values.at(-1), { type: 'finish' });
  assert.equal(values.filter(v => v.type === 'finish').length, 1);
  // A final line without a trailing newline is still decoded.
  assert.equal(text(await collect(parseQuillBotStream(chunks(answer('fim').trimEnd(), 4)))), 'fim');
});

test('QuillBot decoding fails explicitly on truncation, malformed data, upstream errors and limits', async () => {
  for (const input of ['nope\n', line({ content: 'x' }), line({ type: 'content', content: 7 }),
    line({ type: 'content', content: 'sem fim' }), line({ type: 'status', status: 'completed' }),
    line({ type: 'content', content: 'x' }) + line({ type: 'status', status: 'failed' })]) {
    await assert.rejects(() => collect(parseQuillBotStream(chunks(input))), UpstreamError);
  }
  await assert.rejects(() => collect(parseQuillBotStream(chunks(line({ type: 'rate_limited', user_status: 'LOGGED_IN' })))), (e: any) => e.status === 429);
  await assert.rejects(() => collect(parseQuillBotStream(chunks(line({ type: 'tool_progress', tool: 'image', progress: 0, status: 'rate_limited' })))), (e: any) => e.status === 429);
  await assert.rejects(() => collect(parseQuillBotStream(chunks(line({ type: 'error', error: { message: 'internal', code: 'USER_GENERATIONS_LIMIT' } })))), (e: any) => e.status === 429);
  await assert.rejects(() => collect(parseQuillBotStream(chunks(line({ type: 'error', error: { message: 'internal detail' } })))),
    (e: any) => e.status === 502 && !/internal detail/.test(e.message));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseQuillBotStream(chunks(answer('text')), controller.signal)));
});

test('QuillBot decoded tool calls use the shared OpenAI parser', async () => {
  const call = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseQuillBotStream(chunks(answer(call.slice(0, 20), call.slice(20)), 5)),
    'chatcmpl-fixture', 'quillbot/chat', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('QuillBot browser capture ignores other requests, keeps the frontend response and cancels the real conversation', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://quillbot.com/ai-chat', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://quillbot.com/ai-chat');
    await page.evaluate(() => {
      const scope = globalThis as any;
      scope.originalCalls = [];
      globalThis.fetch = async (input, init) => {
        scope.originalCalls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        if (String(input).endsWith('/missing')) return new Response('{"code":"USER_GENERATIONS_LIMIT","message":"x"}', { status: 429 });
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('{"type":"content","content":"oi"}\n'));
          init?.signal?.addEventListener('abort', () => { scope.aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      };
    });
    await page.evaluate(installQuillBotCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      // No named local functions inside page code: tsx would inject __name.
      scope.post = (id: string, content: string) => fetch(`/api/ai-chat/chat/conversation/${id}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { content, files: [] }, context: {}, origin: { name: 'ai-chat.chat' } }) });
      scope.__proxyQuillBot = { prompt: 'hello\n\nworld', chunks: [], bytes: 0, claimed: false, done: false };
      await fetch('/api/ai-chat/chat/conversations?origin=ai-chat.chat');
      await scope.post('other', 'another prompt');
      const unclaimed = !scope.__proxyQuillBot.claimed;
      const response = await scope.post('chat-1', 'hello\n\nworld\n\n');
      const reader = response.body!.getReader(); const first = await reader.read();
      for (let i = 0; i < 200 && !scope.__proxyQuillBot.chunks.length; i++) await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyQuillBot.chunks.join('');
      scope.__proxyQuillBot.cancel(); scope.__proxyQuillBot.controller.abort();
      for (let i = 0; i < 200 && !scope.aborted; i++) await new Promise(r => setTimeout(r, 10));
      const claimed = { chatId: scope.__proxyQuillBot.chatId, captured, aborted: !!scope.aborted };
      scope.__proxyQuillBot = { prompt: 'limit', chunks: [], bytes: 0, claimed: false, done: false };
      await scope.post('missing', 'limit');
      for (let i = 0; i < 200 && !scope.__proxyQuillBot.done; i++) await new Promise(r => setTimeout(r, 10));
      return { unclaimed, first: new TextDecoder().decode(first.value), ...claimed,
        error: scope.__proxyQuillBot.error, status: scope.__proxyQuillBot.status, code: scope.__proxyQuillBot.code, calls: scope.originalCalls };
    });
    assert.equal(result.unclaimed, true);
    assert.equal(result.first, '{"type":"content","content":"oi"}\n');
    assert.equal(result.captured, '{"type":"content","content":"oi"}\n');
    assert.equal(result.chatId, 'chat-1'); assert.equal(result.aborted, true);
    assert.ok(result.calls.includes('POST /api/ai-chat/chat/conversation/chat-1/cancel'));
    assert.deepEqual([result.error, result.status, result.code], ['upstream', 429, 'USER_GENERATIONS_LIMIT']);
  } finally { await browser.close(); }
});

// Minimal page reproducing the observed composer: MUI textarea with
// data-testid="ai-chat-input", its hidden autosize twin and the send button.
const chatPage = `<!doctype html><title>AI Chat</title>
  <textarea placeholder="Ask me anything" data-testid="ai-chat-input"></textarea>
  <textarea aria-hidden="true" readonly tabindex="-1" style="visibility:hidden;position:absolute"></textarea>
  <button type="button" role="button" data-testid="quill-chat-send-button">Enviar</button>
  <script>document.querySelector('[data-testid=quill-chat-send-button]').onclick=async()=>{
    const content=document.querySelector('[data-testid=ai-chat-input]').value;
    const id='c'+Math.random().toString(16).slice(2);
    history.pushState(null,'','/ai-chat/c/'+id);
    await fetch('/api/ai-chat/chat/conversations?origin=ai-chat.chat');
    const response=await fetch('/api/ai-chat/chat/conversation/'+id,{method:'POST',credentials:'include',
      headers:{'Content-Type':'application/json',Accept:'text/event-stream'},
      body:JSON.stringify({message:{content:content+'\\n\\n',files:[]},context:{},origin:{name:'ai-chat.chat',url:location.origin}})});
    await response.text();
  };</script>`;
// The "unified" composer observed on /ai-chat/c/...: send stays disabled until typing.
const unifiedPage = chatPage
  .replace('placeholder="Ask me anything" data-testid="ai-chat-input"', 'placeholder="Type your message ..." aria-label="Message input" data-testid="unified-ai-chat-input"')
  .replace('<button type="button" role="button" data-testid="quill-chat-send-button">', '<button type="button" role="button" aria-label="Send message" data-testid="ai-chat-send-button" disabled>')
  .replace('[data-testid=quill-chat-send-button]', '[data-testid=ai-chat-send-button]')
  .replace("[data-testid=ai-chat-input]').value", "[data-testid=unified-ai-chat-input]').value")
  .replace('<script>', `<script>document.querySelector('textarea').oninput=e=>{document.querySelector('[data-testid=ai-chat-send-button]').disabled=!e.target.value};`);

test('QuillBot frontend fixture: authenticated account, generation, IDE tools, quota, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quillbot-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'quillbot';
  const browser = await chromium.launch();
  const provider = getProvider() as QuillBotProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installQuillBotCapture);
    await context.addCookies([{ name: 'authenticated', value: 'true', url: 'https://quillbot.com' }]);
    const page = await context.newPage();
    let authenticated = true, quota = false, remaining = 5, challenge = false, unified = false;
    const prompts: string[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://quillbot.com/**', async (route: Route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/user-cache') return route.fulfill(authenticated ? { json: { data: {} } } :
        { status: 403, json: { code: 'COM_FORBIDDEN', message: 'Forbidden resource', status: 403 } });
      if (pathname === '/api/ai-chat/chat/limit/ai-chat.chat') return route.fulfill({ json: { data: { limit: 20, remaining } } });
      if (pathname === '/api/ai-chat/chat/conversations') return route.fulfill({ json: { data: [], pagination: { hasMore: false, cursor: null } } });
      if (/^\/api\/ai-chat\/chat\/conversation\/[\w-]+$/.test(pathname)) {
        prompts.push(route.request().postDataJSON().message.content);
        return route.fulfill(quota ? { status: 429, headers: { 'retry-after': '120' }, json: { code: 'USER_GENERATIONS_LIMIT', message: 'limit' } } :
          { contentType: 'text/event-stream', body: answer('Olá ', 'do fixture') + line({ type: 'usage', input_tokens: 3, output_tokens: 2 }) });
      }
      if (challenge) return route.fulfill({ status: 403, contentType: 'text/html', body: '<title>Just a moment...</title>' });
      return route.fulfill({ contentType: 'text/html', body: unified ? unifiedPage : chatPage });
    });
    await page.goto('https://quillbot.com/ai-chat');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'quillbot/chat', contextLength: 0 }]);
    const result = await collect(await provider.generate('Teste\n\ncom linhas', 'quillbot/chat', false));
    assert.equal(text(result), 'Olá do fixture'); assert.equal(guard.status().busy, false);
    assert.equal(prompts.at(-1), 'Teste\n\ncom linhas\n\n');
    await assert.rejects(() => provider.generate('x', 'quillbot/other', false), (e: any) => e.status === 400);
    unified = true;
    assert.equal(text(await collect(await provider.generate('Editor unificado', 'quillbot/chat', false))), 'Olá do fixture');
    assert.equal(prompts.at(-1), 'Editor unificado\n\n');
    unified = false;

    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'quillbot/chat');
    assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    const image = await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'quillbot/chat',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }] }) });
    assert.equal(image.status, 400); await image.text();
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'quillbot/chat', stream,
          tools: [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          messages: [
            { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
            { role: 'user', content: 'Primeiro turno' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
            { role: 'user', content: 'Continue' },
          ] }) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Olá /); assert.match(body, /do fixture/);
      if (stream) assert.match(body, /data: \[DONE\]/);
      assert.match(prompts.at(-1)!, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompts.at(-1)!, /Tools:.*"name":"lookup"/);
      assert.match(prompts.at(-1)!, /To call a listed tool, output <tool_call>/);
      assert.match(prompts.at(-1)!, /User: Primeiro turno/);
      assert.match(prompts.at(-1)!, /Assistant:.*<tool_call>/s);
      assert.match(prompts.at(-1)!, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }

    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'quillbot/chat', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);

    // The cancelled request above may still reach the fixture route; let the count settle.
    for (let last = -1, i = 0; i < 50 && last !== prompts.length; i++) { last = prompts.length; await new Promise(resolve => setTimeout(resolve, 100)); }

    // HTTP 429 from the conversation request keeps the login and defers the queue.
    quota = true;
    const sent = prompts.length;
    await assert.rejects(async () => collect(await provider.generate('Teste', 'quillbot/chat', false)), (e: any) => e.status === 429);
    assert.equal(prompts.length, sent + 1, 'a limited request is not retried automatically');
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true);
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    quota = false;

    // The site's freemium counter at zero fails before anything is typed or sent.
    remaining = 0;
    Object.assign(provider, { checkedAt: null });
    const status = await provider.status();
    assert.equal(status.state, 'rate_limited'); assert.equal(status.originalMessage, 'Limite de mensagens do QuillBot atingido.');
    await assert.rejects(async () => collect(await provider.generate('Sem cota', 'quillbot/chat', false)), (e: any) => e.status === 429);
    assert.equal(prompts.length, sent + 1);
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    remaining = 5;

    // A Cloudflare interstitial is unavailability, not an expired login.
    challenge = true;
    await page.goto('https://quillbot.com/ai-chat');
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 503);
    assert.equal(guard.status().block, null);
    challenge = false;
    await page.goto('https://quillbot.com/ai-chat');

    authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    authenticated = true;
    await context.addCookies([{ name: 'authenticated', value: 'false', url: 'https://quillbot.com' }]);
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401, 'visitor cookie is not a login');
    const error = apiError(new UpstreamError('QuillBot login is required.', 401), 'quillbot_login_required').error;
    assert.equal(error.help_url, 'https://quillbot.com/ai-chat'); assert.match(error.user_action, /Concluir login/);
    assert.match(error.user_action, /QuillBot/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('QuillBot early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quillbot-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new QuillBotProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://quillbot.com/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/auth/user-cache') return route.fulfill(authenticated ? { json: { data: {} } } : { status: 403, json: { code: 'COM_FORBIDDEN' } });
        if (pathname.startsWith('/api/')) return route.fulfill({ json: { data: { limit: 20, remaining: 20 } } });
        return route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': `authenticated=${authenticated}; Path=/` }, body: '<title>AI Chat</title><p>Chat</p>' });
      });
      await page.goto('https://quillbot.com/ai-chat');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    assert.equal((await provider.status()).confirmationRequired, true);
    await assert.rejects(() => provider.models(), (e: any) => e.status === 401);
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    authenticated = true;
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true); assert.equal(status.authenticated, true);
    assert.equal(humanRunning, false);
    // A later connect must reuse the already-open automation browser.
    const page = provider.getActivePage(); await provider.initialize(false); assert.equal(provider.getActivePage(), page);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('QuillBot free account: user-cache 403 with a stored Firebase user is a login; an anonymous user is not', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'quillbot-firebase-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new QuillBotProvider();
  let humanRunning = true, reopened = 0, anonymous = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    // The site's Firebase SDK keeps the signed-in user in IndexedDB; the fixture writes the same shape.
    const store = (isAnonymous: boolean) => `<script>const o=indexedDB.open('firebaseLocalStorageDb',1);
      o.onupgradeneeded=()=>o.result.createObjectStore('firebaseLocalStorage',{keyPath:'fbase_key'});
      o.onsuccess=()=>{const t=o.result.transaction('firebaseLocalStorage','readwrite');
        t.objectStore('firebaseLocalStorage').put({fbase_key:'firebase:authUser:fixture-key:[DEFAULT]',value:{isAnonymous:${isAnonymous},stsTokenManager:{refreshToken:'fixture'}}});
        t.oncomplete=()=>{document.title='AI Chat';};};</script>`;
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://quillbot.com/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        // Live worker: a signed-in free account and a visitor both get 403 here.
        if (pathname === '/api/auth/user-cache') return route.fulfill({ status: 403, json: { code: 'COM_FORBIDDEN' } });
        if (pathname.startsWith('/api/')) return route.fulfill({ json: { data: { limit: 20, remaining: 20 } } });
        return route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': 'authenticated=true; Path=/' }, body: store(anonymous) + '<p>Chat</p>' });
      });
      await page.goto('https://quillbot.com/ai-chat');
      await page.waitForFunction(() => document.title === 'AI Chat');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.finishLogin(), /Conclua o acesso/);
    assert.equal(reopened, 1, 'an anonymous Firebase user is not a login');
    anonymous = false;
    await provider.finishLogin();
    assert.equal(reopened, 1);
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.authenticated, true); assert.equal(status.sessionSaved, true);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
