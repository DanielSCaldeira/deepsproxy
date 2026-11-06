import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** The web chat has no model picker; the site chooses the model behind one chat surface. */
export const QUILLBOT_MODELS: readonly ProviderModel[] = [{ id: 'quillbot/chat', contextLength: 0 }];

/** Map HTTP status and the frontend's error codes; a generic 403 is never a suspension. */
export function quillBotError(status: number, code?: string): UpstreamError {
  if (code && /^(auth\/user-disabled|USER_DISABLED|ACCOUNT_DISABLED|ACCOUNT_SUSPENDED|USER_BANNED)$/i.test(code))
    return new UpstreamError('QuillBot account is suspended.', 403);
  if (status === 401 || (code && /^(auth\/user-token-expired|UNAUTHENTICATED|COM_UNAUTHORIZED)$/i.test(code)))
    return new UpstreamError('QuillBot login is required.', 401);
  if (status === 429 || (code && /LIMIT|QUOTA|rate_limited/i.test(code)))
    return new UpstreamError('QuillBot usage limit reached.', 429);
  return new UpstreamError(`QuillBot web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

/**
 * Decode the AI Chat response: newline-delimited JSON events observed in the
 * public ai-chat-core bundle. `content` carries deltas for the current message
 * part; `status: completed` is the only successful completion signal.
 */
export async function* parseQuillBotStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', completed = false, emitted = false, separator = false, part = 0;
  const line = (raw: string): ProviderEvent[] => {
    const text = raw.trim();
    if (!text) return [];
    let value: any;
    try { value = JSON.parse(text); } catch { throw new UpstreamError('Malformed QuillBot stream data.', 502); }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new UpstreamError('Malformed QuillBot stream event.', 502);
    if (value.type === 'usage') {
      return Number.isSafeInteger(value.output_tokens) && value.output_tokens >= 0 ? [{ type: 'usage', completionTokens: value.output_tokens }] : [];
    }
    if (completed) return [];
    switch (value.type) {
      case 'content': {
        if (typeof value.content !== 'string') throw new UpstreamError('Malformed QuillBot content event.', 502);
        if (!value.content) return [];
        const prefix = separator && emitted ? '\n\n' : '';
        separator = false; emitted = true;
        return [{ type: 'content', text: prefix + value.content }];
      }
      case 'message_part':
        // A new part is a separate assistant bubble on the site (for example after a tool).
        if (typeof value.index === 'number' && value.index > part) { part = value.index; separator = emitted; }
        return [];
      case 'status':
        if (value.status === 'completed') {
          if (!emitted) throw new UpstreamError('QuillBot returned no final text.', 502);
          completed = true; return [];
        }
        if (value.status === 'failed' || value.status === 'incomplete' || value.status === 'cancelled')
          throw new UpstreamError(`QuillBot generation ${value.status}.`, 502);
        return [];
      case 'rate_limited': throw quillBotError(429, 'rate_limited');
      case 'tool_progress':
        if (value.status === 'rate_limited') throw quillBotError(429, 'rate_limited');
        return [];
      case 'error': {
        const code = typeof value.error?.code === 'string' ? value.error.code : undefined;
        throw quillBotError(502, code);
      }
      // title, file, annotation and ui_part are presentation data, not response text.
      default: return [];
    }
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('QuillBot stream line too large.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      yield* line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
    }
  }
  signal?.throwIfAborted();
  if (buffer.trim()) yield* line(buffer);
  if (!completed) throw new UpstreamError('QuillBot response ended before completion.', 502);
  yield { type: 'finish' };
}
