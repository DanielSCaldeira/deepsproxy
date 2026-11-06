import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Route } from 'playwright';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import { geminiAuthenticated, geminiError, geminiLimitNotice, geminiModels, geminiModelSlug, geminiPromptMatches } from './providers/gemini-protocol.ts';
import { installGeminiCopyCapture } from './providers/gemini-browser.ts';
import { GeminiProvider } from './providers/gemini.ts';
import { getProvider } from './providers/registry.ts';
import { interactiveWorkerArguments } from './services/interactive-browser.ts';
import { getProfileDirectory } from './services/session-store.ts';
import { GenerationGuard, UpstreamError } from './services/generation-guard.ts';
import { apiError } from './utils/api-error.ts';

// Fixtures exercise behavior without waiting the production pacing intervals.
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';

const collect = async (source: AsyncIterable<any>) => { const values = []; for await (const value of source) values.push(value); return values; };

// Mode menu as captured from the public page on 2026-11-06 (signed out: only Flash Lite unlocked).
const capturedModes = [
  { label: '3.5 Flash Lite', disabled: false, checked: true },
  { label: '3.6 Flash', disabled: true, checked: false },
  { label: '3.1 Pro', disabled: true, checked: false },
  { label: '4 Argon', disabled: true, checked: false },
];

test('Gemini identity, routing, catalog and authentication evidence', () => {
  assert.equal(providerId('gemini'), 'gemini');
  assert.equal(providerIdForModel('gemini/auto'), 'gemini');
  assert.equal(providerIdForModel('gemini/3.6-flash'), 'gemini');
  assert.equal(providerIdForModel('chatgpt/auto'), 'chatgpt');
  assert.equal(geminiModelSlug(' 3.5 Flash Lite '), '3.5-flash-lite');
  assert.equal(geminiModelSlug('Raciocínio'), 'raciocinio');
  assert.deepEqual(geminiModels(capturedModes), [{ id: 'gemini/3.5-flash-lite', label: '3.5 Flash Lite', contextLength: 0 }]);
  assert.deepEqual(geminiModels([...capturedModes, { label: '3.5 Flash Lite', disabled: false, checked: false }, { label: 'Auto', disabled: false, checked: false }]).length, 1);
  // Signed-out /app (captured): sign-in link, no request token. A visible composer is not authentication.
  assert.equal(geminiAuthenticated({ status: 200, offOrigin: false, token: false, signInLink: true, accountLink: false }), false);
  assert.equal(geminiAuthenticated({ status: 200, offOrigin: false, token: true, signInLink: false, accountLink: true }), true);
  assert.equal(geminiAuthenticated({ status: 200, offOrigin: false, token: true, signInLink: true, accountLink: false }), false);
  // Real signed-in /app (2026-11-06): token and account menu, plus an add/switch-account ServiceLogin link.
  assert.equal(geminiAuthenticated({ status: 200, offOrigin: false, token: true, signInLink: true, accountLink: true }), true);
  assert.equal(geminiAuthenticated({ status: 200, offOrigin: true, token: true, signInLink: false, accountLink: true }), false);
  assert.equal(geminiAuthenticated({ status: 500, offOrigin: false, token: true, signInLink: false, accountLink: true }), false);
  // The rendered user turn (captured) prefixes "Você disse" and splits paragraphs.
  const prompt = 'Repita exatamente:\n---\n**negrito** e _ita_ \n<tool_call>{"name":"read_file"}</tool_call>';
  assert.equal(geminiPromptMatches('Você disse Repita exatamente: --- **negrito**…\n\nRepita exatamente:\n\n---\n\n**negrito** e _ita_\n\n<tool_call>{"name":"read_file"}</tool_call>', prompt), true);
  assert.equal(geminiPromptMatches('Você disse Outro pedido', prompt), false);
  assert.equal(geminiLimitNotice('Você atingiu o limite do 3.1 Pro. Tente novamente amanhã.'), true);
  assert.equal(geminiLimitNotice('Algo deu errado.'), false);
  assert.equal(geminiError(429).status, 429); assert.equal(geminiError(0, 'usage_limit').status, 429);
  assert.equal(geminiError(403).status, 403); assert.doesNotMatch(geminiError(403).message, /login|suspend/);
  const args = interactiveWorkerArguments('/profile', 'https://gemini.google.com/app');
  assert.equal(args.at(-1), 'https://gemini.google.com/app'); assert.ok(!args.some(a => a.includes('remote-debugging')));
  const previous = { provider: process.env.PROVIDER, dir: process.env.GEMINI_PROFILE_DIR, shared: process.env.PROVIDER_PROFILE_DIR };
  try {
    delete process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER = 'gemini'; process.env.GEMINI_PROFILE_DIR = 'gemini-fixture-profile';
    assert.equal(path.basename(getProfileDirectory()), 'gemini-fixture-profile');
    process.env.PROVIDER_PROFILE_DIR = '/profile';
    assert.equal(path.resolve(getProfileDirectory()), path.resolve('/profile'));
  } finally {
    for (const [key, value] of [['PROVIDER', previous.provider], ['GEMINI_PROFILE_DIR', previous.dir], ['PROVIDER_PROFILE_DIR', previous.shared]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Gemini copy capture keeps only the armed copy and leaves other copies to the site', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gemini.google.com' });
    await context.addInitScript(installGeminiCopyCapture);
    const page = await context.newPage();
    await page.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Gemini</body></html>' }));
    await page.goto('https://gemini.google.com/app');
    const result = await page.evaluate(async () => {
      const scope = globalThis as any;
      scope.__proxyGemini = { armed: false, copied: null };
      // Not armed: the site's own clipboard path runs unchanged.
      await navigator.clipboard.writeText('não capturar');
      const notArmed = scope.__proxyGemini.copied;
      const passthrough = await navigator.clipboard.readText();
      scope.__proxyGemini.armed = true;
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob(['<b>x</b>'], { type: 'text/html' }),
        'text/plain': new Blob(['**x**\n```js\nconsole.log(1)\n```'], { type: 'text/plain' }) })]);
      return { notArmed, copied: scope.__proxyGemini.copied, armedAfter: scope.__proxyGemini.armed, passthrough };
    });
    assert.equal(result.notArmed, null); assert.equal(result.passthrough, 'não capturar');
    assert.equal(result.copied, '**x**\n```js\nconsole.log(1)\n```');
    assert.equal(result.armedAfter, false, 'a capture is consumed once');
  } finally { await browser.close(); }
});

/** Minimal Gemini frontend reproducing the captured composer, turn and completion signals. */
function fixtureHtml(options: { answer: string; limit: boolean; foreignTurn: boolean; slow: boolean }): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div id="chat"></div>
  <input-area-v2>
    <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox" aria-label="Insira um comando para o Gemini"></div></rich-textarea>
    <bard-mode-switcher><button data-test-id="bard-mode-menu-button" type="button" aria-label="Abrir seletor de modo. No momento: Flash-Lite">Flash-Lite</button></bard-mode-switcher>
    <span id="controls"></span>
  </input-area-v2>
  <div class="cdk-overlay-container"></div>
  <script>
    const answer = ${JSON.stringify(options.answer)};
    const editor = document.querySelector('[role=textbox]');
    const controls = document.getElementById('controls');
    const modes = [['3.5 Flash Lite', false], ['3.6 Flash', false], ['3.1 Pro', true]];
    document.querySelector('[data-test-id=bard-mode-menu-button]').onclick = () => {
      const overlay = document.querySelector('.cdk-overlay-container');
      overlay.innerHTML = '<gem-menu role="menu">' + modes.map(([label, locked], index) =>
        '<gem-menu-item role="menuitemradio" data-test-id="bard-mode-option-' + (locked ? '' : 'm' + index) + '" aria-disabled="' + locked + '" aria-checked="' + (index === 0) + '"><span class="label"> ' + label + ' </span><div class="sublabel">desc</div></gem-menu-item>').join('') + '</gem-menu>';
      overlay.querySelectorAll('gem-menu-item').forEach(item => item.onclick = () => {
        if (item.getAttribute('aria-disabled') === 'true') return;
        fetch('/fixture/mode', { method: 'POST', body: item.querySelector('.label').textContent.trim() });
        overlay.innerHTML = '';
      });
    };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('.cdk-overlay-container').innerHTML = ''; });
    editor.addEventListener('input', () => {
      controls.innerHTML = editor.innerText.trim() ? '<button aria-label="Enviar mensagem" class="send-button">Enviar</button>' : '';
      const send = controls.querySelector('button');
      if (send) send.onclick = submit;
    });
    function submit() {
      const prompt = editor.innerText;
      fetch('/fixture/prompt', { method: 'POST', body: prompt });
      history.pushState(null, '', '/app/fixture' + Date.now());
      const chat = document.getElementById('chat');
      const user = document.createElement('user-query');
      user.innerText = 'Você disse ' + (${options.foreignTurn} ? 'outra pergunta' : prompt);
      const response = document.createElement('model-response');
      response.innerHTML = '<message-content><div class="markdown" aria-busy="true"></div></message-content>';
      chat.append(user, response);
      controls.innerHTML = '<button aria-label="Parar resposta" class="send-button stop">Parar</button>';
      controls.querySelector('button').onclick = () => { window.stopped = true; fetch('/fixture/stop', { method: 'POST' }); };
      if (${options.limit}) {
        setTimeout(() => {
          controls.innerHTML = '';
          document.body.insertAdjacentHTML('beforeend', '<mat-snack-bar-container><simple-snack-bar>Você atingiu o limite de uso. Tente novamente amanhã.</simple-snack-bar></mat-snack-bar-container>');
        }, 100);
        return;
      }
      setTimeout(() => {
        if (window.stopped) return;
        response.querySelector('.markdown').textContent = answer.replace(/[*\`]/g, '');
        controls.innerHTML = '';
      }, ${options.slow ? 5000 : 150});
      setTimeout(() => {
        if (window.stopped) return;
        response.querySelector('.markdown').setAttribute('aria-busy', 'false');
        response.insertAdjacentHTML('beforeend', '<message-actions><copy-button><button aria-label="Copiar">copy</button></copy-button></message-actions>');
        response.querySelector('copy-button button').onclick = () => navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob(['<p>html</p>'], { type: 'text/html' }), 'text/plain': new Blob([answer], { type: 'text/plain' }) })]);
      }, ${options.slow ? 5400 : 350});
    }
  </script></body></html>`;
}

test('Gemini frontend fixture: login evidence, catalog, generation, tools, cancellation, quota and expiry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-fixture-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const previousProvider = process.env.PROVIDER; process.env.PROVIDER = 'gemini';
  const browser = await chromium.launch();
  const provider = getProvider() as GeminiProvider;
  try {
    const context = await browser.newContext();
    await context.addInitScript(installGeminiCopyCapture);
    const page = await context.newPage();
    const options = { answer: 'Olá do fixture **Gemini**\n```js\nconsole.log(1)\n```', limit: false, foreignTurn: false, slow: false };
    let authenticated = true;
    const prompts: string[] = [], modes: string[] = [];
    let stops = 0;
    const guard = new GenerationGuard(undefined, Date.now, () => 0, async () => {});
    Object.assign(provider, { context, page, guard });
    await page.route('https://gemini.google.com/**', async (route: Route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/fixture/prompt') { prompts.push(request.postData() || ''); return route.fulfill({ status: 204 }); }
      if (pathname === '/fixture/mode') { modes.push(request.postData() || ''); return route.fulfill({ status: 204 }); }
      if (pathname === '/fixture/stop') { stops++; return route.fulfill({ status: 204 }); }
      if (request.resourceType() === 'fetch') {
        // In-page authentication probe of /app: markers only, as in the captured HTML.
        return route.fulfill({ contentType: 'text/html', body: authenticated
          ? '<script>WIZ_global_data={"SNlM0e":"fixture-token","cfb2h":"fixture"}</script><a href="https://accounts.google.com/SignOutOptions?hl=pt-BR">Conta</a>'
          : '<script>WIZ_global_data={"cfb2h":"fixture"}</script><a href="https://accounts.google.com/ServiceLogin?continue=x">Fazer login</a>' });
      }
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml(options) });
    });
    await page.goto('https://gemini.google.com/app');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).authenticated, true);
    assert.deepEqual(await provider.models(), [{ id: 'gemini/auto', contextLength: 0 },
      { id: 'gemini/3.5-flash-lite', contextLength: 0 }, { id: 'gemini/3.6-flash', contextLength: 0 }]);

    const result = await collect(await provider.generate('Teste\n\ncom parágrafos', 'gemini/auto', false));
    assert.deepEqual(result, [{ type: 'content', text: options.answer }, { type: 'finish' }]);
    // A plain contenteditable reports paragraph breaks loosely; the text itself is unchanged.
    assert.equal(prompts.at(-1)!.replace(/\n+/g, '\n'), 'Teste\ncom parágrafos'); assert.deepEqual(modes, []);
    assert.equal(guard.status().busy, false);

    await collect(await provider.generate('Modo explícito', 'gemini/3.6-flash', false));
    assert.deepEqual(modes, ['3.6 Flash']);
    const sent = prompts.length;
    await assert.rejects(() => provider.generate('Bloqueado', 'gemini/3.1-pro', false), (e: any) => e.status === 400 && /not selectable/.test(e.message));
    assert.equal(prompts.length, sent, 'a locked mode never sends the prompt');
    assert.equal(guard.status().busy, false);

    // Shared serializer and tool protocol through the worker API.
    options.answer = '<tool_call>{"name":"lookup","arguments":{"query":"teste_1"}}</tool_call>';
    const { app } = await import('./index.ts');
    const headers = { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) };
    const models = await (await app.request('/v1/models', { headers })).json();
    assert.equal(models.data[0].id, 'gemini/auto'); assert.equal(models.data[0].context_limit_source, 'unknown');
    assert.equal(models.data[0].max_output_tokens, undefined);
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'Read the requested information.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }];
    for (const stream of [false, true]) {
      const response = await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'gemini/auto', stream, tools,
        messages: [{ role: 'system', content: 'IDE rules: use the supplied tools.' }, { role: 'user', content: 'Procure teste_1' }] }) });
      assert.equal(response.status, 200);
      const text = await response.text();
      if (stream) { assert.match(text, /"tool_calls"/); assert.match(text, /data: \[DONE\]/); }
      else {
        const body = JSON.parse(text);
        assert.equal(body.choices[0].finish_reason, 'tool_calls');
        assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { query: 'teste_1' });
      }
      assert.match(prompts.at(-1)!, /^IDE rules: use the supplied tools\./);
      assert.match(prompts.at(-1)!, /Tools:.*"name":"lookup"/s);
      assert.match(prompts.at(-1)!, /User: Procure teste_1/);
    }
    const rejected = await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'gemini/auto',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }) });
    assert.equal(rejected.status, 400);
    const effort = await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'gemini/auto', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x' }] }) });
    assert.equal(effort.status, 400);

    // Cancellation before the body is consumed stops the site and releases the queue.
    options.slow = true;
    const abort = new AbortController();
    await provider.generate('Cancelar sem consumir', 'gemini/auto', false, abort.signal);
    abort.abort();
    for (let i = 0; i < 100 && (guard.status().busy || stops === 0); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(guard.status().busy, false); assert.equal(stops, 1);
    options.slow = false;

    // A different rendered turn is never treated as this prompt's answer, nor resent.
    options.foreignTurn = true;
    const before = prompts.length;
    await assert.rejects(async () => collect(await provider.generate('Minha pergunta', 'gemini/auto', false)), (e: any) => e.status === 502);
    assert.equal(prompts.length, before + 1); options.foreignTurn = false;

    options.limit = true;
    Object.assign(guard, { saved: { nextAllowedAt: 0, block: null } });
    await assert.rejects(async () => collect(await provider.generate('Teste', 'gemini/auto', false)), (e: any) => e.status === 429);
    assert.equal((await provider.status()).state, 'rate_limited');
    assert.equal((await provider.status()).authenticated, true, 'a usage limit keeps the login');
    assert.ok(Date.parse(guard.status().nextAllowedAt!) >= Date.now() + 59_000);
    assert.equal(guard.status().busy, false);

    authenticated = false;
    await assert.rejects(() => provider.confirmLogin(), (e: any) => e.status === 401);
    assert.equal((await provider.status()).authenticated, false);
    const error = apiError(new UpstreamError('Gemini login is required.', 401), 'gemini_login_required').error;
    assert.equal(error.help_url, 'https://gemini.google.com/app');
    assert.match(error.user_action, /conta Google/); assert.match(error.user_action, /Concluir login/);
    assert.doesNotMatch(error.user_action, /DeepSeek|bloqueado em navegadores/);
  } finally {
    await provider.close(); await browser.close();
    if (previous === undefined) delete process.env.PROVIDER_PROFILE_DIR; else process.env.PROVIDER_PROFILE_DIR = previous;
    if (previousProvider === undefined) delete process.env.PROVIDER; else process.env.PROVIDER = previousProvider;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Gemini early manual confirmation reopens Google sign-in and success saves the same profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-login-'));
  const previous = process.env.PROVIDER_PROFILE_DIR; process.env.PROVIDER_PROFILE_DIR = directory;
  const browser = await chromium.launch();
  const provider = new GeminiProvider();
  let authenticated = false, reopened = 0, humanRunning = true;
  try {
    const fake = { get running() { return humanRunning; }, close: async () => { humanRunning = false; },
      start: async () => { reopened++; humanRunning = true; } };
    const launch = async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: authenticated
        ? '<script>WIZ_global_data={"SNlM0e":"fixture"}</script><a href="https://accounts.google.com/SignOutOptions">Conta</a>'
        : '<a href="https://accounts.google.com/ServiceLogin">Fazer login</a><div role="textbox" contenteditable="true"></div>' }));
      await page.goto('https://gemini.google.com/app');
      Object.assign(provider, { context, page });
    };
    Object.assign(provider, { manualLogin: true, interactive: fake, launch });
    // The anonymous composer exists before sign-in; it must not count as login.
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
