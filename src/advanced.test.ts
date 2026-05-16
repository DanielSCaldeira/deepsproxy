import test from 'node:test';
import assert from 'node:assert';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { app } from './index.ts';

// Helper to mock the fetch global for testing empty response retry and caching logic
function setupFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : ('url' in input ? input.url : String(input));
    if (urlStr.includes('chat.deepseek.com')) {
      return handler(urlStr, init);
    }
    return originalFetch(input, init);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('multiturn-thinking-tools: serializes complete OpenAI message history', async () => {
  let capturedPrompt = '';

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPrompt = bodyObj.prompt;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'doing something', reasoning_content: 'thinking about hello', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test', arguments: '{}' } }] },
          { role: 'tool', name: 'test', content: 'success' }
        ]
      })
    });
    
    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);

    // Validate that the complete OpenAI history is sent to DeepSeek. Agents
    // need the original user request, assistant tool call, and tool result to
    // produce the post-tool final answer.
    assert.ok(capturedPrompt.includes('User: hello'), 'Must include original user message');
    assert.ok(capturedPrompt.includes('Assistant:'), 'Must include assistant history');
    assert.ok(capturedPrompt.includes('<think>\nthinking about hello\n</think>'), 'Must include previous thinking');
    assert.ok(capturedPrompt.includes('<tool_call>{"name": "test", "arguments": {}}</tool_call>'), 'Must include previous tool call');
    assert.ok(capturedPrompt.includes('Tool Response (test): success'), 'Must include tool response signature');
  } finally {
    restore();
  }
});

test('streaming-whitespace: preserves exact whitespace', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"   "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"  hello  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"o":"APPEND","v":"\\n\\n  "}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.choices?.[0]?.delta?.content) {
              full += data.choices[0].delta.content;
            }
          } catch(e) {}
        }
      }
    }
    
    // We expect exactly: "     hello  \n\n  "
    assert.strictEqual(full, "     hello  \n\n  ");
  } finally {
    restore();
  }
});

test('caching-streaming and cache-control: returns prompt_tokens_details', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"v":{"response":{"message_id":1}}}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"done"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/accumulated_token_usage","o":"SET","v":10}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash-thinking', messages: [{role: 'user', content: 'test'}], stream: true })
    });
    
    const res = await app.fetch(req);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let usageBlock = null;
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.usage) {
              usageBlock = data.usage;
            }
          } catch(e) {}
        }
      }
    }
    
    assert.ok(usageBlock);
    assert.strictEqual(usageBlock.completion_tokens, 10);
    assert.ok(usageBlock.prompt_tokens > 0);
    assert.strictEqual(usageBlock.prompt_tokens_details.cached_tokens, 0); // Tests caching-streaming shape!
  } finally {
    restore();
  }
});

test('openai-requests-are-stateless: each request starts a fresh DeepSeek turn', async () => {
  let capturedPayloads: any[] = [];

  const restore = setupFetchMock((url, init) => {
    const bodyObj = JSON.parse(init?.body as string || '{}');
    capturedPayloads.push(bodyObj);
    
    // Simulate DeepSeek returning a message_id
    const mockMessageId = capturedPayloads.length === 1 ? 1001 : 1002;
    
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: {"v":{"response":{"message_id":${mockMessageId}}}}\n\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    process.env.TEST_SESSION_ID = 'test-session-parent-tracking';
    // Turn 1
    const req1 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [{ role: 'user', content: 'Turn 1' }]
      })
    });
    
    const res1 = await app.fetch(req1);
    assert.strictEqual(res1.status, 200);
    // Consume the stream to ensure the message_id is processed
    await res1.text();

    // Turn 2
    const req2 = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-thinking',
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Response 1' },
          { role: 'user', content: 'Turn 2' }
        ]
      })
    });
    
    const res2 = await app.fetch(req2);
    assert.strictEqual(res2.status, 200);
    await res2.text();

    assert.strictEqual(capturedPayloads.length, 2);
    // In Turn 1, parent_message_id should be null (mock-session is fresh)
    assert.strictEqual(capturedPayloads[0].parent_message_id, null);
    // OpenAI chat/completions requests are self-contained; the proxy must not
    // reuse DeepSeek's previous parent_message_id because compressed or edited
    // OpenAI histories no longer match the browser-side DeepSeek thread.
    assert.strictEqual(capturedPayloads[1].parent_message_id, null, 'Turn 2 should start a fresh DeepSeek turn');
    assert.strictEqual(
      capturedPayloads[1].prompt,
      'User: Turn 1\n\nAssistant: Response 1\n\nUser: Turn 2\n\n',
      'Should send complete message history'
    );
  } finally {
    restore();
  }
});

test('non-stream chat completion returns OpenAI JSON instead of SSE', async () => {
  const restore = setupFetchMock((url) => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":" world"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  });

  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{role: 'user', content: 'test'}], stream: false })
    });

    const res = await app.fetch(req);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('Content-Type') || '', /^application\/json/);

    const body = await res.json();
    assert.strictEqual(body.object, 'chat.completion');
    assert.strictEqual(body.choices[0].message.role, 'assistant');
    assert.strictEqual(body.choices[0].message.content, 'hello world');
    assert.strictEqual(body.choices[0].finish_reason, 'stop');
  } finally {
    restore();
  }
});
