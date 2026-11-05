import type { ProviderEvent, ProviderModel } from './types.ts';

/** Only account-supplied IDs are advertised; context size 0 means unknown. */
export function qwenModels(body: unknown): ProviderModel[] {
  const value = body as any;
  const models = Array.isArray(value) ? value : value?.data;
  if (!Array.isArray(models)) throw new Error('Qwen returned an invalid model catalog.');
  return models.filter(m => typeof m?.id === 'string' && m.id.length > 0).map(m => ({
    id: `qwen/${m.id}`,
    contextLength: Number.isSafeInteger(m.info?.meta?.max_context_length) && m.info.meta.max_context_length > 0
      ? m.info.meta.max_context_length : 0,
  }));
}

/** Incremental SSE framing, including split UTF-8/CRLF and multiline data fields. */
export async function* parseQwenStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', finished = false, thoughtCount = 0;
  let responseId: string | undefined;
  const parse = (frame: string): ProviderEvent[] => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || finished) return [];
    if (data === '[DONE]') { finished = true; return [{ type: 'finish' }]; }
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { throw new Error('Malformed Qwen SSE event.'); }
    if (chunk.error || chunk.success === false) throw new Error('Qwen rejected the generation.');
    responseId ??= chunk['response.created']?.response_id ?? chunk.response_id;
    const events: ProviderEvent[] = [];
    const tokens = chunk.usage?.output_tokens ?? chunk.usage?.completion_tokens;
    if (Number.isSafeInteger(tokens) && tokens >= 0) events.push({ type: 'usage', completionTokens: tokens });
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta && (!chunk.response_id || !responseId || chunk.response_id === responseId)) {
      if (delta.extra?.update_member) throw new Error('Qwen account quota or membership limit reached.');
      const thoughts = delta.extra?.summary_thought?.content;
      if (delta.phase === 'thinking_summary' && Array.isArray(thoughts)) {
        const text = thoughts.slice(thoughtCount).filter((t: unknown) => typeof t === 'string').join('\n');
        thoughtCount = thoughts.length;
        if (text) events.push({ type: 'reasoning', text });
      } else if (typeof delta.content === 'string' && delta.content && delta.content !== 'FINISHED') {
        if (['think', 'thinking'].includes(delta.phase)) events.push({ type: 'reasoning', text: delta.content });
        else if (delta.phase === 'answer' || !delta.phase) events.push({ type: 'content', text: delta.content });
      }
      // The request explicitly asks for incremental_output; never de-duplicate equal deltas.
    }
    if (choice?.finish_reason) { finished = true; events.push({ type: 'finish' }); }
    return events;
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Qwen SSE frame exceeded size limit.');
    // Preserve a trailing CR until the next chunk arrives.
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      for (const event of parse(frame)) yield event;
      if (finished) return;
    }
  }
  signal?.throwIfAborted();
  if (buffer.trim()) for (const event of parse(buffer)) yield event;
  if (!finished) throw new Error('Qwen stream ended before its completion marker.');
}

export function qwenPayload(prompt: string, model: string, thinking: boolean, chatId: string, fid: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return { stream: true, version: '2.1', incremental_output: true, chat_id: chatId, chat_mode: 'normal',
    model, parent_id: null, messages: [{ fid, parentId: null, childrenIds: [], role: 'user', content: prompt,
      user_action: 'chat', files: [], timestamp, models: [model], chat_type: 't2t',
      feature_config: { thinking_enabled: thinking, output_schema: 'phase', research_mode: 'normal',
        auto_thinking: false, thinking_mode: thinking ? 'Thinking' : 'Auto', thinking_format: 'summary', auto_search: false },
      extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t', parent_id: null }], timestamp: timestamp + 1 };
}
