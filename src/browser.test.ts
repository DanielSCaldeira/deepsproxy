import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROWSER_LOCALE, chromium, configureBrowserUserAgent, createBrowserPage, getBrowserChannel, focusChatEditor, readCopiedResponse } from './services/browser.ts';
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

test('copy capture preserves raw tool JSON and Markdown and restores clipboard methods', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://copy.test/**',route=>route.fulfill({contentType:'text/html',body:'<button id="text">Copy text</button><button id="item">Copy item</button>'}));
    await page.goto('https://copy.test/');
    const raw='<tool_call>{"name":"lookup","arguments":{"quote":"“hello”"}}</tool_call>\n```ts\nx()\n```';
    await page.evaluate(raw=>{
      const scope=globalThis as any;scope.osWrites=0;
      navigator.clipboard.writeText=async function(){scope.osWrites++;};
      scope.originalWrite=navigator.clipboard.writeText;
      document.querySelector('#text')!.addEventListener('click',()=>navigator.clipboard.writeText(raw));
      document.querySelector('#item')!.addEventListener('click',()=>navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([raw],{type:'text/plain'})})]));
    },raw);
    for(const selector of ['#text','#item']) {
      assert.equal(await readCopiedResponse(page,page.locator(selector),'rendered wrong text'),raw);
      assert.equal(await page.evaluate(()=>navigator.clipboard.writeText===(globalThis as any).originalWrite),true);
      assert.equal(await page.evaluate(()=>(globalThis as any).osWrites),0);
    }
  } finally {await browser.close();}
});

test('cookie rejection and editor hydration do not block a chat action', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(), page = await createBrowserPage(context);
    await page.route('https://composer.test/**', route => route.fulfill({ contentType: 'text/html', body: `
      <textarea id="editor"></textarea><div role="dialog" style="position:fixed;inset:0;background:white;z-index:10">
      Política de Cookies<button id="reject">Recusar opcionais</button></div>
      <script>document.getElementById('reject').onclick=()=>{document.querySelector('[role=dialog]').remove();
      document.getElementById('editor').outerHTML='<textarea id="editor" disabled></textarea>';
      setTimeout(()=>document.getElementById('editor').disabled=false,50);};</script>` }));
    await page.goto('https://composer.test/');
    const editor = await focusChatEditor(page, '#editor');
    await editor.fill('fixture prompt');
    assert.equal(await editor.inputValue(), 'fixture prompt');
    assert.equal(await page.locator('[role=dialog]').count(), 0);
  } finally { await browser.close(); }
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
      const context = await chromium.launchPersistentContext(directory, { channel: 'chromium', headless: true, userAgent, locale: BROWSER_LOCALE });
      try {
        const page = await createBrowserPage(context);
        assert.equal(context.pages().length, 1);
        let sentUserAgent = '';
        let sentLanguage = '';
        await page.route('https://browser.test/**', route => {
          sentUserAgent = route.request().headers()['user-agent'];
          sentLanguage = route.request().headers()['accept-language'];
          return route.fulfill({ contentType: 'text/html', body: `<script>
            window.firstDocument = { webdriver: navigator.webdriver, userAgent: navigator.userAgent,
              language: navigator.language, languages: navigator.languages, locale: Intl.DateTimeFormat().resolvedOptions().locale };
          </script>` });
        });
        await page.goto('https://browser.test/');
        const signals = await page.evaluate(() => (window as unknown as {
          firstDocument: { webdriver: boolean; userAgent: string; language: string; languages: string[]; locale: string };
        }).firstDocument);
        assert.equal(signals.webdriver, false);
        assert.doesNotMatch(signals.userAgent, /HeadlessChrome/);
        assert.equal(sentUserAgent, signals.userAgent);
        assert.equal(signals.language, 'pt-BR');
        assert.deepEqual(signals.languages, ['pt-BR', 'pt']);
        assert.equal(signals.locale, 'pt-BR');
        assert.match(sentLanguage, /^pt-BR(?:,|$)/);
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
