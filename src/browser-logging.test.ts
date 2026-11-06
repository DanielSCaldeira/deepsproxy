import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserLogText, browserLogUrl, captchaResult, flushBrowserLogs, observeBrowser } from './services/browser-logging.ts';

test('CAPTCHA results retain rejection flags without challenge answers or tokens', () => {
  assert.deepEqual(captchaResult({pass:false,success:true,'error-codes':['challenge-expired','SECRET','challenge-expired'],
    generated_pass_UUID:'TOKEN_SECRET',answers:['ANSWER_SECRET'],request_type:'image_label_area_select'}),
  {pass:false,success:true,errorCodes:['challenge-expired','other']});
  assert.deepEqual(captchaResult({pass:'TOKEN_SECRET',success:{secret:'SECRET'},'error-codes':'SECRET'}),{});
  assert.deepEqual(captchaResult(null),{});
});

test('browser logging sanitizes credentials, URLs, identifiers and console payload fields', () => {
  assert.equal(browserLogUrl('https://user:pass@chat.qwen.ai/api/v2/chats/12345678-1234-1234-1234-123456789012?token=URL_SECRET#SECRET'), 'https://chat.qwen.ai/api/v2/chats/[id]');
  assert.equal(browserLogUrl('data:text/plain,SECRET'), 'data:[redacted]');
  const result = browserLogText('Bearer TOKEN_SECRET password="PASSWORD_SECRET" {"messages":[{"content":"PROMPT_SECRET"}],"access_token":"ACCESS_SECRET"} user@example.com https://chat.qwen.ai/api/test?token=QUERY_SECRET');
  assert.doesNotMatch(result, /SECRET|user@example|\?token/);
  assert.match(result, /redacted/);
  assert.ok(browserLogText('a'.repeat(20_000)).length <= 2048);
});

test('browser logging captures console, errors, requests, failures and new tabs without payloads', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'browser-log-'));
  const browser = await chromium.launch();
  const context = await browser.newContext();
  try {
    const file = path.join(directory, 'browser.log');
    const writer = observeBrowser(context, { enabled: true, file, mirror: false })!;
    assert.equal(observeBrowser(context, { enabled: true, file }), writer, 'must not attach duplicate listeners');
    await context.route('https://browser.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/failed') return route.abort('connectionrefused');
      if (pathname === '/api/send') return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"RESPONSE_BODY_SECRET"}' });
      return route.fulfill({ contentType: 'text/html', body: '<html><body>fixture</body></html>' });
    });
    await context.route('https://api.hcaptcha.com/checkcaptcha/**', route => route.fulfill({
      contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'},
      body:JSON.stringify({pass:false,'error-codes':['challenge-expired'],generated_pass_UUID:'CAPTCHA_TOKEN_SECRET',answers:['ANSWER_SECRET']}),
    }));
    const page = await context.newPage();
    await page.goto('https://browser.test/');
    const errored = page.waitForEvent('pageerror');
    const failed = context.waitForEvent('requestfailed', request => request.url().includes('/failed'));
    const finished = context.waitForEvent('requestfinished', request => request.url().includes('/api/send'));
    await page.evaluate(async () => {
      console.log('fixture console message');
      console.warn('Bearer CONSOLE_SECRET');
      setTimeout(() => { throw new Error('fixture page error'); }, 0);
      await fetch('/api/send?token=QUERY_SECRET', { method: 'POST', headers: { Authorization: 'Bearer HEADER_SECRET', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: ['REQUEST_BODY_SECRET'] }) });
      await fetch('/failed').catch(() => undefined);
      await fetch('https://api.hcaptcha.com/checkcaptcha/123456789012345678901234/123456789012345678901234');
    });
    await Promise.all([errored, failed, finished]);
    const second = await context.newPage();
    await second.goto('https://browser.test/second');
    await second.evaluate(() => console.error('fixture second tab'));
    await context.close();
    await flushBrowserLogs();
    await writer.flush();
    const raw = await readFile(file, 'utf8');
    assert.doesNotMatch(raw, /SECRET|REQUEST_BODY|RESPONSE_BODY/);
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    for (const event of ['browser.log_started', 'browser.console', 'browser.page_error', 'browser.request', 'browser.response', 'browser.request_finished', 'browser.request_failed', 'browser.page_closed', 'browser.closed']) {
      assert.ok(records.some(record => record.event === event), event);
    }
    assert.ok(records.some(record => record.message === 'fixture console message'));
    assert.ok(records.some(record => record.message === 'fixture second tab'));
    assert.ok(records.some(record => record.message === 'fixture page error'));
    assert.ok(records.some(record => record.event === 'browser.captcha_result' && record.pass === false && record.errorCodes?.includes('challenge-expired')));
    const request = records.find(record => record.event === 'browser.request' && record.method === 'POST');
    assert.equal(request.url, 'https://browser.test/api/send');
    assert.ok(records.some(record => record.event === 'browser.response' && record.networkRequestId === request.networkRequestId && record.status === 403));
    assert.equal(new Set(records.filter(record => record.event === 'browser.page_opened').map(record => record.pageId)).size, 2);
  } finally {
    await context.close(); await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser logging can be disabled without creating a log file', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'browser-log-disabled-'));
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const file = path.join(directory, 'browser.log');
    assert.equal(observeBrowser(context, { enabled: false, file }), undefined);
    const page = await context.newPage();
    await page.evaluate(() => console.error('disabled fixture'));
    await context.close();
    await assert.rejects(access(file), { code: 'ENOENT' });
  } finally {
    await browser.close(); await rm(directory, { recursive: true, force: true });
  }
});
