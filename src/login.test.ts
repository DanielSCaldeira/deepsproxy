import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from './index.ts';
import { waitForAuthenticatedChat, initPlaywright, getActivePage, saveAuthenticatedSession, closePlaywright } from './services/playwright.ts';

test('Login waits through hidden CAPTCHA fields until the authenticated chat is visible', { timeout: 10_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://chat.deepseek.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<textarea name="g-recaptcha-response" hidden></textarea><textarea name="h-captcha-response" hidden></textarea>',
    }));
    await page.goto('https://chat.deepseek.com/sign_in');
    let state = 'pending';
    const waiting = waitForAuthenticatedChat(page).then(() => { state = 'done'; }, () => { state = 'failed'; });
    await page.waitForTimeout(150);
    assert.equal(state, 'pending', 'CAPTCHA fields must not finish or abort login');
    await page.evaluate(() => {
      history.pushState({}, '', '/');
      document.body.appendChild(document.createElement('textarea'));
    });
    await waiting;
    assert.equal(state, 'done');
    assert.equal(page.isClosed(), false);
  } finally {
    await browser.close();
  }
});

test('API status reuses the authenticated browser without closing or replacing it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsproxy-shared-login-test-'));
  const previousProfile = process.env.DEEPSEEK_PROFILE_DIR;
  process.env.DEEPSEEK_PROFILE_DIR = directory;
  try {
    await initPlaywright(true);
    const page = getActivePage()!;
    await page.route('https://chat.deepseek.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<div role="textbox" contenteditable="true"></div>',
    }));
    await page.goto('https://chat.deepseek.com/');
    await page.evaluate(() => { localStorage.setItem('test-login', 'signed-in'); });
    await waitForAuthenticatedChat(page);
    await saveAuthenticatedSession();
    const headers = process.env.API_KEY ? { Authorization: `Bearer ${process.env.API_KEY}` } : undefined;
    const response = await app.request('/api/status', { headers });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.deepseek.state, 'authenticated');
    assert.equal(status.deepseek.sessionSaved, true);
    assert.equal(getActivePage(), page);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('test-login')), 'signed-in');
  } finally {
    await closePlaywright();
    if (previousProfile === undefined) delete process.env.DEEPSEEK_PROFILE_DIR;
    else process.env.DEEPSEEK_PROFILE_DIR = previousProfile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
