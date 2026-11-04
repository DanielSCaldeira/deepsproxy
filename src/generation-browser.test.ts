import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { initPlaywright, closePlaywright, getActivePage, getDeepSeekHeaders, getSessionStatus, saveAuthenticatedSession, waitForAuthenticatedChat } from './services/playwright.ts';
import { GenerationGuard } from './services/generation-guard.ts';

process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';

test('localized suspension survives restart, status does not navigate, only validated interactive login clears it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localized-block-'));
  process.env.DEEPSEEK_PROFILE_DIR = directory;
  try {
    await initPlaywright(true);
    const page = getActivePage()!;
    let navigations = 0;
    await page.route('https://chat.deepseek.com/**', route => {
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: '<textarea></textarea>' });
    });
    await page.goto('https://chat.deepseek.com/');
    const message = 'Devido à violação das políticas do usuário, sua conta foi suspensa até novembro 6, 2026 21:55. Se tiver alguma dúvida, .';
    // Quoted conversation text must not be interpreted as an account notice.
    await page.setContent(`<article>${message}</article><textarea></textarea>`);
    await waitForAuthenticatedChat(page);
    await saveAuthenticatedSession();
    await page.setContent(`<div>${message}</div>`);
    await assert.rejects(getDeepSeekHeaders(), /account is suspended/);
    const persisted = new GenerationGuard(path.join(directory, '.generation-state.json'));
    assert.equal(persisted.status().block?.suspendedUntil, 'novembro 6, 2026 21:55');
    assert.equal(persisted.status().block?.originalMessage, message);
    const { app } = await import('./index.ts');
    const response = await app.request('/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'test' }] }),
    });
    const { error } = await response.json();
    assert.equal(response.status, 403);
    assert.equal(error.original_message, message);
    assert.equal(error.suspended_until, 'novembro 6, 2026 21:55');
    assert.ok(error.message.includes(error.help_url));
    const before = navigations;
    await assert.rejects(getDeepSeekHeaders(true), /account is suspended/);
    assert.equal((await getSessionStatus()).state, 'suspended');
    assert.equal(navigations, before);
    await page.setContent('<textarea></textarea>');
    await assert.rejects(saveAuthenticatedSession(), /account is suspended/);
    await saveAuthenticatedSession(true);
    assert.equal((await getSessionStatus()).block, null);
    assert.equal(new GenerationGuard(path.join(directory, '.generation-state.json')).status().block, null);
    await page.setContent('<textarea></textarea><div role="alert">Your account has been suspended until November 6, 2026 21:55.</div>');
    await assert.rejects(waitForAuthenticatedChat(page), /account is suspended/);
    await assert.rejects(saveAuthenticatedSession(true), /account is suspended/);
  } finally {
    await closePlaywright();
    await fs.rm(directory, { recursive: true, force: true });
    delete process.env.DEEPSEEK_PROFILE_DIR;
  }
});

test('occupied port exits cleanly before launching a browser', { timeout: 15000 }, async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(port), BIND_HOST: '127.0.0.1', TEST_MOCK_PLAYWRIGHT: '1', DEEPSPROXY_DIAGNOSTICS: '0' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 1);
    assert.match(output, /Porta já ocupada/);
    assert.doesNotMatch(output, /Unhandled|Launching persistent context|Playwright initialized/);
  } finally { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
