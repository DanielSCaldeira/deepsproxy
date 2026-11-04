import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GenerationGuard, getRequestDelayRange, retryAfterMilliseconds, getGenerationGuard, withGenerationSignal } from './services/generation-guard.ts';
import { createDeepSeekStream } from './services/deepseek.ts';

process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '15000';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '30000';

test('request delay bounds, invalid configuration and Retry-After parsing', () => {
  assert.deepEqual(getRequestDelayRange({}), { minMs: 15000, maxMs: 30000 });
  for (const [min, max] of [['NaN', '30000'], ['30001', '30000'], ['-1', '1'], ['0', 'Infinity'], ['1.5', '3']]) {
    assert.deepEqual(getRequestDelayRange({ DEEPSPROXY_REQUEST_DELAY_MIN_MS: min, DEEPSPROXY_REQUEST_DELAY_MAX_MS: max }), { minMs: 15000, maxMs: 30000 });
  }
  assert.equal(retryAfterMilliseconds('120'), 120000);
  assert.equal(retryAfterMilliseconds('invalid'), 0);
  assert.equal(retryAfterMilliseconds('-1'), 0);
  assert.equal(retryAfterMilliseconds('Wed, 04 Nov 2026 00:00:00 GMT', Date.parse('2026-11-03T23:59:00Z')), 60000);
});

test('fresh random cooldown starts at completion, survives restart and respects longer server waits', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-guard-'));
  const file = path.join(directory, 'guard.json');
  let now = 1000;
  const delays: number[] = [];
  const wait = async (ms: number) => { delays.push(ms); now += ms; };
  const samples = [0, 0.999999];
  try {
    let guard = new GenerationGuard(file, () => now, () => samples.shift()!, wait);
    const first = await guard.acquire();
    assert.deepEqual(delays, []);
    now += 5000;
    first(); first();
    assert.equal(Date.parse(guard.status().nextAllowedAt!), 21000);
    guard = new GenerationGuard(file, () => now, () => samples.shift() ?? 0, wait);
    const second = await guard.acquire();
    assert.deepEqual(delays, [15000]);
    second();
    assert.equal(Date.parse(guard.status().nextAllowedAt!), now + 30000);
    guard.defer(120000);
    assert.equal(Date.parse(guard.status().nextAllowedAt!), now + 120000);
    const third = await guard.acquire();
    assert.deepEqual(delays, [15000, 60000, 60000]);
    third();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('one active generation, queued cancellation, durable blocks and explicit recovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generation-block-'));
  const file = path.join(directory, 'guard.json');
  const guard = new GenerationGuard(file);
  try {
    const release = await guard.acquire();
    const controller = new AbortController();
    const queued = guard.acquire(controller.signal);
    controller.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    const blocked = guard.acquire();
    guard.block({ state: 'suspended', suspendedUntil: 'novembro 6, 2026 21:55' });
    await assert.rejects(blocked, /account is suspended/);
    release();
    const restarted = new GenerationGuard(file);
    await assert.rejects(restarted.acquire(), /account is suspended/);
    restarted.block({ state: 'login_required' });
    assert.equal(restarted.status().block?.state, 'suspended');
    restarted.confirmInteractiveLogin();
    assert.equal(new GenerationGuard(file).status().block, null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('dispatch queue retains the lease through streaming and releases on cancellation and errors', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '1';
  process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
  process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    dispatches++;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  try {
    const first = await createDeepSeekStream('first', false);
    const abortController = new AbortController();
    const queued = withGenerationSignal(abortController.signal, () => createDeepSeekStream('cancelled', false));
    abortController.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    const second = createDeepSeekStream('summary or retry', false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(dispatches, 1);
    await first.stream.cancel();
    const result = await second;
    assert.equal(dispatches, 2);
    assert.equal(cancelled, true);
    await result.stream.cancel();
    globalThis.fetch = async () => new Response('', { status: 401 });
    await assert.rejects(createDeepSeekStream('blocked', false), /login is required/);
    globalThis.fetch = async () => { throw new Error('must not dispatch'); };
    await assert.rejects(createDeepSeekStream('still blocked', false), /login is required/);
    assert.equal(getGenerationGuard().status().busy, false);
  } finally {
    getGenerationGuard().confirmInteractiveLogin();
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});

test('HTTP authentication errors never retry, preserve context telemetry and block later requests', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '1';
  process.env.DEEPSPROXY_MAX_ATTEMPTS = '3';
  process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
  process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';
  process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST = '1';
  const { app } = await import('./index.ts');
  const { getModelTelemetry } = await import('./services/telemetry.ts');
  const before = { ...getModelTelemetry('deepseek-v4-flash') };
  const originalFetch = globalThis.fetch;
  const request = (stream: boolean) => app.request('/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream, messages: [{ role: 'user', content: 'test' }] }),
  });
  try {
    for (const status of [401, 403]) {
      let sends = 0;
      globalThis.fetch = async () => { sends++; return new Response(status === 403 ? 'Sua conta foi suspensa até amanhã.' : '', { status }); };
      getGenerationGuard().confirmInteractiveLogin();
      const first = await request(false);
      assert.equal(first.status, status);
      assert.equal((await first.json()).error.code, status === 401 ? 'deepseek_login_required' : 'deepseek_account_suspended');
      assert.equal((await request(true)).status, status);
      assert.equal(sends, 1);
      assert.deepEqual(getModelTelemetry('deepseek-v4-flash'), before);
    }
  } finally {
    getGenerationGuard().confirmInteractiveLogin();
    globalThis.fetch = originalFetch;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
  }
});

test('aborting an active unread response cancels upstream and releases the generation lease', async () => {
  process.env.TEST_MOCK_PLAYWRIGHT = '1';
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  try {
    const controller = new AbortController();
    const result = await withGenerationSignal(controller.signal, () => createDeepSeekStream('active', false));
    controller.abort();
    await assert.rejects(result.stream.getReader().read(), { name: 'AbortError' });
    assert.equal(cancelled, true);
    assert.equal(getGenerationGuard().status().busy, false);
  } finally { globalThis.fetch = originalFetch; delete process.env.TEST_MOCK_PLAYWRIGHT; }
});

test('peeked response cancellation propagates to upstream without releasing a pending reader', async () => {
  const { observeDeepSeekStream } = await import('./services/deepseek.ts');
  const { peekStream } = await import('./routes/stream.ts');
  let cancelled = false;
  let releases = 0;
  const upstream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); },
    cancel() { cancelled = true; },
  });
  const result = await peekStream(observeDeepSeekStream(upstream, () => { releases++; }));
  await result.peekedStream.cancel();
  assert.equal(cancelled, true);
  assert.equal(releases, 1);
});
