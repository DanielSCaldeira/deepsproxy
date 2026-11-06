import { getProvider } from './providers/registry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnostic, flushDiagnostics, withDiagnostics } from './utils/diagnostics.ts';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-flow-'));
process.env.DEEPSPROXY_DIAGNOSTICS = '1';
process.env.DEEPSPROXY_DIAGNOSTICS_FILE = path.join(directory, 'flow.log');
process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_RETRY_DELAY_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_MAX_ATTEMPTS = '2';
process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS = '80';
process.env.DEEPSPROXY_POW_TIMEOUT_MS = '100';
process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST = '1';
process.env.DEEPSEEK_PROFILE_DIR = path.join(directory, 'profile');
delete process.env.TEST_MOCK_PLAYWRIGHT;
const { initPlaywright, getActivePage, getDeepSeekHeaders, closePlaywright, saveAuthenticatedSession } = await import('./services/playwright.ts');
const { createDeepSeekStream, observeDeepSeekStream } = await import('./services/deepseek.ts');
const { app } = await import('./index.ts');
const originalFetch = globalThis.fetch;
const { getGenerationGuard } = await import('./services/generation-guard.ts');
test.after(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.TEST_MOCK_PLAYWRIGHT;
  await closePlaywright();
  await flushDiagnostics();
  await fs.rm(directory, { recursive: true, force: true });
});
async function records() {
  await flushDiagnostics();
  return (await fs.readFile(process.env.DEEPSPROXY_DIAGNOSTICS_FILE!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
const sse = () => new Response('data: {"p":"response/content","v":"PRIVATE_RESPONSE"}\n\ndata: [DONE]\n\n');

test('browser diagnostics distinguish login, suspension, missing editor, capture timeout and intentional abort', { timeout: 30_000 }, async () => {
  await initPlaywright(true);
  const page = getActivePage()!;
  await page.route('https://chat.deepseek.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea></textarea>' }));
  await page.goto('https://chat.deepseek.com/sign_in?token=PRIVATE_URL');
  await assert.rejects(getDeepSeekHeaders(), /login is required/);
  await page.goto('https://chat.deepseek.com/');
  await saveAuthenticatedSession(true);

  await page.goto('https://chat.deepseek.com/');
  await page.setContent('<div>Due to violation of user policies, your account has been suspended until tomorrow.</div>');
  await assert.rejects(getDeepSeekHeaders(), /account is suspended/);
  await page.setContent('<textarea></textarea>');
  await saveAuthenticatedSession(true);

  await page.setContent('<div>Temporarily loading PRIVATE_PAGE</div>');
  await assert.rejects(getDeepSeekHeaders(), /chat input unavailable/);

  await page.setContent('<textarea></textarea>');
  process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS = '1000';
  // A delayed editor must still be accepted by the existing wait behavior.
  await page.evaluate(() => {
    document.querySelector('textarea')!.remove();
    setTimeout(() => document.body.append(document.createElement('textarea')), 20);
  });
  await assert.rejects(getDeepSeekHeaders(), /Timeout waiting for PoW/);
  await closePlaywright(); // Dispose of the existing timeout route without changing its behavior.
  await fs.writeFile(path.join(process.env.DEEPSEEK_PROFILE_DIR!, '.auth-state.json'), 'INVALID_SNAPSHOT');

  await initPlaywright(true);
  const next = getActivePage()!;
  await next.route('https://chat.deepseek.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea></textarea>' }));
  await next.goto('https://chat.deepseek.com/');
  await next.evaluate(() => {
    document.querySelector('textarea')!.addEventListener('keydown', event => {
      if (event.key === 'Enter') void fetch('/api/v0/chat/completion', {
        method: 'POST', headers: { authorization: 'Bearer PRIVATE_TOKEN', 'x-ds-pow-response': 'PRIVATE_POW', 'content-type': 'application/json' },
        body: JSON.stringify({ chat_session_id: 'PRIVATE_CHAT_ID' }),
      }).catch(() => undefined);
    });
  });
  // Use a generous capture timeout for CI after testing the timeout path above.
  process.env.DEEPSPROXY_POW_TIMEOUT_MS = '5000';
  const failed = next.waitForEvent('requestfailed');
  const requestId = randomUUID();
  const captured = await withDiagnostics({ requestId, operation: 'client', attempt: 1 }, () => getDeepSeekHeaders());
  assert.equal(captured.chatSessionId, 'PRIVATE_CHAT_ID');
  await failed;
  const blockedSnapshot = path.join(process.env.DEEPSEEK_PROFILE_DIR!, '.auth-state.json.tmp');
  await fs.mkdir(blockedSnapshot);
  await assert.rejects(saveAuthenticatedSession());
  await fs.rmdir(blockedSnapshot);
  await saveAuthenticatedSession();
  await next.route('**/api/v0/users/current*', route => route.fulfill({ status: 403, body: 'PRIVATE_HTTP_BODY' }));
  const forbidden = next.waitForEvent('response', response => response.status() === 403);
  await next.evaluate(() => fetch('/api/v0/users/current?secret=PRIVATE_URL').then(() => undefined));
  await forbidden;
  await next.context().close(); // Unexpected closure: bypass closePlaywright intentionally.
  const data = await records();
  assert.ok(data.some(r => r.event === 'session.transition' && r.reason === 'login_route'));
  assert.ok(data.some(r => r.event === 'session.transition' && r.reason === 'suspension_signal'));
  assert.ok(data.some(r => r.event === 'session.observed' && r.reason === 'editor_missing'));
  assert.ok(data.some(r => r.event === 'capture.failed' && r.category === 'capture_timeout'));
  assert.ok(data.some(r => r.event === 'capture.ready' && r.requestId === requestId && r.hasAuthorization && r.hasPow));
  assert.ok(data.some(r => r.event === 'capture.intentional_abort' && r.requestId === requestId));
  assert.ok(!data.some(r => r.event === 'browser.network_failed' && r.requestId === requestId));
  assert.ok(data.some(r => r.event === 'browser.closed' && r.requested === true));
  assert.ok(data.some(r => r.event === 'browser.closed' && r.requested === false));
  assert.ok(data.some(r => r.event === 'browser.network_response' && r.status === 403));
  assert.ok(data.some(r => r.event === 'session.restore' && r.outcome === 'failed'));
  assert.ok(data.some(r => r.event === 'session.save' && r.outcome === 'failed'));
  assert.ok(data.some(r => r.event === 'session.save' && r.outcome === 'ok'));
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('upstream statuses, network errors, empty streams and cancellation retain their behavior', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '1';
  for (const status of [401, 403, 429]) {
    globalThis.fetch = async () => new Response('PRIVATE_ERROR_BODY', { status });
    await assert.rejects(createDeepSeekStream('PRIVATE_PROMPT', false), status === 401 ? /login is required/ : new RegExp(String(status)));
    getGenerationGuard().confirmInteractiveLogin();
  }
  globalThis.fetch = async () => { throw new Error('fetch failed PRIVATE_NETWORK'); };
  await assert.rejects(createDeepSeekStream('PRIVATE_PROMPT', false), /fetch failed/);
  const readError = new Error('PRIVATE_STREAM_ERROR');
  const broken = observeDeepSeekStream(new ReadableStream({ pull() { throw readError; } }));
  await assert.rejects(broken.getReader().read(), error => error === readError);
  let reason: unknown;
  const cancelled = observeDeepSeekStream(new ReadableStream({ cancel(value) { reason = value; } }));
  await cancelled.cancel('PRIVATE_CANCEL_REASON');
  assert.equal(reason, 'PRIVATE_CANCEL_REASON');
  const empty = observeDeepSeekStream(new ReadableStream({ start(controller) { controller.close(); } }));
  assert.equal((await empty.getReader().read()).done, true);
  const data = await records();
  for (const status of [401, 403, 429]) assert.ok(data.some(r => r.event === 'upstream.response' && r.status === status));
  assert.ok(data.some(r => r.event === 'upstream.failed' && r.category === 'network'));
  assert.ok(data.some(r => r.event === 'stream.failed'));
  assert.ok(data.some(r => r.event === 'stream.cancelled'));
  assert.ok(data.some(r => r.event === 'stream.finished' && r.outcome === 'empty'));
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});

test('parallel client requests correlate retries and internal summaries through streaming completion', async t => {
  t.mock.method(getProvider(), 'models', async () => [{id:'diagnostic-test-model',contextLength:64000},{id:'deepseek-v4-flash',contextLength:512000}]);
  process.env.TEST_MOCK_PLAYWRIGHT = '1';
  const counts = new Map<string, number>();
  globalThis.fetch = async (_input, init) => {
    const prompt = JSON.parse(init!.body as string).prompt as string;
    const count = (counts.get(prompt) ?? 0) + 1;
    counts.set(prompt, count);
    if (prompt.includes('PRIVATE_RETRY') && count === 1) return new Response('PRIVATE_ERROR_BODY', { status: 503 });
    await new Promise(resolve => setTimeout(resolve, 5));
    return sse();
  };
  const request = async (stream: boolean, messages: unknown[], model = 'deepseek-v4-flash') => {
    const response = await app.request('/v1/chat/completions', { method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) },
      body: JSON.stringify({ model, stream, messages }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /PRIVATE_RESPONSE/);
  };
  await Promise.all([
    request(false, [{ role: 'user', content: 'PRIVATE_RETRY' }]),
    request(true, [{ role: 'user', content: 'PRIVATE_PARALLEL' }]),
    request(false, [
      { role: 'user', content: 'PRIVATE_OLD'.repeat(20_000) },
      { role: 'assistant', content: 'PRIVATE_PREVIOUS' },
      { role: 'user', content: 'PRIVATE_CURRENT' },
    ], 'diagnostic-test-model'),
  ]);
  const data = await records();
  const requests = data.filter(r => r.event === 'request.started');
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.requestId)).size, 3);
  const retry = data.find(r => r.event === 'attempt.failed' && r.category === 'http_error');
  assert.ok(retry);
  assert.ok(data.some(r => r.event === 'attempt.started' && r.requestId === retry.requestId && r.attempt === 2));
  const summary = data.find(r => r.event === 'summary.started');
  assert.ok(summary);
  assert.equal(summary.operation, 'summary');
  assert.ok(data.some(r => r.event === 'summary.finished' && r.operationId === summary.operationId));
  assert.notEqual(summary.operationId, requests.find(r => r.requestId === summary.requestId).operationId);
  for (const r of requests) {
    assert.ok(data.some(event => event.event === 'request.finished' && event.requestId === r.requestId && event.outcome === 'ok'));
    assert.ok(data.some(event => event.event === 'stream.finished' && event.requestId === r.requestId && event.operation === 'client'));
  }
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_/);
});
