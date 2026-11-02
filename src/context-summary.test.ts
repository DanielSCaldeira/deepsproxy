import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOlderContext } from './utils/context-summary.ts';
import { serializeOpenAIMessages } from './routes/serialization.ts';
import { Message } from './utils/types.ts';

function measure(messages: Message[]): number {
  const serialized = serializeOpenAIMessages(messages);
  return (serialized.systemPrompt ? serialized.systemPrompt.length + 1 : 0) + serialized.prompt.length;
}

function longConversation(): Message[] {
  return [
    { role: 'system', content: 'Follow the original system instructions.' },
    { role: 'user', content: `Old user decision ${'A'.repeat(220)}` },
    { role: 'assistant', content: `Old assistant result ${'B'.repeat(220)}` },
    { role: 'user', content: `Second old user turn ${'C'.repeat(220)}` },
    { role: 'assistant', content: `Second old result ${'D'.repeat(220)}` },
    { role: 'user', content: `Recent user turn ${'E'.repeat(220)}` },
    { role: 'assistant', content: `Recent answer ${'F'.repeat(220)}` },
    { role: 'user', content: 'Current question' },
  ];
}

test('context summary leaves short conversations unchanged', async () => {
  const messages: Message[] = [
    { role: 'system', content: 'Keep these instructions.' },
    { role: 'user', content: 'Short question' },
  ];
  let calls = 0;
  const result = await summarizeOlderContext(messages, {
    model: 'summary-short-test',
    targetLimit: 10_000,
    measure,
    serialize: serializeOpenAIMessages,
    summarize: async () => {
      calls++;
      return 'summary';
    },
  });

  assert.strictEqual(result, messages);
  assert.strictEqual(calls, 0);
});

test('context summary replaces older turns and retains system instructions and the latest turn', async () => {
  const messages = longConversation();
  let source = '';
  const result = await summarizeOlderContext(messages, {
    model: 'summary-preserve-test',
    targetLimit: 1_000,
    measure,
    serialize: serializeOpenAIMessages,
    summarize: async (_previous, text) => {
      source += text;
      return 'Decisions: keep the chosen configuration; next step is validation.';
    },
  });

  assert.notStrictEqual(result, messages);
  assert.strictEqual(result[0].role, 'system');
  assert.strictEqual(result[0].content, 'Follow the original system instructions.');
  assert.ok(result.some((message) => message.role === 'context_summary'));
  assert.ok(result.some((message) => message.role === 'user' && message.content === 'Current question'));
  assert.ok(!result.some((message) => message.content?.includes('Old user decision')));
  assert.ok(source.includes('Old user decision'));
  assert.ok(!source.includes('Current question'));
});

test('context summary cache reuses matching history and rolls forward when it grows', async () => {
  const messages = longConversation();
  const calls: Array<{ previous: string; source: string }> = [];
  const summarize = async (previous: string, source: string) => {
    calls.push({ previous, source });
    return previous ? `${previous} | next decisions` : 'initial decisions';
  };
  const options = {
    model: 'summary-cache-test',
    targetLimit: 1_000,
    measure,
    serialize: serializeOpenAIMessages,
    summarize,
  };

  const first = await summarizeOlderContext(messages, options);
  const repeated = await summarizeOlderContext(messages, options);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(repeated, first);

  const extended = [
    ...messages,
    { role: 'assistant', content: 'The previous turn is complete.' },
    { role: 'user', content: `Continue with the next decision. ${'G'.repeat(500)}` },
  ] satisfies Message[];
  await summarizeOlderContext(extended, options);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].previous, 'initial decisions');
});

test('summary failure falls back to the original history', async () => {
  const messages = longConversation();
  const result = await summarizeOlderContext(messages, {
    model: 'summary-failure-test',
    targetLimit: 1_000,
    measure,
    serialize: serializeOpenAIMessages,
    summarize: async () => {
      throw new Error('simulated summary failure');
    },
  });

  assert.strictEqual(result, messages);
});
