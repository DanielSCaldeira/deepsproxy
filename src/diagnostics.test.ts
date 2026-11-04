import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DiagnosticWriter, diagnosticRoute, diagnosticError, withDiagnostics } from './utils/diagnostics.ts';

test('diagnostic records allow only safe fields and keep concurrent scopes isolated', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-writer-'));
  try {
    const file = path.join(directory, 'events.log');
    const writer = new DiagnosticWriter(file);
    const ids = Array.from({ length: 40 }, () => randomUUID());
    await Promise.all(ids.map((requestId, index) => withDiagnostics({ requestId, operation: 'client' }, async () => {
      await Promise.resolve();
      writer.emit('upstream.response', {
        status: index, prompt: 'PRIVATE_PROMPT', authorization: 'SECRET_TOKEN', cookie: 'SECRET_COOKIE',
        error: 'PRIVATE_BODY', route: 'https://chat.deepseek.com/private?token=SECRET',
        model: 'PRIVATE_MODEL', category: 'PRIVATE_ERROR', code: 'PRIVATE_CODE',
        operationId: 'PRIVATE_ID', hasAuthorization: true, toString: 'PRIVATE_PROTOTYPE', constructor: 'PRIVATE_PROTOTYPE',
      });
    })));
    writer.emit('PRIVATE_EVENT', { status: 42 });
    await writer.flush();
    const raw = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(raw, /PRIVATE|SECRET|https:/);
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, ids.length);
    for (const record of records) {
      assert.equal(record.requestId, ids[record.status]);
      assert.equal(record.hasAuthorization, true);
      assert.ok(record.timestamp.endsWith('Z'));
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('rotation retains three bounded backups and complete JSON lines', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-rotation-'));
  try {
    const writer = new DiagnosticWriter(path.join(directory, 'events.log'), 600);
    for (let index = 0; index < 50; index++) writer.emit('attempt.started', { attempt: index });
    await writer.flush();
    const files = (await fs.readdir(directory)).sort();
    assert.deepEqual(files, ['events.1.log', 'events.2.log', 'events.3.log', 'events.log']);
    const retained = [];
    for (const file of files) {
      const data = await fs.readFile(path.join(directory, file), 'utf8');
      assert.ok(Buffer.byteLength(data) <= 600);
      retained.push(...data.trim().split('\n').map(line => JSON.parse(line)));
    }
    assert.ok(retained.some(record => record.attempt === 49));
    assert.ok(!retained.some(record => record.attempt === 0));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('disk errors and queue overload do not reject; writer recovers after disk failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-error-'));
  const originalWarning = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    const blocked = path.join(directory, 'blocked');
    await fs.writeFile(blocked, 'block');
    const writer = new DiagnosticWriter(path.join(blocked, 'events.log'), 600, 1);
    writer.emit('attempt.started', { attempt: 1 });
    writer.emit('attempt.started', { attempt: 2 });
    await writer.flush();
    assert.equal(warnings.length, 1);
    await fs.unlink(blocked);
    writer.emit('attempt.started', { attempt: 3 });
    await writer.flush();
    assert.equal(JSON.parse(await fs.readFile(writer.file, 'utf8')).attempt, 3);
  } finally {
    console.warn = originalWarning;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('route and error classification never return arbitrary input', () => {
  assert.equal(diagnosticRoute('https://chat.deepseek.com/api/v0/chat/completion?secret=TOKEN'), 'chat_completion');
  assert.equal(diagnosticRoute('https://chat.deepseek.com/chat/PRIVATE_ID'), 'chat');
  assert.equal(diagnosticRoute('https://chat.deepseek.com/api/v0/PRIVATE'), 'api_other');
  assert.equal(diagnosticRoute('https://chat.deepseek.com/sign_in?token=PRIVATE'), 'login');
  assert.equal(diagnosticRoute('https://other.example/PRIVATE'), 'external');
  assert.equal(diagnosticError(new Error('Timeout waiting for PoW headers')), 'capture_timeout');
  assert.equal(diagnosticError(new Error('PRIVATE_ERROR')), 'unknown');
});

test('default local diagnostics persist without stdout and can be disabled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-background-'));
  try {
    const moduleUrl = new URL('./utils/diagnostics.ts', import.meta.url).href;
    const run = async (disabled: boolean) => {
      const env: NodeJS.ProcessEnv = { ...process.env, DEEPSPROXY_DIAGNOSTICS_FILE: path.join(directory, disabled ? 'disabled.log' : 'enabled.log') };
      delete env.NODE_TEST_CONTEXT;
      delete env.TEST_MOCK_PLAYWRIGHT;
      delete env.APP_MODE;
      delete env.DEEPSPROXY_DIAGNOSTICS;
      if (disabled) env.DEEPSPROXY_DIAGNOSTICS = '0';
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        `const {diagnostic,flushDiagnostics} = await import(${JSON.stringify(moduleUrl)}); diagnostic('process.started'); await flushDiagnostics();`],
        { env, stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit: ${code}`)));
      });
    };
    await run(false);
    await run(true);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'enabled.log'), 'utf8')).event, 'process.started');
    assert.equal(await fs.stat(path.join(directory, 'disabled.log')).then(() => true, () => false), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
