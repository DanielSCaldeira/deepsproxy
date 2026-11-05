import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, configureBrowserUserAgent, createBrowserPage, getBrowserChannel } from './services/browser.ts';
import { initPlaywright } from './services/playwright.ts';
import { QwenProvider } from './providers/qwen.ts';

test('browser channel defaults to Chromium and accepts installed Chrome', () => {
  const previous = process.env.PLAYWRIGHT_CHANNEL;
  try {
    delete process.env.PLAYWRIGHT_CHANNEL;
    assert.equal(getBrowserChannel(), 'chromium');
    process.env.PLAYWRIGHT_CHANNEL = 'chrome';
    assert.equal(getBrowserChannel(), 'chrome');
    process.env.PLAYWRIGHT_CHANNEL = 'firefox';
    assert.throws(getBrowserChannel, /PLAYWRIGHT_CHANNEL/);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_CHANNEL;
    else process.env.PLAYWRIGHT_CHANNEL = previous;
  }
});

test('both providers release the profile lock when the browser channel is invalid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepsproxy-launch-failure-'));
  const env = {
    PROVIDER_PROFILE_DIR: directory,
    PLAYWRIGHT_CHANNEL: 'invalid',
    DEEPSPROXY_ACTION_DELAY_MIN_MS: '0',
    DEEPSPROXY_ACTION_DELAY_MAX_MS: '0',
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await assert.rejects(initPlaywright(), /PLAYWRIGHT_CHANNEL/);
    await assert.rejects(access(path.join(directory, '.runtime.lock')), { code: 'ENOENT' });
    await assert.rejects(new QwenProvider().initialize(), /PLAYWRIGHT_CHANNEL/);
    await assert.rejects(access(path.join(directory, '.runtime.lock')), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('persistent browser applies stealth before the first document and resets explicit user agents on restart', { timeout: 360_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deepsproxy-stealth-'));
  const custom = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  try {
    for (const userAgent of [undefined, custom, undefined]) {
      configureBrowserUserAgent(userAgent);
      const context = await chromium.launchPersistentContext(directory, { channel: 'chromium', headless: true, userAgent });
      try {
        const page = await createBrowserPage(context);
        assert.equal(context.pages().length, 1);
        let sentUserAgent = '';
        await page.route('https://browser.test/**', route => {
          sentUserAgent = route.request().headers()['user-agent'];
          return route.fulfill({ contentType: 'text/html', body: `<script>
            window.firstDocument = { webdriver: navigator.webdriver, userAgent: navigator.userAgent };
          </script>` });
        });
        await page.goto('https://browser.test/');
        const signals = await page.evaluate(() => (window as unknown as {
          firstDocument: { webdriver: boolean; userAgent: string };
        }).firstDocument);
        assert.equal(signals.webdriver, false);
        assert.doesNotMatch(signals.userAgent, /HeadlessChrome/);
        assert.equal(sentUserAgent, signals.userAgent);
        if (userAgent) assert.equal(signals.userAgent, userAgent);
        else assert.notEqual(signals.userAgent, custom);
      } finally {
        await context.close();
      }
    }
  } finally {
    configureBrowserUserAgent();
    await rm(directory, { recursive: true, force: true });
  }
});
