import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeOpenAIMessages, appendToolInstructions } from './routes/serialization.ts';
import { parseDeepSeekStreamToOpenAI } from './routes/stream.ts';
import { ToolCallError, parseDSMLToolCalls } from './routes/tool-parser.ts';
import type { OpenAIRequest, ToolChoice } from './utils/types.ts';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.DEEPSPROXY_REQUEST_DELAY_MIN_MS = '0';
process.env.DEEPSPROXY_REQUEST_DELAY_MAX_MS = '0';
process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST = '1';
const { app } = await import('./index.ts');

const tools = [{
  type: 'function' as const,
  function: {
    name: 'terminal', description: 'Execute a command',
    parameters: {
      type: 'object', properties: { command: { type: 'string' }, cd: { type: 'string' }, timeout_ms: { type: 'integer' } },
      required: ['command'],
    },
  },
}];
const command = 'gh issue list --state open --limit 100 --json number,title,labels,createdAt,updatedAt';
const directory = 'D:\\git\\WhatsAppBrowserApi';
const invoke = `<｜｜DSML｜｜ invoke name="terminal">
<｜｜DSML｜｜ parameter name="command" string="true">${command}</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="cd" string="true">${directory}</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="timeout_ms" string="false">60000</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>`;
const dsml = `<｜｜DSML｜｜ calls>\n${invoke}\n</｜｜DSML｜｜ calls>`;
const example = `I'll check the open GitHub issues and then verify which ones can be closed against the current code.\n\n${dsml}`;

function upstream(parts: string[], splitBytes = false): ReadableStream<Uint8Array> {
  const text = parts.map(v => `data: ${JSON.stringify({ p: 'response/content', v })}\n\n`).join('');
  // Intentionally omit the final SSE newline, and optionally split UTF-8 characters.
  const bytes = new TextEncoder().encode(text.trimEnd());
  return new ReadableStream({ start(controller) {
    if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
}

function parse(parts: string[], events: any[] = [], toolChoice?: ToolChoice, splitBytes = false) {
  return parseDeepSeekStreamToOpenAI(upstream(parts, splitBytes), 'test', 'test-model', 10, '', tools,
    async event => { events.push(event); }, toolChoice);
}

test('original DSML response becomes a terminal call with exact arguments', async () => {
  const result = await parse([example]);
  assert.equal(result.finishReason, 'tool_calls');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'terminal');
  assert.match(result.toolCalls[0].id!, /^call_/);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { command, cd: directory, timeout_ms: 60000 });
  assert.ok(!result.content.includes('DSML'));
});

test('DSML survives every content boundary and UTF-8 byte boundary without marker leaks', async () => {
  const events: any[] = [];
  const result = await parse([...example], events, undefined, true);
  assert.equal(result.toolCalls.length, 1);
  const content = events.map(e => e.choices[0].delta.content || '').join('');
  assert.ok(!content.includes('DSML'));
  assert.ok(!content.includes('<｜'));
  const callEvents = events.flatMap(e => e.choices[0].delta.tool_calls || []);
  assert.deepEqual(callEvents, result.toolCalls);
  assert.deepEqual(JSON.parse(callEvents[0].function.arguments), { command, cd: directory, timeout_ms: 60000 });
});

test('multiple DSML invokes retain order and get unique identifiers', async () => {
  const result = await parse([`<｜｜DSML｜｜ calls>${invoke}${invoke}</｜｜DSML｜｜ calls>`]);
  assert.deepEqual(result.toolCalls.map(c => c.index), [0, 1]);
  assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
  const mixed = await parse(['<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>', dsml], [], 'auto');
  assert.equal(mixed.toolCalls.length, 2);
  assert.equal(JSON.parse(mixed.toolCalls[0].function.arguments).command, 'pwd');
  assert.equal(JSON.parse(mixed.toolCalls[1].function.arguments).command, command);
});

test('standalone DSML invokes and zero-argument tools work', async () => {
  assert.equal((await parse([invoke])).toolCalls.length, 1);
  const parsed = parseDSMLToolCalls('<｜｜DSML｜｜ invoke name="ping"></｜｜DSML｜｜ invoke>', '<｜｜DSML｜｜ calls>',
    [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }]);
  assert.equal(parsed.calls[0].name, 'ping');
  assert.equal(Object.keys(parsed.calls[0].arguments).length, 0);
});

test('DSML string parameters preserve whitespace, numeric strings and shell characters', async () => {
  for (const value of ['  001  ', 'true', 'null', ' echo "$HOME"; `literal`\r\nnext line ', 'a &amp;&amp; b &lt; c']) {
    const result = await parse([`<｜｜DSML｜｜ invoke name="terminal"><｜｜DSML｜｜ parameter name="command" string="true">${value}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`]);
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).command,
      value === 'a &amp;&amp; b &lt; c' ? 'a && b < c' : value);
  }
});

test('DSML non-string parameters preserve JSON types', () => {
  for (const value of [false, null, 42, { nested: [1, 'two'] }, [true, 2]]) {
    const parsed = parseDSMLToolCalls(`<｜｜DSML｜｜ parameter name="value" string="false">${JSON.stringify(value)}</｜｜DSML｜｜ parameter>`,
      '<｜｜DSML｜｜ invoke name="test">', [{ function: { name: 'test' } }]);
    assert.deepEqual(parsed.calls[0].arguments.value, value);
  }
});

test('truncated, unknown or invalid DSML returns an error and never emits an executable call', async () => {
  for (const value of [
    '<｜｜DSML｜｜ calls>', '<｜｜DSML｜｜ cal', '<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>',
    dsml.replace('</｜｜DSML｜｜ calls>', ''), dsml.replace('</｜｜DSML｜｜ parameter>', ''),
    dsml.replace('60000', 'invalid JSON'), dsml.replace('name="terminal"', 'name="unknown"'),
    dsml.replace('name="command" string="true"', 'name="command" string="false"').replace(command, '42'),
  ]) {
    const events: any[] = [];
    await assert.rejects(parse([...value], events), ToolCallError, value);
    assert.equal(events.flatMap(e => e.choices[0].delta.tool_calls || []).length, 0);
    assert.ok(!events.some(e => (e.choices[0].delta.content || '').includes('DSML')));
  }
});

test('a malformed invoke does not erase another complete valid invoke', async () => {
  const result = await parse([`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="unknown"></｜｜DSML｜｜ invoke>${invoke}</｜｜DSML｜｜ calls>`]);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'terminal');
});

test('tool_choice is enforced for DSML and existing tool_call format', async () => {
  for (const value of [dsml, '<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>']) {
    await assert.rejects(parse([value], [], 'none'), ToolCallError);
    await assert.rejects(parse([value], [], { type: 'function', function: { name: 'other' } }), ToolCallError);
    assert.equal((await parse([value], [], 'required')).toolCalls.length, 1);
    assert.equal((await parse([value], [], { type: 'function', function: { name: 'terminal' } })).toolCalls.length, 1);
  }
  await assert.rejects(parse(['only text'], [], 'required'), ToolCallError);
  assert.equal((await parse(['only text'], [], 'none')).content, 'only text');
});

test('ordinary content, reasoning output and legacy JSON/XML remain supported', async () => {
  const text = '  Português: a < b\nJSON: {"answer": 42}\n';
  assert.equal((await parse([...text])).content, text);
  const json = await parse(['<tool_call>{"name":"terminal","arguments":{"command":"pwd"}}</tool_call>']);
  const xml = await parse(['<tool_call name="terminal"><parameter name="command">pwd</parameter></tool_call>']);
  assert.deepEqual(json.toolCalls[0].function, xml.toolCalls[0].function);
  const bytes = new TextEncoder().encode('data: {"p":"response/thinking_content","v":"reasoning"}\n\ndata: {"p":"response/content","v":"answer"}\n\n');
  const result = await parseDeepSeekStreamToOpenAI(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), 'test', 'test', 0, '');
  assert.equal(result.reasoningContent, 'reasoning');
  assert.equal(result.content, 'answer');
});

test('input retains user intent, Zed rules and useful history without previous reasoning', () => {
  const messages = [
    { role: 'system', content: 'Zed rules: use Portuguese and preserve files.' },
    { role: 'user', content: 'Verifique as issues abertas.' },
    { role: 'assistant', content: 'Vou verificar.', reasoning_content: 'old hidden reasoning',
      tool_calls: [{ id: 'call_original', type: 'function' as const, function: { name: 'terminal', arguments: '{"command":"gh issue list"}' } }] },
    { role: 'tool', tool_call_id: 'call_original', content: 'Issue 42 is open.' },
    { role: 'user', content: 'Confira se já foi resolvida no código.' },
  ];
  const before = JSON.stringify(messages);
  const serialized = serializeOpenAIMessages(messages);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(serialized.systemPrompt.trim(), messages[0].content);
  for (const text of [messages[1].content, 'gh issue list', 'Issue 42 is open.', messages[4].content]) assert.ok(serialized.prompt.includes(text));
  assert.ok(!serialized.prompt.includes('old hidden reasoning'));
  assert.ok(!serialized.prompt.includes('<think>'));
  const body: OpenAIRequest = { model: 'test', messages, tools };
  const prompt = appendToolInstructions(serialized.systemPrompt, body);
  assert.ok(prompt.startsWith(serialized.systemPrompt));
  assert.ok(prompt.includes(JSON.stringify(tools[0].function)));
  assert.ok(prompt.length - serialized.systemPrompt.length < 650);
  assert.match(appendToolInstructions('', { ...body, tool_choice: 'required' }), /Call at least one/);
  assert.match(appendToolInstructions('', { ...body, tool_choice: { type: 'function', function: { name: 'terminal' } } }), /MUST call the tool "terminal"/);
  const none = appendToolInstructions('', { ...body, tool_choice: 'none' });
  assert.ok(!none.includes('Execute a command'));
  assert.match(none, /Do not call tools/);
  assert.equal(appendToolInstructions('unchanged', { model: 'test', messages: [] }), 'unchanged');
});

test('HTTP boundary returns native OpenAI calls and structured DSML errors in both modes', async () => {
  const originalFetch = globalThis.fetch;
  let responseText = example;
  let capturedPrompt = '';
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(upstream([...responseText]), { status: 200 });
  };
  try {
    for (const stream of [false, true]) {
      for (const valid of [true, false]) {
        requests = 0;
        responseText = valid ? example : dsml.slice(0, -15);
        globalThis.fetch = async (_input, init) => {
          capturedPrompt = JSON.parse(init?.body as string).prompt;
          requests++;
          return new Response(upstream([...responseText]), { status: 200 });
        };
        const res = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Verifique as issues abertas.' }], tools, stream }) });
        assert.equal(requests, 1);
        assert.ok(capturedPrompt.includes('Verifique as issues abertas.'));
        if (stream) {
          assert.equal(res.status, 200);
          const raw = await res.text();
          const events = raw.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]')).map(l => JSON.parse(l.slice(6)));
          if (valid) {
            const calls = events.flatMap(e => e.choices?.[0].delta.tool_calls || []);
            assert.equal(calls.length, 1);
            assert.deepEqual(JSON.parse(calls[0].function.arguments), { command, cd: directory, timeout_ms: 60000 });
            assert.ok(events.some(e => e.choices?.[0].finish_reason === 'tool_calls'));
          } else {
            assert.ok(events.some(e => e.error?.code === 'invalid_tool_call'));
            assert.ok(!events.some(e => e.choices?.[0].delta.tool_calls));
          }
          assert.ok(!raw.includes('DSML'));
          assert.ok(raw.endsWith('data: [DONE]\n\n'));
        } else {
          assert.equal(res.status, valid ? 200 : 502);
          const body = await res.json();
          if (valid) {
            assert.equal(body.choices[0].message.content, null);
            assert.equal(body.choices[0].finish_reason, 'tool_calls');
            assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { command, cd: directory, timeout_ms: 60000 });
          } else assert.equal(body.error.code, 'invalid_tool_call');
        }
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});
