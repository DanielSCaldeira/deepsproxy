import test from 'node:test';
import assert from 'node:assert';
import { app } from './index.ts';
import { initPlaywright, closePlaywright } from './services/playwright.ts';

test('Status page is available at the root without exposing protected status', async () => {
  const previousKey = process.env.API_KEY;
  process.env.API_KEY = 'status-test-secret';
  try {
    const page = await app.request('/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.match(html, /Status da conexão/);
    assert.ok(!html.includes('status-test-secret'));
    const denied = await app.request('/api/status');
    assert.strictEqual(denied.status, 401);
    const allowed = await app.request('/api/status', { headers: { Authorization: 'Bearer status-test-secret' } });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.headers.get('cache-control'), 'no-store');
    const data = await allowed.json();
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.deepseek.state, 'not_initialized');
    assert.strictEqual(typeof data.deepseek.sessionSaved, 'boolean');
    assert.ok(!JSON.stringify(data).includes('cookie'));
    assert.ok(!JSON.stringify(data).includes('authorization'));
  } finally {
    if (previousKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousKey;
  }
});

test('Health check endpoint returns status ok', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

test('Models endpoint returns deepseek-v4-flash and deepseek-v4-flash-thinking', async () => {
  const req = new Request('http://localhost/v1/models');
  const res = await app.fetch(req);
  
  assert.strictEqual(res.status, 200);
  
  const body = await res.json();
  assert.strictEqual(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash'));
  assert.ok(body.data.some((m: any) => m.id === 'deepseek-v4-flash-thinking'));
  const flash = body.data.find((m: any) => m.id === 'deepseek-v4-flash');
  const flashThinking = body.data.find((m: any) => m.id === 'deepseek-v4-flash-thinking');
  assert.strictEqual(typeof flash.context_length, 'number');
  assert.ok(flash.context_length >= 512_000);
  assert.ok(flashThinking.context_length >= 512_000);
  assert.strictEqual(typeof flash.max_context_tokens, 'number');
});

test('Chat Completions endpoint with deepseek-v4-flash-thinking (thinking enabled)', { skip: process.env.DEEPSPROXY_RUN_LIVE_TESTS !== '1' }, async () => {
  // Initialize playwright for this test
  // NOTE: Headless mode can sometimes fail Cloudflare checks. We use headless=false for the test
  // to ensure it matches the logged-in browser state if needed, or you can switch it to true.
  await initPlaywright(false);

  try {
    const payload = {
      model: 'deepseek-v4-flash-thinking',
      messages: [{ role: 'user', content: 'What is 99 * 182? Please think step by step.' }],
      stream: true
    };

    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/event-stream');

    const reader = res.body?.getReader();
    assert.ok(reader, 'Response should have a readable body');

    const decoder = new TextDecoder();
    let hasReasoning = false;
    let hasContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          break;
        }
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6);
            if (dataStr !== '[DONE]') {
              const data = JSON.parse(dataStr);
              
              if (data.choices && data.choices[0] && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.content) {
                hasContent = true;
              }
                if (delta.reasoning_content) {
                  hasReasoning = true;
                }
              }
            }
          } catch (err) {
            // Partial JSON ignored
            // console.error("Parse error:", err);
          }
        }
      }
    }

    assert.ok(hasReasoning, 'Should have received streamed chunks with reasoning_content (Thinking enabled)');
    assert.ok(hasContent, 'Should have received streamed chunks with content');
  } finally {
    await closePlaywright();
  }
});
