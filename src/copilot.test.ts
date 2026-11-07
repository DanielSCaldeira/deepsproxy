import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { copilotError, parseCopilotEvents } from './providers/copilot-protocol.ts';
import { installCopilotCapture } from './providers/copilot-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { COPILOT_CHAT_URL, CopilotProvider, copilotLoginState } from './providers/copilot.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

const ev = (value: Record<string, unknown>) => JSON.stringify(value);
async function* frames(...values: string[]) { for (const value of values) yield value; }
const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const text = (values: any[]) => values.filter(v => v.type === 'content').map(v => v.text).join('');

test('Copilot catalog, routing, login evidence and service errors', () => {
  assert.equal(providerId('copilot'), 'copilot');
  assert.equal(providerIdForModel('copilot/smart'), 'copilot'); assert.equal(providerIdForModel('copilot/auto'), 'copilot');
  assert.equal(providerIdForModel('copilotx/smart'), null);
  const args = interactiveWorkerArguments('/profile', COPILOT_CHAT_URL);
  assert.equal(args.at(-1), 'https://copilot.microsoft.com/chats/new'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  const base = { origin: 'https://copilot.microsoft.com', anonymous: false, composer: true, userStatus: 200, tier: 'free' };
  assert.equal(copilotLoginState(base), 'authenticated');
  assert.equal(copilotLoginState({ ...base, tier: 'guest' }), 'login_required', 'anonymous tier is never accepted');
  assert.equal(copilotLoginState({ ...base, anonymous: true }), 'login_required');
  assert.equal(copilotLoginState({ ...base, origin: 'https://copilot.com', composer: false, tier: null }), 'login_required', 'marketing redirect');
  assert.equal(copilotLoginState({ ...base, origin: 'https://copilot.com' }), 'authenticated', 'signed-in chat app at copilot.com/chat');
  assert.equal(copilotLoginState({ ...base, origin: 'https://copilot.com', tier: 'guest' }), 'login_required');
  assert.equal(copilotLoginState({ ...base, origin: 'https://login.live.com' }), 'login_required');
  // Microsoft 365 Copilot app at copilot.com/chat: its editor only renders for a signed-in account.
  const m365 = { origin: 'https://copilot.com', anonymous: false, composer: false, userStatus: null, tier: null, m365: true };
  assert.equal(copilotLoginState(m365), 'authenticated');
  assert.equal(copilotLoginState({ ...m365, origin: 'https://login.microsoftonline.com' }), 'login_required');
  assert.equal(copilotLoginState({ ...m365, m365: false }), 'login_required');
  assert.equal(copilotLoginState({ ...base, userStatus: 401, tier: null }), 'login_required');
  assert.equal(copilotLoginState({ ...base, userStatus: null, tier: null }), 'pending');
  assert.equal(copilotError('sign-in-required').status, 401);
  assert.equal(copilotError('throttled').status, 429); assert.equal(copilotError('over-turn-limit').status, 429);
  assert.match(copilotError('banned').message, /account is suspended/);
  assert.equal(copilotError('text-too-long').status, 400);
  assert.equal(copilotError('unknown-error').status, 502); assert.doesNotMatch(copilotError('unknown-error').message, /login|suspended/);
  assert.equal(copilotError('<script>').message, 'Copilot web request failed.');
});

test('Copilot events: appendText deltas, replaceText, parts, other messages and completion', async () => {
  const values = await collect(parseCopilotEvents(frames(
    ev({ event: 'received', conversationId: 'c1' }),
    ev({ event: 'appendText', messageId: 'unknown', partId: 'p', text: 'ignored' }),
    ev({ event: 'startMessage', conversationId: 'c1', messageId: 'm1', createdAt: 'now' }),
    ev({ event: 'chainOfThought', messageId: 'm1', partId: 'cot', text: 'private steps' }),
    ev({ event: 'appendText', messageId: 'm1', partId: 'p1', text: 'Olá' }),
    ev({ event: 'appendText', messageId: 'm1', partId: 'p1', text: ' 👋🏽 mundo' }),
    ev({ event: 'replaceText', messageId: 'm1', partId: 'p1', text: 'Olá 👋🏽 mundo!' }),
    ev({ event: 'appendText', messageId: 'm1', partId: 'ui', parentPartId: 'card', text: 'generative UI' }),
    ev({ event: 'appendText', messageId: 'm1', partId: 'p2', text: '```ts\nx()\n```' }),
    ev({ event: 'citation', messageId: 'm1', partId: 'c', url: 'https://example.test' }),
    ev({ event: 'done', messageId: 'm1' }),
    ev({ event: 'appendText', messageId: 'm1', partId: 'p1', text: 'after done' }),
  )));
  assert.equal(text(values), 'Olá 👋🏽 mundo!\n\n```ts\nx()\n```');
  assert.deepEqual(values.at(-1), { type: 'finish' });
  assert.equal(values.filter(v => v.type === 'reasoning').length, 0);
});

test('Copilot decoding fails explicitly on errors, limits, revisions, malformed data and truncation', async () => {
  const start = ev({ event: 'startMessage', conversationId: 'c1', messageId: 'm1' });
  const cases: Array<[string[], (e: any) => boolean]> = [
    [['not json'], e => e.status === 502],
    [[ev({ nope: true } as any)], e => e.status === 502],
    [[start, ev({ event: 'appendText', messageId: 'm1', partId: 'p', text: 'sem fim' })], e => /ended before completion/.test(e.message)],
    [[start, ev({ event: 'done', messageId: 'm1' })], e => /no final text/.test(e.message)],
    [[start, ev({ event: 'appendText', messageId: 'm1', partId: 'p', text: 'abc' }), ev({ event: 'replaceText', messageId: 'm1', partId: 'p', text: 'xyz' })], e => /revised/.test(e.message)],
    [[ev({ event: 'error', errorCode: 'sign-in-required' })], e => e.status === 401],
    [[start, ev({ event: 'chatMessageError', messageId: 'm1', errorCode: 'throttled', errorDetail: { type: 'throttled', nextAvailableAt: new Date(Date.now() + 120_000).toISOString() } })],
      e => e.status === 429 && Number(e.retryAfter) >= 119],
    [[ev({ event: 'turnLimitReached', id: 'x' })], e => e.status === 429],
    [[ev({ event: 'banned', expiresAt: '2026-12-01T00:00:00Z' })], e => e.status === 403 && /account is suspended/.test(e.message) && e.until === '2026-12-01T00:00:00Z'],
  ];
  for (const [input, check] of cases) await assert.rejects(() => collect(parseCopilotEvents(frames(...input))), (e: any) => e instanceof UpstreamError && check(e));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(parseCopilotEvents(frames(start), controller.signal)));
});

test('Copilot decoded tool calls use the shared OpenAI parser', async () => {
  const call = '<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
  const parsed = await parseProviderStreamToOpenAI(parseCopilotEvents(frames(
    ev({ event: 'startMessage', conversationId: 'c', messageId: 'm' }),
    ev({ event: 'appendText', messageId: 'm', partId: 'p', text: call.slice(0, 20) }),
    ev({ event: 'appendText', messageId: 'm', partId: 'p', text: call.slice(20) }),
    ev({ event: 'done', messageId: 'm' }))),
  'chatcmpl-fixture', 'copilot/auto', 10, [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
  assert.equal(parsed.toolCalls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });
});

type Fixture = { tier: string; reply: string[]; failure?: 'throttled' | 'sign-in' | 'close'; modes: string[]; sends: any[]; limit: number };
/** Simulated copilot.microsoft.com app built from the public bundle's test IDs and WebSocket schema. */
async function copilotFixture(context: BrowserContext, fixture: Fixture) {
  await context.routeWebSocket(/^wss:\/\/copilot\.microsoft\.com\/c\/api\/chat/, ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.event !== 'send') return;
      fixture.sends.push(frame);
      if (fixture.failure === 'sign-in') return ws.send(ev({ event: 'error', errorCode: 'sign-in-required' }));
      ws.send(ev({ event: 'received', conversationId: frame.conversationId }));
      // Another conversation's traffic on the same socket must not leak into the answer.
      ws.send(ev({ event: 'startMessage', conversationId: 'other', messageId: 'other-m' }));
      ws.send(ev({ event: 'appendText', messageId: 'other-m', partId: 'x', text: 'NOISE' }));
      ws.send(ev({ event: 'startMessage', conversationId: frame.conversationId, messageId: 'm-' + fixture.sends.length }));
      if (fixture.failure === 'throttled') return ws.send(ev({ event: 'chatMessageError', messageId: 'm-' + fixture.sends.length, errorCode: 'throttled',
        errorDetail: { type: 'throttled', nextAvailableAt: new Date(Date.now() + 120_000).toISOString() } }));
      if (fixture.failure === 'close') return ws.close({ code: 1011 });
      for (const part of fixture.reply) ws.send(ev({ event: 'appendText', messageId: 'm-' + fixture.sends.length, partId: 'p', text: part }));
      ws.send(ev({ event: 'done', messageId: 'm-' + fixture.sends.length }));
    });
  });
  await context.route('https://copilot.microsoft.com/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/c/api/user') return route.fulfill({ json: { id: 'fixture', accountTier: fixture.tier } });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><main id="app"></main><script>
      const app = document.getElementById('app'); let mode = sessionStorage.getItem('mode') || 'smart', conversation = 0;
      const modes = ${JSON.stringify(fixture.modes)};
      const socket = new WebSocket('wss://copilot.microsoft.com/c/api/chat?api-version=2&accessToken=fixture-token');
      function render() {
        const selected = mode !== 'smart'; sessionStorage.setItem('mode', mode);
        app.innerHTML = '<textarea data-testid="composer-input"></textarea>' +
          '<button data-testid="composer-chat-mode-' + mode + '-button"' + (selected ? ' aria-label="Remove"' : ' aria-haspopup="menu"') + '>' + mode + '</button>' +
          '<button data-testid="submit-button" aria-label="Submit message">Enviar</button>';
        const input = app.querySelector('textarea');
        input.oninput = () => { if (input.value.length > ${fixture.limit}) input.value = input.value.slice(0, ${fixture.limit}); };
        app.querySelector('[data-testid^="composer-chat-mode"]').onclick = () => {
          if (selected) { mode = 'smart'; return render(); }
          const menu = document.createElement('div'); menu.id = 'composer-dropdown-button-menu-contents';
          menu.innerHTML = modes.map(m => '<button role="menuitem" data-testid="composer-chat-mode-' + m + '-button">' + m + '</button>').join('');
          menu.onclick = event => { mode = event.target.dataset.testid.split('-')[3]; render(); };
          app.append(menu);
        };
        app.querySelector('[data-testid="submit-button"]').onclick = () => {
          socket.send(JSON.stringify({ event: 'send', conversationId: 'conv-' + (++conversation), content: [{ type: 'text', text: input.value }], mode }));
          app.querySelector('[data-testid="submit-button"]').outerHTML = '<button data-testid="stop-button">Stop</button>';
        };
      }
      document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('composer-dropdown-button-menu-contents')?.remove(); });
      fetch('/c/api/user?api-version=2').then(r => r.json()).then(user => {
        if (user.accountTier === 'guest') app.innerHTML = '<h1 data-testid="anonymous-block-page-title">Sign in to Copilot</h1>'; else render();
      });
    </script>` });
  });
  // Signed out, the Microsoft 365 app ends at the Microsoft sign-in form.
  await context.route('https://copilot.com/**', route => route.fulfill({ contentType: 'text/html',
    body: '<form><input type="email" name="loginfmt" aria-label="Email, telefone ou Skype"></form>' }));
}

test('Microsoft 365 Copilot sends through its native editor and correlates the SignalR invocation', async () => {
  const browser = await chromium.launch(), provider = new CopilotProvider();
  try {
    const context = await browser.newContext();
    let submissions = 0;
    await context.routeWebSocket('wss://substrate.office.com/**', socket => socket.onMessage(data => {
      for (const raw of String(data).split('\u001e').filter(Boolean)) {
        const value = JSON.parse(raw);
        if (!value.arguments?.[0]?.message?.text) continue;
        submissions++;
        socket.send(JSON.stringify({type:2,invocationId:'unrelated',item:{messages:[{author:'bot',text:'WRONG'}]}})+'\u001e');
        socket.send(JSON.stringify({type:1,arguments:[{messages:[{author:'bot',text:'partial'}]}]})+'\u001e');
        socket.send(JSON.stringify({type:2,invocationId:value.invocationId,item:{result:{value:'Success'},messages:[{author:'bot',text:'M365_OK'}]}})+'\u001e');
      }
    }));
    await context.addInitScript(installCopilotCapture);
    await context.route('https://copilot.microsoft.com/**', route => route.fulfill({contentType:'text/html',body:'<div data-testid="region-block-title">Region</div>'}));
    await context.route('https://copilot.com/**', route => route.fulfill({contentType:'text/html',body:`
      <span id="m365-chat-editor-target-element" role="textbox" contenteditable="true" style="display:inline-block;min-width:300px;min-height:24px"></span>
      <button id="gptModeSwitcher">Auto</button><button aria-label="Enviar"></button>
      <script>const socket=new WebSocket('wss://substrate.office.com/m365/Chathub');
      document.querySelector('[aria-label=Enviar]').onclick=()=>socket.send(JSON.stringify({type:4,invocationId:'fixture',target:'chat',arguments:[{message:{text:document.querySelector('[contenteditable]').innerText}}]})+'\\u001e');</script>`}));
    const page = await context.newPage(), guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider,{context,page,guard});
    await page.goto('https://copilot.com/chat');
    assert.equal(text(await collect(await provider.generate('Teste M365', 'copilot/auto', false))), 'M365_OK');
    assert.equal(submissions,1); assert.equal(guard.status().busy,false);
    await assert.rejects(()=>provider.generate('Modelo bloqueado','copilot/reasoning',false),(e:any)=>e.status===400);
    assert.equal(submissions,1);
  } finally {await provider.close();await browser.close();}
});

test('Copilot frontend fixture: signed-in account, modes, generation, limits, expiry and guard release', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'copilot-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'copilot';
  const browser = await chromium.launch();
  const provider = getProvider() as CopilotProvider;
  try {
    const context = await browser.newContext();
    const fixture: Fixture = { tier: 'free', reply: ['Olá ', 'do fixture'], modes: ['smart', 'reasoning', 'study'], sends: [], limit: 20_000 };
    // Playwright's WebSocket mock must exist before the capture patches the page's WebSocket.
    await copilotFixture(context, fixture);
    await context.addInitScript(installCopilotCapture);
    const page = await context.newPage();
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual((await provider.models()).map(m => m.id), ['copilot/auto', 'copilot/smart', 'copilot/reasoning', 'copilot/study']);
    assert.ok((await provider.models()).every(m => m.contextLength === 0));

    assert.equal(text(await collect(await provider.generate('Teste', 'copilot/auto', false))), 'Olá do fixture');
    assert.equal(fixture.sends.at(-1).mode, 'smart'); assert.equal(guard.status().busy, false);
    assert.equal(text(await collect(await provider.generate('Pense', 'copilot/reasoning', false))), 'Olá do fixture');
    assert.equal(fixture.sends.at(-1).mode, 'reasoning');
    // The site keeps the last mode (sticky); it is reset before choosing another one.
    assert.equal(text(await collect(await provider.generate('Estude', 'copilot/study', false))), 'Olá do fixture');
    assert.equal(fixture.sends.at(-1).mode, 'study');
    await assert.rejects(() => provider.generate('x', 'copilot/search', false), (e: any) => e.status === 400 && /not selectable/.test(e.message));
    await assert.rejects(() => provider.generate('x', 'copilot/gpt-imaginary', false), (e: any) => e.status === 400);
    assert.equal(guard.status().busy, false);

    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'copilot/auto'); assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    assert.equal((await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'copilot/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) })).status, 400);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'copilot/auto', stream,
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
      const answer = stream ? body.split(/\r?\n\r?\n/).filter(b => b.startsWith('data: {')).map(b => JSON.parse(b.slice(6)).choices[0].delta.content ?? '').join('')
        : JSON.parse(body).choices[0].message.content;
      assert.equal(answer, 'Olá do fixture'); assert.doesNotMatch(body, /NOISE/);
      const prompt = fixture.sends.at(-1).content[0].text as string;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/);
      assert.match(prompt, /User: Primeiro turno/);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
      if (stream) assert.match(body, /data: \[DONE\]/);
      assert.equal(fixture.sends.at(-1).mode, 'smart', 'auto restores the default mode');
    }

    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'copilot/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 50 && guard.status().busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(guard.status().busy, false);

    fixture.limit = 10; const sent = fixture.sends.length;
    await assert.rejects(() => provider.generate('Um prompt maior que o limite do compositor', 'copilot/auto', false), (e: any) => e.status === 413);
    assert.equal(fixture.sends.length, sent, 'a truncated prompt is never sent'); fixture.limit = 20_000;

    fixture.failure = 'close';
    await assert.rejects(async () => collect(await provider.generate('Queda', 'copilot/auto', false)), (e: any) => e.status === 502 && /socket_closed/.test(e.message));
    assert.equal(guard.status().busy, false);

    // Disable fixture cooldown without sleeping; production still uses the normal guard.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    fixture.failure = 'throttled';
    await assert.rejects(async () => collect(await provider.generate('Limite', 'copilot/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true, 'a usage limit never clears login');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 110_000);
    assert.equal(guard.status().busy, false);

    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } }); Object.assign(provider, { state: 'authenticated' });
    fixture.failure = 'sign-in';
    await assert.rejects(async () => collect(await provider.generate('Expirada', 'copilot/auto', false)), (e: any) => e.status === 401);
    assert.equal(guard.status().block?.state, 'login_required');

    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } }); fixture.failure = undefined;
    fixture.tier = 'guest';
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Copilot login is required.', 401), 'copilot_login_required').error;
    assert.equal(error.help_url, 'https://copilot.microsoft.com/chats/new');
    assert.match(error.user_action, /Concluir login/); assert.match(error.user_action, /conta Microsoft/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Copilot browser capture claims only the matching send frame and blocks a mode mismatch', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const received: any[] = [];
    await context.routeWebSocket(/^wss:\/\/copilot\.microsoft\.com\/c\/api\/chat/, ws => ws.onMessage(raw => received.push(JSON.parse(String(raw)))));
    await context.addInitScript(installCopilotCapture);
    await context.route('https://copilot.microsoft.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>app</p>' }));
    const page = await context.newPage();
    await page.goto('https://copilot.microsoft.com/chats/new');
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      const socket = new WebSocket('wss://copilot.microsoft.com/c/api/chat?api-version=2');
      await new Promise(resolve => socket.addEventListener('open', resolve));
      scope.__proxyCopilot = { prompt: 'olá  mundo', mode: 'reasoning', chunks: [], messages: [], bytes: 0, claimed: false, done: false };
      socket.send(JSON.stringify({ event: 'setOptions' }));
      socket.send(JSON.stringify({ event: 'send', conversationId: 'c0', content: [{ type: 'text', text: 'outro prompt' }], mode: 'reasoning' }));
      const afterOther = scope.__proxyCopilot.claimed;
      socket.send(JSON.stringify({ event: 'send', conversationId: 'c1', content: [{ type: 'text', text: 'olá\n mundo' }], mode: 'smart' }));
      await new Promise(resolve => setTimeout(resolve, 100));
      return { afterOther, claimed: scope.__proxyCopilot.claimed, error: scope.__proxyCopilot.error, done: scope.__proxyCopilot.done };
    });
    assert.deepEqual(result, { afterOther: false, claimed: true, error: 'mode_mismatch', done: true });
    assert.deepEqual(received.map(frame => frame.conversationId ?? frame.event), ['setOptions', 'c0'], 'mismatched mode is never dispatched');
  } finally { await browser.close(); }
});

test('Copilot region block falls back to the Microsoft 365 Copilot app for login', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'copilot-m365-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new CopilotProvider();
  try {
    const launch = async () => {
      const context = await browser.newContext();
      // Observed 2026-11-06 for a signed-in account: the consumer app shows a region block.
      await context.route('https://copilot.microsoft.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1 data-testid="region-block-title">Indisponível na sua região</h1>' }));
      await context.route('https://copilot.com/**', route => route.fulfill({ contentType: 'text/html',
        body: '<main><span id="m365-chat-editor-target-element" role="textbox" contenteditable="true" style="display:inline-block;min-width:300px;min-height:24px" aria-label="Enviar uma mensagem para o Copilot"></span></main>' }));
      const page = await context.newPage();
      Object.assign(provider, { context, page });
      await (provider as any).navigate(); // the real launch ends by opening the chat
    };
    let humanRunning = true;
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; }, start: async () => { humanRunning = true; } };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true);
    assert.equal(new URL(provider.getActivePage()!.url()).origin, 'https://copilot.com');
    assert.deepEqual(await provider.models(), [{id:'copilot/auto',contextLength:0}]);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Copilot sign-in header shown before the region block still checks the Microsoft 365 app', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'copilot-m365-header-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new CopilotProvider();
  let signedIn = true, reopened = 0, humanRunning = true;
  try {
    const launch = async () => {
      const context = await browser.newContext();
      // Headful worker, 2026-11-06: the sign-in header rendered first, the region block 3 s later.
      await context.route('https://copilot.microsoft.com/**', route => route.fulfill({ contentType: 'text/html',
        body: '<button data-testid="sign-in-exp-chat-header-button">Entrar</button><script>setTimeout(() => { document.body.innerHTML = \'<h1 data-testid="region-block-title">Indisponível</h1>\'; }, 3000);</script>' }));
      await context.route('https://copilot.com/**', route => route.fulfill({ contentType: 'text/html', body: signedIn
        ? '<main><span id="m365-chat-editor-target-element" role="textbox" contenteditable="true" style="display:inline-block;min-width:300px;min-height:24px"></span></main>'
        : '<form><input type="email" name="loginfmt"></form>' }));
      const page = await context.newPage();
      Object.assign(provider, { context, page });
      await (provider as any).navigate();
    };
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; }, start: async () => { reopened++; humanRunning = true; } };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    signedIn = false;
    const started = Date.now();
    await assert.rejects(() => provider.finishLogin(), /Concluir login novamente/);
    assert.equal(reopened, 1);
    assert.ok(Date.now() - started < 20_000, 'a signed-out Microsoft 365 app ends at the sign-in form without the full timeout');
    signedIn = true;
    await provider.finishLogin();
    assert.equal(reopened, 1, 'the signed-in account must not reopen the login window');
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true);
    assert.equal(new URL(provider.getActivePage()!.url()).origin, 'https://copilot.com');
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Copilot early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'copilot-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new CopilotProvider();
  let reopened = 0, humanRunning = true;
  const fixture: Fixture = { tier: 'guest', reply: ['ok'], modes: ['smart'], sends: [], limit: 1000 };
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      await copilotFixture(context, fixture);
      await context.addInitScript(installCopilotCapture);
      const page = await context.newPage();
      await page.goto(COPILOT_CHAT_URL);
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.finishLogin(), /Concluir login novamente/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    fixture.tier = 'free';
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

test('Microsoft 365 composer: text goes through the editor state, Send dispatches it and the box empties', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const { fillM365Editor, m365Submitted } = await import('./providers/copilot.ts');
    // Like the real composer, the editor keeps its own state: DOM edits alone are not sent.
    await page.setContent(`<span id="m365-chat-editor-target-element" role="textbox" contenteditable="true" style="display:inline-block;min-width:300px;min-height:20px"></span>
      <button aria-label="Enviar">→</button>
      <script>let model='';const editor=document.querySelector('#m365-chat-editor-target-element');window.sent=[];
        editor.addEventListener('paste',e=>{e.preventDefault();model=e.clipboardData.getData('text/plain');editor.textContent=model;});
        editor.addEventListener('keydown',e=>{if(e.key==='Delete'||e.key==='Backspace'){model='';}});
        document.querySelector('button').onclick=()=>{if(!model)return;window.sent.push(model);model='';editor.textContent='';};
      </script>`);
    const editor = page.locator('#m365-chat-editor-target-element');
    const prompt = 'System: siga o formato.\n\nUser: Responda apenas: TESTE_PROXY_OK';
    await editor.click();
    await fillM365Editor(page, editor, prompt);
    await page.getByRole('button', { name: 'Enviar' }).click();
    assert.equal(await m365Submitted(page, editor, 2000), true);
    assert.deepEqual(await page.evaluate(() => (window as any).sent), [prompt]);
  } finally { await browser.close(); }
});
