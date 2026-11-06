import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { panelPage } from './production/panel.ts';

// "Conectar pendentes" opens every service that is not logged in, one after another, and frees each
// browser (sleep) once its session is saved so the next login fits in the browser capacity.
test('production panel: sequential login opens pending services one by one', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let loggedIn = false;
    type Fixture = { name: string; state: string; login: boolean; saved: boolean; manual?: boolean };
    const accounts: Record<string, Fixture> = {
      deepseek: { name: 'DeepSeek', state: 'authenticated', login: false, saved: true, manual: true },
      claude: { name: 'Claude', state: 'not_initialized', login: false, saved: false, manual: true },
      qwen: { name: 'Qwen', state: 'login_required', login: false, saved: false },
      grok: { name: 'Grok', state: 'not_initialized', login: false, saved: false, manual: true },
      perplexity: { name: 'Perplexity', state: 'suspended', login: false, saved: false, manual: true },
    };
    const actions: string[] = [];
    const script = await readFile(new URL('../public/panel.js', import.meta.url), 'utf8');
    await page.route('https://proxy.test/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: panelPage });
      if (path === '/assets/panel.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path === '/novnc/core/rfb.js') return route.fulfill({ contentType: 'text/javascript', body: 'export default class RFB extends EventTarget { constructor(target) { super(); target.append(document.createElement("canvas")); } disconnect() {} }' });
      if (path === '/api/auth/state') return json({ setupRequired: false });
      if (path === '/api/auth/login') { loggedIn = true; return json({ csrf: 'csrf-test' }); }
      if (!loggedIn) return json({ error: { message: 'Entre no painel.' } }, 401);
      if (path === '/api/me') return json({ id: 'alice', email: 'alice@example.com', role: 'user', csrf: 'csrf-test' });
      if (path === '/api/me/keys') return json({ keys: [] });
      if (path === '/api/me/accounts') return json({ accounts: Object.entries(accounts).map(([provider, a]) => ({
        id: provider, provider, name: a.name, manualLoginConfirmation: a.manual === true, accountState: a.state,
        authenticated: a.state === 'authenticated', sessionSaved: a.saved, loginActive: a.login, runtimeState: 'running', models: [] })) });
      if (path.startsWith('/api/me/operations/')) {
        const [, provider, action] = path.slice('/api/me/operations/'.length).split('.');
        if (action === 'finish') Object.assign(accounts[provider], { state: 'authenticated', saved: true, login: false });
        return json({ status: 'done' });
      }
      const match = /^\/api\/me\/accounts\/(\w+)\/(connection\/(\w+)|remote-ticket)$/.exec(path);
      if (match) {
        const [, provider, , action] = match;
        if (!action) return json({ ticket: provider + '-ticket' });
        actions.push(provider + ':' + action);
        if (action === 'connect') { accounts[provider].login = true; return json({ operationId: 'op.' + provider + '.connect' }); }
        if (action === 'finish') return json({ operationId: 'op.' + provider + '.finish' });
        if (action === 'cancel') { accounts[provider].login = false; return json({ ok: true }); }
        if (action === 'sleep') return json({ released: true });
      }
      return json({ error: { message: 'Not found' } }, 404);
    });
    await page.goto('https://proxy.test/');
    await page.locator('#email').fill('alice@example.com'); await page.locator('#password').fill('a-long-user-password');
    await page.locator('#auth-submit').click(); await page.locator('#dashboard').waitFor({ state: 'visible' });
    await page.locator('[data-provider=claude]').waitFor();

    // Logged-in and suspended accounts are not part of the sequence.
    await page.getByRole('button', { name: 'Conectar pendentes', exact: true }).click();
    await page.locator('#queue-status').filter({ hasText: '1 de 3 — Claude' }).waitFor();
    assert.equal(await page.locator('#remote-title').textContent(), 'Entre no Claude');
    assert.equal(await page.locator('#queue-skip').isVisible(), true);

    // Manual confirmation saves the session: the browser is released and the next service opens.
    await page.locator('#remote-finish').click();
    await page.locator('#queue-status').filter({ hasText: '2 de 3 — Qwen' }).waitFor({ timeout: 20_000 });
    assert.deepEqual(actions, ['claude:connect', 'claude:finish', 'claude:sleep', 'qwen:connect']);

    // Qwen confirms the login by itself; polling notices the saved session.
    Object.assign(accounts.qwen, { state: 'authenticated', saved: true, login: false });
    await page.locator('#queue-status').filter({ hasText: '3 de 3 — Grok' }).waitFor({ timeout: 20_000 });
    assert.deepEqual(actions.slice(4), ['qwen:sleep', 'grok:connect']);

    // Skipping the last service ends the sequence with a summary.
    await page.locator('#queue-skip').click();
    await page.locator('#message').filter({ hasText: 'Login em sequência concluído' }).waitFor();
    assert.match(await page.locator('#message').textContent() || '', /2 conectado\(s\) \(Claude, Qwen\); pulado\(s\): Grok\./);
    assert.deepEqual(actions.slice(6), ['grok:cancel', 'grok:sleep']);
    assert.equal(await page.locator('#remote-panel').isVisible(), false);
    assert.equal(await page.locator('#queue-skip').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Conectar pendentes', exact: true }).isVisible(), true);

    // A new run only includes what is still pending; stopping keeps it for later.
    await page.getByRole('button', { name: 'Conectar pendentes', exact: true }).click();
    await page.locator('#queue-status').filter({ hasText: '1 de 1 — Grok' }).waitFor();
    await page.locator('#queue-stop').click();
    await page.locator('#message').filter({ hasText: 'Login em sequência interrompido' }).waitFor();
    assert.match(await page.locator('#message').textContent() || '', /0 conectado\(s\); não aberto\(s\): Grok\./);
    assert.deepEqual(actions.slice(8), ['grok:connect', 'grok:cancel', 'grok:sleep']);

    // With every service logged in there is nothing to open.
    Object.assign(accounts.grok, { state: 'authenticated', saved: true });
    await page.getByRole('button', { name: 'Conectar pendentes', exact: true }).click();
    await page.locator('#message').filter({ hasText: 'Todas as contas já estão conectadas.' }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
