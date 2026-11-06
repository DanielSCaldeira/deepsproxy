import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { grokError, grokModes, parseGrokStream } from './providers/grok-protocol.ts';
import { installGrokCapture } from './providers/grok-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { GrokProvider } from './providers/grok.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

// Stream lines follow the shape decoded by the public grok.com bundle (processChunks):
// newline-delimited JSON with { result: { conversation | title | response } } or { error }.
const line = (value: unknown) => JSON.stringify(value) + '\n';
const token = (text: string, extra: any = {}) => line({ result: { response: { token: text, isThinking: false, messageTag: 'final', responseId: 'r1', ...extra } } });
const final = (message: string, extra: any = {}) => line({ result: { response: { modelResponse: { responseId: 'r1', message, sender: 'ASSISTANT', partial: false, ...extra } } } });
const answer = (text: string) => line({ result: { conversation: { conversationId: 'c1' } } }) +
  line({ result: { response: { userResponse: { message: 'prompt', sender: 'human' } } } }) +
  token('pensando em privado', { isThinking: true, messageTag: 'header' }) +
  token(text.slice(0, 4)) + token(text.slice(4)) + final(text) + line({ result: { title: { newTitle: 'Fixture' } } });
async function* chunks(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
// One Chromium for every browser test keeps the parallel suite within other files' time limits.
let sharedBrowser: Promise<Browser> | undefined;
const launch = () => sharedBrowser ??= chromium.launch();
test.after(async () => { if (sharedBrowser) await (await sharedBrowser).close(); });
const contentOf = (values: any[]) => values.filter(v => v.type === 'content').map(v => v.text).join('');

test('Grok catalog and routing do not advertise locked or invented models', () => {
  assert.equal(providerId('grok'), 'grok'); assert.equal(providerIdForModel('grok/auto'), 'grok');
  assert.equal(providerIdForModel('grok-3'), null);
  assert.deepEqual(grokModes({ modes: [{ id: 'Fast', title: 'Fast' }, { id: 'heavy', title: 'Heavy', availability: { unavailable: { reason: 'plan' } } },
    { id: 'expert', title: 'Expert', availability: { available: {} } }, { id: '../x', title: 'Bad' }, { id: 'fast', title: 'Duplicate' }] }),
  [{ id: 'grok/fast', label: 'Fast', contextLength: 0 }, { id: 'grok/expert', label: 'Expert', contextLength: 0 }]);
  assert.deepEqual(grokModes({ models: [] }), []);
  const args = interactiveWorkerArguments('/profile', 'https://grok.com/');
  assert.equal(args.at(-1), 'https://grok.com/'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  assert.equal(grokError(403).status, 403); assert.doesNotMatch(grokError(403).message, /suspended|login/);
  assert.match(grokError(403, 'blocked').message, /account is suspended/);
  assert.equal(grokError(502, 8).status, 429); assert.equal(grokError(502, 16).status, 401);
  assert.equal(grokError(429).status, 429);
});

test('Grok NDJSON keeps final tokens, ignores thinking/tool/side-by-side steps and splits Unicode safely', async () => {
  const text = 'Olá 👋\n```ts\nx()\n```';
  const input = answer(text) + token('não deveria aparecer');
  for (const size of [1, 3, 64]) {
    const values = await collect(parseGrokStream(chunks(input.replace(/\n/g, '\r\n'), size)));
    assert.equal(contentOf(values), text);
    assert.equal(values.filter(v => v.type === 'finish').length, 1);
    assert.ok(!values.some(v => v.type === 'reasoning'));
  }
  const tagged = token('Busca', { messageTag: 'tool_usage_card' }) + token('B', { sideBySideIndex: 1 }) +
    line({ result: { response: { keepAlive: true } } }) + line({ result: { response: { throttle: { countdownStyle: 'x' } } } }) +
    token('A') + final('', {}) + final('parcial', { partial: true }) + token('B') + line({ result: { response: { isSoftStop: true } } });
  assert.deepEqual(await collect(parseGrokStream(chunks(tagged, 5))), [{ type: 'content', text: 'A' }, { type: 'content', text: 'B' }, { type: 'finish' }]);
  // A final snapshot completes a streamed prefix; a differently rendered one never retracts text.
  assert.equal(contentOf(await collect(parseGrokStream(chunks(token('Olá') + final('Olá mundo'))))), 'Olá mundo');
  assert.equal(contentOf(await collect(parseGrokStream(chunks(token('Olá') + final('Outro texto'))))), 'Olá');
  // A clean end of the HTTP stream with text completes the answer.
  assert.equal(contentOf(await collect(parseGrokStream(chunks(token('fim'))))), 'fim');
});

test('Grok decoding fails explicitly on malformed data, empty answers and upstream errors', async () => {
  for (const input of ['not json\n', line([]) , '', line({ result: { conversation: {} } }), token('x', { isThinking: true })]) {
    await assert.rejects(() => collect(parseGrokStream(chunks(input))), UpstreamError);
  }
  await assert.rejects(() => collect(parseGrokStream(chunks(line({ error: { code: 8, message: 'quota' } })))), (e: any) => e.status === 429);
  await assert.rejects(() => collect(parseGrokStream(chunks(line({ result: { response: { error: { code: 16 } } } })))), (e: any) => e.status === 401);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseGrokStream(chunks(token('text')), controller.signal)));
});

test('Grok decoded tool calls use the shared OpenAI parser', async () => {
  const text = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseGrokStream(chunks(token(text) + final(text), 7)),
    'chatcmpl-fixture', 'grok/auto', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

test('Grok browser capture ignores other requests/prompts, enforces the mode and cancels the real request', async () => {
  const page = await (await launch()).newPage();
  try {
    await page.route('https://grok.com/',route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('https://grok.com/');
    await page.evaluate(() => {
      (globalThis as any).originalCalls = [];
      globalThis.fetch = async (input, init) => {
        (globalThis as any).originalCalls.push(String(input));
        const body = new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode('{"result":{"response":{"token":"ok"}}}\n'));
          init?.signal?.addEventListener('abort', () => { (globalThis as any).aborted = true; c.error(new Error('aborted')); });
        } });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      };
    });
    await page.evaluate(installGrokCapture);
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyGrok = { prompt: 'hello  world', mode: 'auto', chunks: [], bytes: 0, done: false };
      // No named helpers: the test transpiler would reference __name inside the page.
      await fetch('/rest/app-chat/conversations/c1/responses', { method: 'POST', body: JSON.stringify({ message: 'hello world', modeId: 'auto' }) });
      await fetch('/rest/app-chat/conversations/new', { method: 'POST', body: JSON.stringify({ message: 'other prompt', modeId: 'auto' }) });
      const unclaimed = !scope.__proxyGrok.claimed;
      const response = await fetch('/rest/app-chat/conversations/new', { method: 'POST', body: JSON.stringify({ message: 'hello\n\nworld', modeId: 'auto' }) });
      const reader = response.body!.getReader(); const first = await reader.read();
      scope.__proxyGrok.controller.abort();
      await new Promise(r => setTimeout(r, 10));
      const captured = scope.__proxyGrok.chunks.join('');
      scope.__proxyGrok = { prompt: 'hello', mode: 'expert', chunks: [], bytes: 0, done: false };
      try { await fetch('/rest/app-chat/conversations/new', { method: 'POST', body: JSON.stringify({ message: 'hello', modeId: 'fast' }) }); } catch { /* expected mismatch */ }
      return { unclaimed, first: new TextDecoder().decode(first.value), captured, aborted: scope.aborted,
        mismatch: scope.__proxyGrok.error, calls: scope.originalCalls.length };
    });
    assert.equal(result.unclaimed, true); assert.match(result.first, /"token":"ok"/);
    assert.equal(result.aborted, true); assert.equal(result.mismatch, 'model_mismatch'); assert.equal(result.calls, 3);
    assert.match(result.captured, /"token":"ok"/);
  } finally { await page.context().close(); }
});

/** Minimal sanitized copy of the observed composer (2026-11-06) with a scripted frontend. */
const frontend = `<form data-composer="true"><div data-testid="chat-input"><div contenteditable="true" role="combobox"
  aria-label="Pergunte ao Grok qualquer coisa" class="tiptap ProseMirror"></div></div>
  <button type="button" id="model-select-trigger" aria-label="Modelo: Fast" aria-haspopup="menu"><span>Fast</span></button>
  <button type="submit" aria-label="Enviar" data-testid="chat-submit"></button></form>
  <div id="menu" role="menu" hidden>
    <div role="menuitemradio"><div>Fast</div><div>Respostas rápidas</div></div>
    <div role="menuitemradio"><div>Auto</div><div>Escolhe o modo</div></div>
    <div role="menuitemradio"><div>Expert</div><div>Pensa mais</div></div>
    <div role="menuitemradio" data-upsell><div>Heavy</div><div>SuperGrok</div></div>
    <div role="menuitemradio" aria-disabled="true"><div>Locked</div></div>
    <div role="menuitem"><div>Premium</div></div>
  </div>
  <script>
    const trigger=document.getElementById('model-select-trigger'), menu=document.getElementById('menu');
    trigger.onclick=()=>{menu.hidden=!menu.hidden};
    document.addEventListener('keydown',e=>{if(e.key==='Escape')menu.hidden=true});
    for(const item of menu.querySelectorAll('[role=menuitemradio]')) item.onclick=()=>{
      menu.hidden=true; if(item.hasAttribute('data-upsell')||item.getAttribute('aria-disabled')==='true') return;
      const title=item.firstElementChild.textContent; trigger.setAttribute('aria-label','Modelo: '+title); trigger.firstElementChild.textContent=title;
    };
    fetch('/rest/modes',{method:'POST',headers:{'content-type':'application/json'},body:'{"locale":"pt-BR"}'});
    document.querySelector('form').onsubmit=async e=>{e.preventDefault();
      if(window.__paywall){const card=document.createElement('div');card.dataset.testid='anon-paywall-sign-up-card';card.textContent='Continue sua conversa';document.body.append(card);return}
      const message=document.querySelector('[contenteditable]').innerText;
      const modeId=trigger.getAttribute('aria-label').replace('Modelo: ','').toLowerCase();
      const response=await fetch('/rest/app-chat/conversations/new',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,modeId,modelName:'grok-fixture',temporary:false})});
      await response.text()};
  </script>`;

test('Grok frontend fixture: login, modes, generation, model selection, quota, paywall, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grok-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'grok';
  const browser = await launch();
  const provider = getProvider() as GrokProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installGrokCapture);
    const page = await context.newPage();
    let session: any = { status: 'authenticated', session: { user: { id: 'fixture' } } }, quota = false, paywall = false;
    const requests: any[] = [];
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    (provider as any).observe(context);
    await page.route('https://grok.com/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/auth/session') return route.fulfill({ json: session });
      if (pathname === '/rest/modes') return route.fulfill({ json: { modes: [{ id: 'fast', title: 'Fast' }, { id: 'auto', title: 'Auto' },
        { id: 'expert', title: 'Expert' }, { id: 'heavy', title: 'Heavy' }, { id: 'locked', title: 'Locked' }], defaultModeId: 'auto' } });
      if (pathname === '/rest/app-chat/conversations/new') {
        requests.push(route.request().postDataJSON());
        return route.fulfill(quota ? { status: 429, headers: { 'retry-after': '120' }, json: { code: 8, message: 'Too many requests' } } :
          { contentType: 'application/json', body: answer('Olá do fixture') });
      }
      return route.fulfill({ contentType: 'text/html', body: frontend.replace('<script>', `<script>window.__paywall=${paywall};`) });
    });
    await page.goto('https://grok.com/');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), ['grok/auto', 'grok/fast', 'grok/expert', 'grok/heavy'].map(id => ({ id, contextLength: 0 })));
    assert.equal(await page.locator('#menu').isHidden(), true, 'the menu is closed after listing');
    const result = await collect(await provider.generate('Teste', 'grok/auto', false));
    assert.equal(contentOf(result), 'Olá do fixture'); assert.equal(guard.status().busy, false);
    assert.equal(requests.at(-1).modeId, 'auto'); assert.equal(requests.at(-1).message, 'Teste');
    await collect(await provider.generate('Modo expert', 'grok/expert', false));
    assert.equal(requests.at(-1).modeId, 'expert');
    // An upsell leaves the previous mode selected: the message is never sent with another model.
    const sent = requests.length;
    await assert.rejects(() => provider.generate('Heavy', 'grok/heavy', false), (e: any) => e.status === 400);
    await assert.rejects(() => provider.generate('Locked', 'grok/locked', false), (e: any) => e.status === 400);
    assert.equal(requests.length, sent); assert.equal(guard.status().busy, false);
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'grok/auto'); assert.equal(models.data[0].owned_by, 'grok');
    assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'grok/auto', stream,
          tools: [{type:'function',function:{name:'lookup',description:'Read the requested information.',parameters:{type:'object',properties:{},additionalProperties:false}}}],
          messages: [
          { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
          { role: 'user', content: 'Primeiro turno' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
          { role: 'user', content: 'Continue' },
        ] }) });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal([...body.matchAll(/"content":"([^"]*)"/g)].map(m => m[1]).join(''), 'Olá do fixture');
      const prompt = requests.at(-1).message as string;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/);
      assert.match(prompt, /To call a listed tool, output <tool_call>/);
      assert.match(prompt, /User: Primeiro turno/);
      assert.match(prompt, /Assistant:.*<tool_call>/s);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'grok/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Grok web/);
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'grok/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);
    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    const reset = () => Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    reset(); quota = true;
    await assert.rejects(() => collectProvider(provider), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 119000);
    assert.equal(guard.status().busy, false);
    reset(); quota = false; paywall = true;
    await assert.rejects(() => collectProvider(provider), (e: any) => e.status === 401);
    assert.equal(guard.status().block?.state, 'login_required'); assert.equal(guard.status().busy, false);
    reset(); paywall = false;
    session = { status: 'unauthenticated' };
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    session = { status: 'blocked' };
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 403);
    assert.equal((await provider.status()).state, 'suspended');
    const error = apiError(new UpstreamError('Grok login is required.', 401), 'grok_login_required').error;
    assert.equal(error.help_url, 'https://grok.com/'); assert.match(error.user_action, /Concluir login/);
    assert.match(error.user_action, /card do Grok/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});
async function collectProvider(provider: GrokProvider) { return collect(await provider.generate('Teste', 'grok/auto', false)); }

test('Grok early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grok-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await launch();
  const provider = new GrokProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://grok.com/**', route => new URL(route.request().url()).pathname === '/api/auth/session' ?
        route.fulfill({ json: authenticated ? { status: 'authenticated', session: { user: { id: 'fixture' } } } : { status: 'unauthenticated' } }) :
        route.fulfill({ contentType: 'text/html', body: '<p>Grok</p>' }));
      await page.goto('https://grok.com/');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    assert.equal(provider.isReady(), true);
    await assert.rejects(() => provider.confirmLogin(), /Concluir login/);
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
    await provider.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
