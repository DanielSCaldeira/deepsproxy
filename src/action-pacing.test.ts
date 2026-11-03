import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActionPacer, getActionDelayRange } from './services/action-pacing.ts';
import { initPlaywright, getActivePage, getDeepSeekHeaders, closePlaywright } from './services/playwright.ts';

test('pacing defaults and custom ranges reject invalid configuration', () => {
  const defaults = { minMs: 3000, maxMs: 7000 };
  assert.deepEqual(getActionDelayRange({}), defaults);
  assert.deepEqual(getActionDelayRange({ DEEPSPROXY_ACTION_DELAY_MIN_MS: '5000', DEEPSPROXY_ACTION_DELAY_MAX_MS: '9000' }), { minMs: 5000, maxMs: 9000 });
  assert.deepEqual(getActionDelayRange({ DEEPSPROXY_ACTION_DELAY_MIN_MS: '0', DEEPSPROXY_ACTION_DELAY_MAX_MS: '0' }), { minMs: 0, maxMs: 0 });
  for (const [min, max] of [['-1', '5000'], ['NaN', '5000'], ['6000', '5000'], ['1.5', '5'], ['1', 'Infinity'], ['1', '60001']]) {
    assert.deepEqual(getActionDelayRange({ DEEPSPROXY_ACTION_DELAY_MIN_MS: min, DEEPSPROXY_ACTION_DELAY_MAX_MS: max }), defaults);
  }
});

test('each action gets a fresh random delay within the configured inclusive range', async () => {
  const delays: number[] = [];
  const samples = [0, 0.5, 0.999999];
  const pacer = new ActionPacer(async ms => { delays.push(ms); }, () => samples.shift()!);
  for (let i = 0; i < 3; i++) await pacer.pause('test', { minMs: 3000, maxMs: 7000 });
  assert.deepEqual(delays, [3000, 5000, 7000]);
  await pacer.pause('disabled', { minMs: 0, maxMs: 0 });
  assert.equal(delays.length, 3);
});

test('concurrent callers wait in sequence instead of being released in a burst', async () => {
  const releases: (() => void)[] = [];
  const completed: string[] = [];
  const pacer = new ActionPacer(() => new Promise<void>(resolve => { releases.push(resolve); }), () => 0);
  const first = pacer.pause('first', { minMs: 1, maxMs: 1 }).then(() => { completed.push('first'); });
  const second = pacer.pause('second', { minMs: 1, maxMs: 1 }).then(() => { completed.push('second'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  assert.deepEqual(completed, []);
  releases[0]();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.deepEqual(completed, ['first']);
  releases[1]();
  await second;
  assert.deepEqual(completed, ['first', 'second']);
});

test('failed waits release the queue for the next action', async () => {
  let count = 0;
  const pacer = new ActionPacer(async () => { if (++count === 1) throw new Error('interrupted'); });
  await assert.rejects(pacer.pause('first', { minMs: 1, maxMs: 1 }), /interrupted/);
  await pacer.pause('second', { minMs: 1, maxMs: 1 });
  assert.equal(count, 2);
});

test('browser flow paces new chats and sends, reuses a tab and serializes concurrent captures', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsproxy-pacing-test-'));
  const keys = ['DEEPSEEK_PROFILE_DIR', 'DEEPSPROXY_ACTION_DELAY_MIN_MS', 'DEEPSPROXY_ACTION_DELAY_MAX_MS'];
  const previous = keys.map(key => process.env[key]);
  process.env.DEEPSEEK_PROFILE_DIR = directory;
  process.env.DEEPSPROXY_ACTION_DELAY_MIN_MS = '80';
  process.env.DEEPSPROXY_ACTION_DELAY_MAX_MS = '80';
  const events: { action: string; at: number }[] = [];
  try {
    await initPlaywright(true);
    const page = getActivePage()!;
    assert.equal(page.context().pages().length, 1, 'must reuse the initial blank tab');
    await page.route('https://chat.deepseek.com/**', async route => {
      assert.equal(route.request().resourceType(), 'document', 'no upstream requests should escape interception');
      events.push({ action: 'navigate', at: performance.now() });
      await route.fulfill({ contentType: 'text/html', body: `<textarea></textarea><script>
        document.querySelector('textarea').addEventListener('keydown', event => {
          if (event.key === 'Enter') fetch('/api/v0/chat/completion', {
            method: 'POST', body: JSON.stringify({ chat_session_id: 'paced-session', parent_message_id: null })
          }).catch(() => {});
        });
      </script>` });
    });
    page.on('request', request => {
      if (request.url().endsWith('/api/v0/chat/completion')) events.push({ action: 'send', at: performance.now() });
    });
    const started = performance.now();
    const captures = await Promise.all([getDeepSeekHeaders(true), getDeepSeekHeaders(true)]);
    assert.deepEqual(captures.map(result => result.chatSessionId), ['paced-session', 'paced-session']);
    assert.deepEqual(events.map(event => event.action), ['navigate', 'send', 'navigate', 'send']);
    assert.ok(events[0].at - started >= 70, 'navigation must wait');
    for (let i = 1; i < events.length; i++) assert.ok(events[i].at - events[i - 1].at >= 70, 'each action must have its own pause');
    assert.equal(page.context().pages().length, 1);
    assert.equal(getActivePage(), page);
  } finally {
    await closePlaywright();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
