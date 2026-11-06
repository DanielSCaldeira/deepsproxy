import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** Cohere status/code mapping. A generic 403 is never treated as a suspension. */
export function cohereError(status: number, code?: string): UpstreamError {
  if (code && /^(account_(suspended|disabled|deactivated)|organization_disabled|user_blocked)$/.test(code))
    return new UpstreamError('Cohere account is suspended.', 403);
  if (status === 401) return new UpstreamError('Cohere login is required.', 401);
  if (status === 429 || (code && /rate_limit|too_many_requests|trial_limit|quota|usage_limit/.test(code)))
    return new UpstreamError('Cohere usage limit reached.', 429);
  return new UpstreamError(`Cohere web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

/** Catalog in the public Cohere `GET /v1/models` shape; only chat-capable models. */
export function cohereModels(body: unknown): Array<ProviderModel & { label: string }> {
  const models = (body as any)?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  return models.filter(m => typeof m?.name === 'string' && /^[\w.:-]{1,120}$/.test(m.name) &&
    m.is_deprecated !== true && (!Array.isArray(m.endpoints) || m.endpoints.includes('chat')) &&
    !seen.has(m.name) && seen.add(m.name)).map(m => ({
    id: `cohere/${m.name}`, label: m.name,
    // The API catalog's context_length is not proof of the playground's own limits.
    contextLength: 0,
  }));
}

const FAILED_FINISH = /^(ERROR|ERROR_TOXIC|ERROR_LIMIT|USER_CANCEL)$/i;

/**
 * Decode Cohere chat streams:
 * - v2 SSE (`event: content-delta` / `data: {"type":"content-delta",...}` ... `message-end`);
 * - v1 NDJSON (`{"event_type":"text-generation","text":...}` ... `stream-end`).
 * Thinking content is never emitted; only the final text channel is returned.
 */
export async function* parseCohereStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', completed = false, text = false;
  const finish = (tokens?: unknown): ProviderEvent[] => {
    if (!text) throw new UpstreamError('Cohere returned no final text.', 502);
    completed = true;
    return [...(Number.isSafeInteger(tokens) && (tokens as number) >= 0 ? [{ type: 'usage' as const, completionTokens: tokens as number }] : []), { type: 'finish' }];
  };
  const content = (value: unknown): ProviderEvent[] => {
    if (typeof value !== 'string' || !value) return [];
    text = true; return [{ type: 'content', text: value }];
  };
  const object = (value: any): ProviderEvent[] => {
    if (!value || typeof value !== 'object') throw new UpstreamError('Invalid Cohere stream event.', 502);
    const type = value.type ?? value.event_type;
    switch (type) {
      // v2
      case 'content-delta': return content(value.delta?.message?.content?.text);
      case 'message-end': {
        const reason = value.delta?.finish_reason;
        if (typeof reason === 'string' && FAILED_FINISH.test(reason)) throw cohereError(502, value.delta?.error ? 'stream_error' : undefined);
        const usage = value.delta?.usage;
        return finish(usage?.tokens?.output_tokens ?? usage?.billed_units?.output_tokens);
      }
      // v1
      case 'text-generation': return content(value.text);
      case 'stream-end': {
        const reason = value.finish_reason;
        if (typeof reason === 'string' && FAILED_FINISH.test(reason)) throw cohereError(502);
        const meta = value.response?.meta;
        return finish(meta?.tokens?.output_tokens ?? meta?.billed_units?.output_tokens);
      }
      case 'error': throw cohereError(Number(value.status) || 502, typeof value.code === 'string' ? value.code : undefined);
      default: return [];
    }
  };
  const line = (raw: string): ProviderEvent[] => {
    const trimmed = raw.trim();
    if (!trimmed || completed || trimmed.startsWith(':') || /^(event|id|retry):/.test(trimmed)) return [];
    const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!data) return [];
    if (data === '[DONE]') return completed ? [] : finish();
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Cohere stream data.', 502); }
    return object(value);
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Cohere stream frame too large.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      yield* line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (completed) return;
    }
  }
  if (buffer.trim()) yield* line(buffer);
  if (!completed) throw new UpstreamError('Cohere response ended before completion.', 502);
}
