import test from 'node:test';
import assert from 'node:assert/strict';
import { getGenerationGuard } from './services/generation-guard.ts';
import { upstreamMessage } from './utils/api-error.ts';

process.env.TEST_MOCK_PLAYWRIGHT = '1';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST = '1';
process.env.DEEPSPROXY_MAX_ATTEMPTS = '1';
const { app } = await import('./index.ts');

const request = (stream: boolean) => app.request('/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.API_KEY ? { authorization: `Bearer ${process.env.API_KEY}` } : {}) },
  body: JSON.stringify({ model: 'deepseek-v4-flash', stream, messages: [{ role: 'user', content: 'test' }] }),
});

test('API exposes original upstream message, instructions and login URL, including cached blocks', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, message] of [[401, 'A sessão DeepSeek expirou.'], [403, 'Sua conta foi suspensa até novembro 6, 2026 21:55.']] as const) {
      getGenerationGuard().confirmInteractiveLogin();
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message }, metadata: 'DO_NOT_FORWARD' }), { status }); };
      for (const stream of [false, true]) {
        const response = await request(stream);
        assert.equal(response.status, status);
        const { error } = await response.json();
        assert.equal(error.original_message, message);
        assert.equal(error.help_url, 'https://chat.deepseek.com/');
        assert.ok(error.message.includes(message));
        assert.match(error.message, /O que fazer:.*painel do Proxy IA/);
        assert.ok(error.message.includes(error.help_url));
        assert.match(error.user_action, /tela remota que abre dentro do site/);
        assert.doesNotMatch(JSON.stringify(error), /DO_NOT_FORWARD/);
      }
      assert.equal(calls, 1);
    }
  } finally { getGenerationGuard().confirmInteractiveLogin(); globalThis.fetch = originalFetch; }
});

test('errors after streaming begins emit the same actionable error envelope before DONE', async () => {
  const originalFetch = globalThis.fetch;
  let pulls = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"partial"}\n\n'));
      else controller.error(new Error('Connection lost while reading DeepSeek response'));
    },
  }));
  try {
    const response = await request(true);
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = body.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    const failure = events.find(event => event.error)?.error;
    assert.equal(failure.original_message, 'Connection lost while reading DeepSeek response');
    assert.match(failure.message, /O que fazer:/);
    assert.match(failure.user_action, /conexão/);
    assert.ok(body.endsWith('data: [DONE]\n\n'));
  } finally { globalThis.fetch = originalFetch; }
});

test('upstream message extraction selects only error text and handles non-JSON responses', () => {
  assert.equal(upstreamMessage('{"msg":"real error","token":"SECRET"}'), 'real error');
  assert.equal(upstreamMessage('{"msg":"","data":{"biz_msg":"actual account error"}}'), 'actual account error');
  assert.equal(upstreamMessage('{"code":403,"token":"SECRET"}'), null);
  assert.equal(upstreamMessage('<html>server error page</html>'), null);
  assert.equal(upstreamMessage('Service unavailable'), 'Service unavailable');
  assert.equal(upstreamMessage('x'.repeat(5000))?.length, 4096);
});
