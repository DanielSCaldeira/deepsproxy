import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { panelPage } from './production/panel.ts';

type Pointer = { mask: number; x: number; y: number };

test('real noVNC preserves click and drag coordinates at native size, fitted size and after scrolling', { timeout: 90_000 }, async () => {
  const width = 1280, height = 900;
  const pointers = new EventEmitter();
  const failures: string[] = [];
  const novnc = fileURLToPath(new URL('../node_modules/@novnc/novnc/', import.meta.url));
  const panelScript = await readFile(new URL('../public/panel.js', import.meta.url), 'utf8');
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    const send = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(panelPage); return; }
    if (pathname === '/assets/panel.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(panelScript); return; }
    if (pathname.startsWith('/novnc/')) {
      const file = path.resolve(novnc, pathname.slice('/novnc/'.length));
      if (!file.startsWith(novnc)) { response.writeHead(403).end(); return; }
      try { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(file)); }
      catch { response.writeHead(404).end(); }
      return;
    }
    if (pathname === '/api/me') return send({ id: 'fixture', email: 'fixture@example.test', role: 'user', csrf: 'fixture' });
    if (pathname === '/api/me/accounts') return send({ accounts: [{ id: 'fixture', provider: 'deepseek', name: 'DeepSeek',
      accountState: 'login_required', runtimeState: 'running', sessionSaved: false, loginActive: true, models: [] }] });
    if (pathname === '/api/me/keys') return send({ keys: [] });
    if (pathname === '/api/me/accounts/deepseek/remote-ticket') return send({ ticket: 'fixture' });
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server, path: '/api/me/remote' });
  sockets.on('connection', socket => {
    let input = Buffer.alloc(0), stage = 'version', sentFrame = false;
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('message', data => {
      input = Buffer.concat([input, Buffer.from(data as Buffer)]);
      try {
        while (input.length) {
          if (stage === 'version') {
            if (input.length < 12) return;
            input = input.subarray(12); stage = 'security'; socket.send(Buffer.from([1, 1])); continue;
          }
          if (stage === 'security') {
            if (input[0] !== 1) throw new Error('Fixture supports security type None only');
            input = input.subarray(1); stage = 'client-init'; socket.send(Buffer.alloc(4)); continue;
          }
          if (stage === 'client-init') {
            input = input.subarray(1); stage = 'normal';
            const name = Buffer.from('Owned coordinate test fixture');
            const init = Buffer.alloc(24 + name.length);
            init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
            init[4] = 32; init[5] = 24; init[7] = 1;
            init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
            init[14] = 16; init[15] = 8; init[16] = 0;
            init.writeUInt32BE(name.length, 20); name.copy(init, 24); socket.send(init); continue;
          }
          const type = input[0]!;
          let size: number;
          if (type === 0) size = 20; // SetPixelFormat
          else if (type === 2) { // SetEncodings
            if (input.length < 4) return;
            size = 4 + input.readUInt16BE(2) * 4;
          } else if (type === 3) size = 10; // FramebufferUpdateRequest
          else if (type === 4) size = 8; // KeyEvent
          else if (type === 5) size = 6; // PointerEvent
          else if (type === 6) {
            if (input.length < 8) return;
            size = 8 + input.readUInt32BE(4);
          } else throw new Error('Unexpected fixture RFB message ' + type);
          if (input.length < size) return;
          if (type === 5) pointers.emit('pointer', { mask: input[1]!, x: input.readUInt16BE(2), y: input.readUInt16BE(4) });
          if (type === 3 && !sentFrame) {
            sentFrame = true;
            const frame = Buffer.alloc(16 + width * height * 4, 224);
            frame.fill(0, 0, 16); frame.writeUInt16BE(1, 2);
            frame.writeUInt16BE(width, 8); frame.writeUInt16BE(height, 10);
            socket.send(frame);
          }
          input = input.subarray(size);
        }
      } catch (error) { failures.push(String(error)); socket.close(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole('button', { name: 'Abrir login', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#remote canvas');
      return canvas?.width === 1280 && canvas.height === 900 && canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data[0]! > 0;
    });
    const nextPointer = (match: (pointer: Pointer) => boolean, description: string) => new Promise<Pointer>((resolve, reject) => {
      const timeout = setTimeout(() => { pointers.off('pointer', listener); reject(new Error('Timed out waiting for fixture pointer input: ' + description + '; ' + failures.join('; '))); }, 5000);
      const listener = (pointer: Pointer) => { if (match(pointer)) { clearTimeout(timeout); pointers.off('pointer', listener); resolve(pointer); } };
      pointers.on('pointer', listener);
    });
    const assertPoint = (actual: Pointer, expected: { x: number; y: number }, description: string, tolerance = 1) => {
      assert.ok(Math.abs(actual.x - expected.x) <= tolerance && Math.abs(actual.y - expected.y) <= tolerance,
        `${description}: expected (${expected.x}, ${expected.y}), received (${actual.x}, ${actual.y})`);
    };
    const click = async (x: number, y: number, description: string) => {
      const canvas = await page.locator('#remote canvas').boundingBox(); assert.ok(canvas);
      const pressed = nextPointer(pointer => pointer.mask === 1, description);
      await page.mouse.click(canvas.x + x * canvas.width / width, canvas.y + y * canvas.height / height);
      // At small fit scales, a CSS-pixel input is quantized to several remote pixels.
      assertPoint(await pressed, { x, y }, description, Math.ceil(width / canvas.width));
    };
    await click(600, 350, 'native-size click');
    const canvas = await page.locator('#remote canvas').boundingBox(); assert.ok(canvas);
    const pressed = nextPointer(pointer => pointer.mask === 1, 'drag start');
    await page.mouse.move(canvas.x + 300 * canvas.width / width, canvas.y + 250 * canvas.height / height);
    await page.mouse.down(); assertPoint(await pressed, { x: 300, y: 250 }, 'drag start');
    const released = nextPointer(pointer => pointer.mask === 0, 'drag end');
    await page.mouse.move(canvas.x + 700 * canvas.width / width, canvas.y + 500 * canvas.height / height, { steps: 8 });
    await page.mouse.up(); assertPoint(await released, { x: 700, y: 500 }, 'drag end');
    await page.locator('#remote-fit').click();
    await page.waitForFunction(() => document.querySelector('#remote-fit')?.getAttribute('aria-pressed') === 'true');
    const fitted = () => {
      const bounds = document.querySelector('#remote canvas')!.getBoundingClientRect();
      return bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight;
    };
    await page.waitForFunction(fitted);
    await click(600, 350, 'fitted-size click');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(fitted);
    await click(600, 350, 'narrow fitted-size click');
    await page.locator('#remote-fit').click();
    await page.locator('#remote > div').evaluate(screen => { screen.scrollLeft = 500; screen.scrollTop = 200; });
    await click(650, 450, 'scrolled native-size click');
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
