// Temporary loopback-only recorder for the real Zed client. Never stores API keys.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const origin = process.env.DSP_LAB_ORIGIN || 'http://localhost:3440';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const directory = '.cache/zed-agent-validation';
await mkdir(directory, { recursive: true });
const admin = JSON.parse((await readFile('.cache/proxy-ia-live-admin.json', 'utf8')).replace(/^\uFEFF/, ''));
const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(admin) });
assert.equal(login.status, 200, 'Local lab authentication failed');
const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json()).csrf;
async function panel(path: string, method: string, body?: unknown) {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Lab operation failed: ${response.status}`);
  return response.json();
}
const temporary = await panel('/api/me/keys', 'POST', { name: 'Temporary real Zed validation' });
const report: any = { startedAt: new Date().toISOString(), keyId: temporary.id, requests: [] };
const save = () => writeFile(directory + '/http-evidence.json', JSON.stringify(report, null, 2) + '\n');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  try { await panel('/api/me/keys/' + temporary.id, 'DELETE'); report.keyRevoked = true; }
  catch { report.cleanupError = 'Revoke temporary key through local panel'; }
  report.finishedAt = new Date().toISOString(); await save(); process.exit(report.keyRevoked ? 0 : 1);
}
const server = createServer(async (request, response) => {
  if (!['/v1/chat/completions', '/v1/models'].includes(request.url || '')) { response.writeHead(404).end(); return; }
  const evidence: any = { startedAt: new Date().toISOString(), path: request.url };
  report.requests.push(evidence);
  try {
    const chunks: Buffer[] = [];
    for await (const part of request) chunks.push(Buffer.from(part));
    const raw = Buffer.concat(chunks).toString();
    if (raw) {
      const body = JSON.parse(raw);
      evidence.request = body; // Private cache only: controlled test workspace, no credentials.
      evidence.model = body.model;
    }
    const upstream = await fetch(origin + request.url, { method: request.method, headers: { Authorization: 'Bearer ' + temporary.key, 'Content-Type': 'application/json' }, body: raw || undefined, signal: AbortSignal.timeout(240_000) });
    evidence.status = upstream.status;
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    let text = '';
    for await (const chunk of upstream.body!) { text += Buffer.from(chunk).toString(); response.write(chunk); }
    evidence.response = text; response.end();
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Validation bridge transport failed' } }));
  } finally { evidence.finishedAt = new Date().toISOString(); await save(); }
});
server.on('error', () => { void stop(); });
server.listen(3451, '127.0.0.1', () => console.log('Zed recorder: http://127.0.0.1:3451/v1 (unmodified protocol; key kept in memory)'));
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
setTimeout(() => { void stop(); }, 2 * 60 * 60_000).unref();
await save();
