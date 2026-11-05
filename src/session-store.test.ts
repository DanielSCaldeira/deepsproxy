import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { getProfileDirectory, restoreSession, saveSession, lockProfile } from './services/session-store.ts';

test('Session cookies, local storage and IndexedDB survive a browser restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsproxy-session-test-'));
  const previousProfile = process.env.DEEPSEEK_PROFILE_DIR;
  process.env.DEEPSEEK_PROFILE_DIR = directory;
  const server = createServer((_req, res) => { res.end('<!doctype html><title>Session test</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  let browser = await chromium.launch();
  try {
    const first = await browser.newContext();
    const page = await first.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      document.cookie = 'session=remember-me; Path=/';
      localStorage.setItem('login', 'test-user');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('auth', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('tokens');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction('tokens', 'readwrite');
          transaction.objectStore('tokens').put('test-token', 'access');
          transaction.oncomplete = () => { request.result.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    });
    await saveSession(first);
    await browser.close();
    browser = await chromium.launch();
    const second = await browser.newContext();
    assert.equal(await restoreSession(second), true);
    const restored = await second.newPage();
    await restored.goto(origin);
    const state = await restored.evaluate(async () => {
      const token = await new Promise((resolve, reject) => {
        const request = indexedDB.open('auth', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const read = request.result.transaction('tokens').objectStore('tokens').get('access');
          read.onsuccess = () => { request.result.close(); resolve(read.result); };
          read.onerror = () => reject(read.error);
        };
      });
      return { cookie: document.cookie, login: localStorage.getItem('login'), token };
    });
    assert.deepEqual(state, { cookie: 'session=remember-me', login: 'test-user', token: 'test-token' });
    await second.close();
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousProfile === undefined) delete process.env.DEEPSEEK_PROFILE_DIR;
    else process.env.DEEPSEEK_PROFILE_DIR = previousProfile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Default profile location does not depend on the working directory', () => {
  const previousProfile = process.env.DEEPSEEK_PROFILE_DIR;
  const originalCwd = process.cwd();
  delete process.env.DEEPSEEK_PROFILE_DIR;
  try {
    const expected = getProfileDirectory();
    process.chdir(os.tmpdir());
    assert.equal(getProfileDirectory(), expected);
  } finally {
    process.chdir(originalCwd);
    if (previousProfile !== undefined) process.env.DEEPSEEK_PROFILE_DIR = previousProfile;
  }
});

test('Login and API cannot reserve the same profile simultaneously', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deepsproxy-lock-test-'));
  const previousProfile = process.env.DEEPSEEK_PROFILE_DIR;
  process.env.DEEPSEEK_PROFILE_DIR = directory;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockProfile();
    await assert.rejects(lockProfile(), /perfil está em uso/);
    await release();
    release = await lockProfile();
  } finally {
    await release?.();
    if (previousProfile === undefined) delete process.env.DEEPSEEK_PROFILE_DIR;
    else process.env.DEEPSEEK_PROFILE_DIR = previousProfile;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
