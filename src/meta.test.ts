import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { classifyMetaPage, metaError, metaEvents, metaModels, metaTurnProgress, type MetaTurnSnapshot } from './providers/meta-protocol.ts';
import { inspectMetaPage, installMetaCapture, readMetaTurn } from './providers/meta-browser.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { MetaProvider } from './providers/meta.ts';
import { getProvider } from './providers/registry.ts';
import { apiError } from './utils/api-error.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';
import type { ProviderEvent } from './providers/types.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };
const page = (overrides: Partial<Parameters<typeof classifyMetaPage>[0]> = {}) => ({
  url: 'https://www.meta.ai/', userMenu: false, loginButton: false, composer: true, notices: '', regionNotice: null, ...overrides });
const turn = (overrides: Partial<MetaTurnSnapshot> = {}): MetaTurnSnapshot => ({
  userFound: true, assistantId: 'a1', state: 'STREAMING', complete: false, text: '', notices: '', loginButton: false, ...overrides });

// Sanitized from the logged-out landing captured on 2026-11-06 (.cache/meta/public/02-hydrated.html).
const LANDING = `<header><a data-testid="new-chat-button" href="/"></a><button type="button">Download app</button>
  <button data-testid="login-button">Log in</button></header>
  <div data-testid="landing-hero-content">Meta AI, the personal assistant that</div>
  <input type="text" aria-label="Ask Meta AI" placeholder="Ask Meta AI anything...">
  <button aria-label="Add attachment" data-testid="composer-add-attachment-button"></button><button aria-label="Send" disabled></button>`;
// Dialog shown to visitors after pressing Send (captured; the proxy never accepts it).
const VISITOR_DIALOG = `Welcome to Meta AI\nProviding your birthday helps make sure you get the right experience for your age.`;

test('Meta catalog, routing, page classification and error mapping', () => {
  assert.equal(providerId('meta'), 'meta'); assert.equal(providerIdForModel('meta/auto'), 'meta');
  assert.equal(providerIdForModel('meta/think_hard'), 'meta'); assert.equal(providerIdForModel('metaverse'), null);
  assert.equal(providerIdForModel('chatgpt/auto'), 'chatgpt');
  const args = interactiveWorkerArguments('/profile', 'https://www.meta.ai/');
  assert.equal(args.at(-1), 'https://www.meta.ai/'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  // The visitor composer is never accepted as authentication.
  assert.deepEqual(classifyMetaPage(page({ loginButton: true })), { state: 'login_required', message: null });
  assert.equal(classifyMetaPage(page()), null, 'still hydrating');
  assert.deepEqual(classifyMetaPage(page({ userMenu: true })), { state: 'authenticated' });
  assert.equal(classifyMetaPage(page({ url: 'https://auth.meta.com/?redirect_uri=x' }))!.state, 'login_required');
  assert.equal(classifyMetaPage(page({ userMenu: true, notices: VISITOR_DIALOG }))!.state, 'login_required');
  assert.equal(classifyMetaPage(page({ userMenu: true, notices: "You've reached the message limit" }))!.state, 'rate_limited');
  const region = classifyMetaPage(page({ regionNotice: "Meta AI isn't available yet in your country" }));
  assert.equal(region!.state, 'unavailable');
  assert.equal(metaError('login').status, 401); assert.equal(metaError('limit').status, 429); assert.equal(metaError('region').status, 503);
  assert.deepEqual(metaModels([
    { testId: 'composer-mode-option-think_fast', label: 'Fast', disabled: false },
    { testId: 'composer-mode-option-think_hard', label: 'Thinking', disabled: false },
    { testId: 'composer-mode-option-think_hard', label: 'Duplicate', disabled: false },
    { testId: 'composer-mode-option-think_locked', label: 'Locked', disabled: true },
    { testId: 'composer-mode-option-imagine', label: 'Imagine', disabled: false },
    { testId: 'composer-mode-option-THINK_x"]', label: 'Injected', disabled: false },
  ]), [{ id: 'meta/think_fast', label: 'Fast', contextLength: 0 }, { id: 'meta/think_hard', label: 'Thinking', contextLength: 0 }]);
});

test('Meta turn states: streaming waits, completion, errors, limits and login walls', () => {
  assert.equal(metaTurnProgress(turn({ state: 'INIT' })).kind, 'waiting');
  assert.equal(metaTurnProgress(turn({ state: 'STREAMING', text: 'parcial', complete: false })).kind, 'waiting');
  assert.deepEqual(metaTurnProgress(turn({ state: 'DONE', text: 'Olá' })), { kind: 'done', text: 'Olá' });
  const expect = (value: ReturnType<typeof metaTurnProgress>, status: number) => {
    assert.equal(value.kind, 'error'); assert.equal((value as any).error.status, status);
  };
  expect(metaTurnProgress(turn({ state: 'DONE', text: '  ' })), 502);
  expect(metaTurnProgress(turn({ state: 'ERROR', text: "You've reached the message limit" })), 429);
  expect(metaTurnProgress(turn({ state: 'ERROR', text: 'Something went wrong. Please try again.' })), 502);
  expect(metaTurnProgress(turn({ state: 'STOPPED', text: 'meio' })), 502);
  expect(metaTurnProgress(turn({ userFound: false, state: null, notices: VISITOR_DIALOG })), 401);
  expect(metaTurnProgress(turn({ loginButton: true })), 401);
  expect(metaTurnProgress(turn({ notices: "You're sending too many requests." })), 429);
  assert.deepEqual([...metaEvents('texto')], [{ type: 'content', text: 'texto' }, { type: 'finish' }]);
  assert.throws(() => [...metaEvents('')], UpstreamError);
});

test('Meta page inspection reads the captured visitor landing and clipboard capture is scoped', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(installMetaCapture);
    const page = await context.newPage();
    await page.route('https://www.meta.ai/**', route => route.fulfill({ contentType: 'text/html', body: LANDING }));
    await page.goto('https://www.meta.ai/');
    const snapshot = await page.evaluate(inspectMetaPage);
    assert.equal(snapshot.loginButton, true); assert.equal(snapshot.userMenu, false); assert.equal(snapshot.composer, true);
    assert.equal(classifyMetaPage(snapshot)!.state, 'login_required');
    const copied = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyMeta = { copying: true, copied: null };
      await navigator.clipboard.writeText('raw **markdown**');
      const first = scope.__proxyMeta.copied;
      scope.__proxyMeta = { copying: true, copied: null };
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['via write'], { type: 'text/plain' }) })]);
      return [first, scope.__proxyMeta.copied];
    });
    assert.deepEqual(copied, ['raw **markdown**', 'via write']);
    // Without an active capture the original clipboard is used (headless rejects without permission).
    const passthrough = await page.evaluate(async () => {
      delete (globalThis as any).__proxyMeta;
      try { await navigator.clipboard.writeText('user copy'); return 'written'; } catch { return 'original-called'; }
    });
    assert.ok(['written', 'original-called'].includes(passthrough));
  } finally { await browser.close(); }
});

type Scenario = { raw: string; rendered: string; final: 'DONE' | 'ERROR' | 'hang'; copy: boolean };
function signedInPage(scenario: Scenario, authenticated: boolean): string {
  if (!authenticated) return LANDING;
  return `<aside><div data-testid="user-menu-button" tabindex="0">Conta</div></aside>
  <main id="conversation"><div data-message-item data-message-id="old-a" data-message-role="assistant" role="article">
    <div data-testid="assistant-message" data-streaming-state="DONE"><div class="prose">Conversa anterior</div></div></div></main>
  <div id="composer">
    <button type="button" data-testid="composer-mode-dropdown-button">Modo</button>
    <div id="menu" role="menu" hidden>
      <div role="menuitemcheckbox" data-testid="composer-mode-option-think_fast" aria-checked="false">Fast\n<small>Answers quickly</small></div>
      <div role="menuitemcheckbox" data-testid="composer-mode-option-think_hard" aria-checked="false">Thinking</div>
      <div role="menuitemcheckbox" data-testid="composer-mode-option-imagine" aria-checked="false">Imagine</div>
      <div role="menuitemcheckbox" data-testid="composer-mode-option-think_locked" data-disabled="" aria-disabled="true">Locked</div>
    </div>
    <div data-testid="composer-input" contenteditable="true" role="textbox"></div>
    <button data-testid="composer-send-button" aria-label="Send" disabled>Enviar</button>
    <button data-testid="composer-stop-button" aria-label="Stop" hidden>Parar</button>
  </div>
  <script>
    const scenario = ${JSON.stringify(scenario)};
    const $ = selector => document.querySelector(selector);
    const mode = localStorage.getItem('mode') || 'think_fast';
    for (const option of document.querySelectorAll('[role=menuitemcheckbox]')) {
      option.setAttribute('aria-checked', String(option.dataset.testid === 'composer-mode-option-' + mode));
      option.onclick = () => { if (option.hasAttribute('data-disabled')) return;
        localStorage.setItem('mode', option.dataset.testid.replace('composer-mode-option-', ''));
        for (const other of document.querySelectorAll('[role=menuitemcheckbox]')) other.setAttribute('aria-checked', String(other === option));
        $('#menu').hidden = true; };
    }
    $('[data-testid=composer-mode-dropdown-button]').onclick = () => { $('#menu').hidden = !$('#menu').hidden; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#menu').hidden = true; });
    $('[data-testid=composer-input]').addEventListener('input', () => { $('[data-testid=composer-send-button]').disabled = !$('[data-testid=composer-input]').innerText.trim(); });
    $('[data-testid=composer-send-button]').onclick = async () => {
      const prompt = $('[data-testid=composer-input]').innerText;
      await fetch('/__fixture/sent', { method: 'POST', body: JSON.stringify({ prompt, mode: localStorage.getItem('mode') || 'think_fast' }) });
      const user = document.createElement('div');
      Object.assign(user.dataset, { messageItem: '', messageId: 'u-new', messageRole: 'user', userMessage: '' }); user.textContent = prompt;
      const row = document.createElement('div');
      Object.assign(row.dataset, { messageItem: '', messageId: 'a-new', messageRole: 'assistant' });
      row.innerHTML = '<div data-testid="assistant-message" data-streaming-state="INIT"><div class="prose"></div></div>' +
        (scenario.copy ? '<button aria-label="Copy response">Copiar</button>' : '');
      $('#conversation').append(user, row);
      const message = row.querySelector('[data-testid=assistant-message]');
      const copy = row.querySelector('button'); if (copy) copy.onclick = () => navigator.clipboard.writeText(scenario.raw);
      const stop = $('[data-testid=composer-stop-button]');
      stop.hidden = false; stop.onclick = () => { message.dataset.streamingState = 'STOPPED'; stop.hidden = true; fetch('/__fixture/stopped', { method: 'POST' }); };
      setTimeout(() => { if (message.dataset.streamingState !== 'INIT') return; message.dataset.streamingState = 'STREAMING'; message.querySelector('.prose').textContent = scenario.rendered.slice(0, 4); }, 50);
      if (scenario.final !== 'hang') setTimeout(() => {
        if (message.dataset.streamingState === 'STOPPED') return;
        message.dataset.streamingState = scenario.final; message.dataset.streamingComplete = 'true';
        message.querySelector('.prose').textContent = scenario.rendered; stop.hidden = true;
      }, 250);
    };
  </script>`;
}

async function fixture(run: (state: { provider: MetaProvider; page: Page; guard: GenerationGuard; scenario: Scenario; sent: Array<{ prompt: string; mode: string }>;
  stops: () => number; setAuthenticated: (value: boolean) => void }) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'meta-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'meta';
  const browser = await chromium.launch();
  const provider = getProvider() as MetaProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installMetaCapture);
    const page = await context.newPage();
    const scenario: Scenario = { raw: '', rendered: '', final: 'DONE', copy: true };
    const sent: Array<{ prompt: string; mode: string }> = [];
    let authenticated = true, stopped = 0;
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://www.meta.ai/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/__fixture/sent') { sent.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); }
      if (pathname === '/__fixture/stopped') { stopped++; return route.fulfill({ json: {} }); }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: signedInPage(scenario, authenticated) });
    });
    await page.goto('https://www.meta.ai/');
    await run({ provider, page, guard, scenario, sent, stops: () => stopped, setAuthenticated: value => { authenticated = value; } });
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
}

test('Meta frontend fixture: signed-in account, modes, raw answer, IDE prompt, limit, cancel and expiry', async () => {
  await fixture(async ({ provider, page, guard, scenario, sent, stops, setAuthenticated }) => {
    await provider.confirmLogin(true);
    const status = await provider.status();
    assert.equal(status.authenticated, true); assert.equal(status.sessionSaved, true); assert.equal(status.state, 'authenticated');
    assert.deepEqual(await provider.models(), [{ id: 'meta/auto', contextLength: 0 }, { id: 'meta/think_fast', contextLength: 0 }, { id: 'meta/think_hard', contextLength: 0 }]);
    assert.equal(await page.locator('#menu').isHidden(), true, 'model discovery closes the menu');

    // The copy action returns the answer source; the rendered DOM drops the tool markers.
    const raw = 'Resposta **final**\n<tool_call>{"name":"lookup","arguments":{"query":"teste"}}</tool_call>';
    Object.assign(scenario, { raw, rendered: 'Resposta final', final: 'DONE', copy: true });
    const events: ProviderEvent[] = await collect(await provider.generate('Linha 1\nLinha 2', 'meta/auto', false));
    assert.deepEqual(events, [{ type: 'content', text: raw }, { type: 'finish' }]);
    assert.match(sent.at(-1)!.prompt, /Linha 1\s+Linha 2/); assert.equal(guard.status().busy, false);
    const parsed = await parseProviderStreamToOpenAI((async function* () { yield* events; })(), 'chatcmpl-fixture', 'meta/auto', 10,
      [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }]);
    assert.equal(parsed.toolCalls[0].function.name, 'lookup');
    assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'teste' });

    // Explicit modes are selected and verified before sending; unknown/locked modes fail.
    Object.assign(scenario, { raw: 'Pensado', rendered: 'Pensado' });
    assert.equal((await collect(await provider.generate('Pense', 'meta/think_hard', false)))[0].text, 'Pensado');
    assert.equal(sent.at(-1)!.mode, 'think_hard');
    const before = sent.length;
    await assert.rejects(async () => collect(await provider.generate('x', 'meta/think_locked', false)), (e: any) => e.status === 400);
    await assert.rejects(async () => collect(await provider.generate('x', 'meta/imagine', false)), (e: any) => e.status === 400);
    assert.equal(sent.length, before, 'a rejected mode never sends'); assert.equal(guard.status().busy, false);

    // Without the copy action, the rendered answer is used.
    Object.assign(scenario, { raw: 'ignored', rendered: 'Somente renderizado', copy: false });
    assert.equal((await collect(await provider.generate('Sem cópia', 'meta/auto', false)))[0].text, 'Somente renderizado');

    // OpenAI route: shared serialization reaches the site's composer.
    Object.assign(scenario, { raw: 'Olá do fixture', rendered: 'Olá do fixture', copy: true });
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'meta/auto'); assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'meta/auto', stream,
          tools: [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
          messages: [
            { role: 'system', content: 'IDE rules: preserve files and use the supplied tools.' },
            { role: 'user', content: 'Primeiro turno' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'call-fixture', content: 'Resultado da ferramenta' },
            { role: 'user', content: 'Continue' },
          ] }) });
      assert.equal(response.status, 200); assert.match(await response.text(), /Olá do fixture/);
      const prompt = sent.at(-1)!.prompt;
      assert.match(prompt, /^IDE rules: preserve files and use the supplied tools\./);
      assert.match(prompt, /Tools:.*"name":"lookup"/); assert.match(prompt, /User: Primeiro turno/);
      assert.match(prompt, /Tool Response \(call-fixture\): Resultado da ferramenta/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: 'meta/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(rejected.status, 400);

    // Cancelling without consuming the body stops the response and releases the queue.
    Object.assign(scenario, { final: 'hang' });
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'meta/auto', false, abort.signal);
    await page.locator('[data-testid=composer-stop-button]').waitFor({ state: 'visible' });
    abort.abort();
    for (let i = 0; i < 100 && (guard.status().busy || !stops()); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(guard.status().busy, false); assert.equal(stops(), 1);

    // Usage limit keeps the login and defers the next attempt.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    Object.assign(scenario, { final: 'ERROR', rendered: "You've reached the message limit", copy: false });
    await assert.rejects(async () => collect(await provider.generate('Limite', 'meta/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited'); assert.equal((await provider.status()).authenticated, true);
    assert.ok(Date.parse(guard.status().nextAllowedAt!) > Date.now() + 60_000); assert.equal(guard.status().busy, false);

    // Expired session: the visitor landing is a login requirement, never an authenticated chat.
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    setAuthenticated(false);
    await page.goto('https://www.meta.ai/');
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Meta AI login is required.', 401), 'meta_login_required').error;
    assert.equal(error.help_url, 'https://www.meta.ai/'); assert.match(error.user_action, /Concluir login/);
    assert.match(error.user_action, /Facebook, Instagram ou conta Meta/); assert.doesNotMatch(error.user_action, /DeepSeek|Google/);
  });
});

test('Meta turn reader only follows the proxy message after previous rows', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-message-item data-message-id="u0" data-message-role="user" data-user-message>Antigo</div>
      <div data-message-item data-message-id="a0" data-message-role="assistant"><div data-testid="assistant-message" data-streaming-state="DONE"><div class="prose">Velha</div></div></div>
      <div data-message-item data-message-id="u1" data-message-role="user" data-user-message>Novo</div>
      <div data-message-item data-message-id="a1" data-message-role="assistant"><div data-testid="assistant-message" data-streaming-state="STREAMING" data-streaming-complete="false"><div class="prose">Nov</div></div></div>`);
    const current = await page.evaluate(readMetaTurn, ['u0', 'a0']);
    assert.deepEqual({ ...current, notices: '' }, { userFound: true, assistantId: 'a1', state: 'STREAMING', complete: false, text: 'Nov', notices: '', loginButton: false });
    const none = await page.evaluate(readMetaTurn, ['u0', 'a0', 'u1', 'a1']);
    assert.equal(none.userFound, false); assert.equal(none.assistantId, null);
  } finally { await browser.close(); }
});

test('Meta early manual confirmation reopens login and successful confirmation saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'meta-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new MetaProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://www.meta.ai/**', route => route.fulfill({ contentType: 'text/html',
        body: authenticated ? '<div data-testid="user-menu-button">Conta</div><div data-testid="composer-input" contenteditable="true"></div>' : LANDING }));
      await page.goto('https://www.meta.ai/');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    await assert.rejects(() => provider.finishLogin(), /Concluir login novamente/);
    assert.equal(reopened, 1); assert.equal((await provider.status()).confirmationRequired, true);
    authenticated = true;
    await provider.finishLogin();
    const status = await provider.status();
    assert.equal(status.state, 'authenticated'); assert.equal(status.sessionSaved, true); assert.equal(status.authenticated, true);
    assert.equal(humanRunning, false);
    const active = provider.getActivePage(); await provider.initialize(false); assert.equal(provider.getActivePage(), active);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
