import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';
import { decodeDeepSeekStream } from './providers/deepseek.ts';
import { providerId, providerIdForModel } from './providers/catalog.ts';
import type { ProviderEvent } from './providers/types.ts';

test('provider catalog rejects invalid identities and keeps model namespaces distinct', () => {
  assert.equal(providerId(undefined), 'deepseek');
  assert.equal(providerId('qwen'), 'qwen');
  assert.throws(() => providerId('other'), /Unsupported provider/);
  assert.equal(providerIdForModel('deepseek-v4-pro'), 'deepseek');
  assert.equal(providerIdForModel('qwen/qwen3-max'), 'qwen');
  assert.equal(providerIdForModel('unknown'), null);
});

test('normalized events preserve reasoning, whitespace and usage for any provider', async () => {
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'reasoning', text: 'checking' };
    yield { type: 'content', text: '  Hello' };
    yield { type: 'content', text: '\nworld  ' };
    yield { type: 'usage', completionTokens: 12 };
    yield { type: 'finish' };
  }
  const chunks: any[] = [];
  const result = await parseProviderStreamToOpenAI(events(), 'id', 'qwen/test', 7, [], async chunk => { chunks.push(chunk); });
  assert.equal(result.content, '  Hello\nworld  ');
  assert.equal(result.reasoningContent, 'checking');
  assert.equal(result.usage.total_tokens, 19);
  assert.equal(chunks[0].choices[0].delta.reasoning_content, 'checking');
});

test('DeepSeek decoder accepts fragmented UTF-8 and a final frame without newline', async () => {
  const bytes = new TextEncoder().encode('data: {"p":"response/content","v":"olá"}\n' +
    'data: {"p":"response/accumulated_token_usage","v":4}');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const result = await parseProviderStreamToOpenAI(decodeDeepSeekStream(stream, ''), 'id', 'deepseek-v4-flash', 2);
  assert.equal(result.content, 'olá');
  assert.equal(result.usage.completion_tokens, 4);
});

test('downstream failure propagates and cancels unread provider bytes', async () => {
  let cancelled = 0;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"p":"response/content","v":"hello"}\n')); },
    cancel() { cancelled++; },
  });
  await assert.rejects(parseProviderStreamToOpenAI(decodeDeepSeekStream(stream, ''), 'id', 'deepseek-v4-flash', 2, [], async () => {
    throw new Error('downstream unavailable');
  }), /downstream unavailable/);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('provider errors remain visible and close the iterator', async () => {
  let closed = false;
  async function* events(): AsyncGenerator<ProviderEvent> {
    try { yield { type: 'content', text: 'start' }; throw new Error('upstream failed'); }
    finally { closed = true; }
  }
  await assert.rejects(parseProviderStreamToOpenAI(events(), 'id', 'qwen/test', 0), /upstream failed/);
  assert.equal(closed, true);
});

test('failed tool delivery propagates instead of being treated as malformed model output', async () => {
  let closed=false;
  async function* events(): AsyncGenerator<ProviderEvent> {
    try { yield {type:'content',text:'<tool_call>{"name":"terminal","arguments":{"command":"echo test"}}</tool_call>'}; }
    finally {closed=true;}
  }
  const delivery=new Error('tool delivery failed');
  await assert.rejects(parseProviderStreamToOpenAI(events(),'id','qwen/test',0,[],async()=>{throw delivery;}),error=>error===delivery);
  assert.equal(closed,true);
});
