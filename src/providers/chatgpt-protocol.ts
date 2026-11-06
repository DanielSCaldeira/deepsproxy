import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** These codes are service errors, never diagnoses inferred from a generic 403. */
export function chatGPTError(status: number, code?: string): UpstreamError {
  if (code && /^(account_deactivated|account_suspended|deactivated_account)$/.test(code))
    return new UpstreamError('ChatGPT account is suspended.', 403);
  if (status === 401) return new UpstreamError('ChatGPT login is required.', 401);
  if (status === 429 || (code && /rate_limit|quota|usage_limit|message_limit/.test(code)))
    return new UpstreamError('ChatGPT usage limit reached.', 429);
  return new UpstreamError(`ChatGPT web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

export function chatGPTModels(body: unknown): Array<ProviderModel & { label: string }> {
  const models = (body as any)?.models;
  if (!Array.isArray(models)) return [];
  return models.filter(m => typeof m?.slug === 'string' && /^[\w.-]+$/.test(m.slug) &&
    typeof m.title === 'string' && m.title && m.disabled !== true && m.is_available !== false).map(m => ({
    id: `chatgpt/${m.slug}`, label: m.title,
    // The web catalog's token fields are not treated as a verified context window.
    contextLength: 0,
  }));
}

type Delta = { channel: number; path: string; op: string; value?: any };
const safeKey = (key: string) => {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new UpstreamError('Unsafe ChatGPT delta path.', 502);
  return key;
};

/** v1 JSON deltas: channel/path/op inherit; values never inherit. */
class DeltaDecoder {
  private channels = new Map<number, any>();
  private previous: Delta = { channel: 0, path: '', op: 'add' };
  apply(raw: any): any {
    if (!raw || typeof raw !== 'object') throw new UpstreamError('Invalid ChatGPT delta.', 502);
    const delta: Delta = { channel: raw.c ?? this.previous.channel, path: raw.p ?? this.previous.path,
      op: raw.o ?? this.previous.op, value: raw.v };
    if (!Number.isSafeInteger(delta.channel) || delta.channel < 0 || this.channels.size > 64)
      throw new UpstreamError('Invalid ChatGPT delta channel.', 502);
    const root = { value: this.channels.get(delta.channel) };
    this.patch(root, ['value'], delta);
    this.channels.set(delta.channel, root.value); this.previous = delta;
    return root.value;
  }
  private patch(root: any, prefix: string[], delta: Pick<Delta, 'path' | 'op' | 'value'>, depth = 0): void {
    if (depth > 32 || typeof delta.path !== 'string' || delta.path.length > 4096)
      throw new UpstreamError('Invalid ChatGPT delta path.', 502);
    const keys = [...prefix, ...(delta.path ? delta.path.replace(/^\//, '').split('/').map(k => safeKey(k.replace(/~1/g, '/').replace(/~0/g, '~'))) : [])];
    const last = keys.pop()!;
    let target = root;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!Object.hasOwn(target, k) || target[k] == null) target[k] = /^\d+$/.test(keys[i + 1] ?? last) ? [] : {};
      target = target[k];
    }
    const prior = target[last];
    switch (delta.op) {
      case 'patch': {
        if (!Array.isArray(delta.value) || delta.value.length > 10000) throw new UpstreamError('Invalid ChatGPT patch.', 502);
        const nested = { value: prior };
        for (const d of delta.value) this.patch(nested, ['value'], { path: d.p ?? '', op: d.o, value: d.v }, depth + 1);
        target[last] = nested.value; break;
      }
      case 'add':
        if (Array.isArray(target)) target.splice(Number(last), 0, delta.value); else target[last] = delta.value;
        break;
      case 'replace': target[last] = delta.value; break;
      case 'remove': if (Array.isArray(target)) target.splice(Number(last), 1); else delete target[last]; break;
      case 'append':
        if (typeof prior === 'string' && typeof delta.value === 'string') target[last] += delta.value;
        else if (Array.isArray(prior)) prior.push(...(Array.isArray(delta.value) ? delta.value : [delta.value]));
        else if (prior && typeof prior === 'object' && delta.value && typeof delta.value === 'object') {
          for (const [k, v] of Object.entries(delta.value)) prior[safeKey(k)] = v;
        } else target[last] = delta.value;
        break;
      case 'truncate':
        if (!Number.isSafeInteger(delta.value) || delta.value < 0) throw new UpstreamError('Invalid ChatGPT truncation.', 502);
        if (typeof prior === 'string') target[last] = prior.slice(0, delta.value);
        else if (Array.isArray(prior)) prior.length = delta.value;
        break;
      default: throw new UpstreamError('Unsupported ChatGPT delta operation.', 502);
    }
  }
}

/** Decode actual frontend SSE, including cumulative snapshots and delta_encoding v1. */
export async function* parseChatGPTStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', encoded = false, completed = false;
  const decoder = new DeltaDecoder(), emitted = new Map<string, string>();
  const finish = (): ProviderEvent[] => {
    if (![...emitted.values()].some(Boolean)) throw new UpstreamError('ChatGPT returned no final text.', 502);
    completed = true; return [{ type: 'finish' }];
  };
  const frame = (text: string): ProviderEvent[] => {
    const lines = text.split('\n'), event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || completed) return [];
    if (data === '[DONE]') return finish();
    let value: any;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed ChatGPT SSE data.', 502); }
    if (event === 'delta_encoding') {
      if (value !== 'v1') throw new UpstreamError('Unsupported ChatGPT delta encoding.', 502);
      encoded = true; return [];
    }
    if (event === 'delta') {
      if (!encoded) throw new UpstreamError('ChatGPT delta before encoding declaration.', 502);
      value = decoder.apply(value);
    }
    if (value?.error || value?.type === 'error') throw chatGPTError(502, value.error?.code ?? value.code);
    if (value?.type === 'message_stream_complete') return finish();
    const message = value?.message;
    if (!message || message.author?.role !== 'assistant' || (message.recipient && message.recipient !== 'all') ||
        (message.channel && message.channel !== 'final') || message.metadata?.is_visually_hidden_from_conversation) return [];
    if (!Array.isArray(message.content?.parts)) return [];
    if (message.content.content_type !== 'text' && message.content.content_type !== 'multimodal_text') return [];
    const current = message.content.parts.filter((p: unknown) => typeof p === 'string').join('');
    const key = typeof message.id === 'string' ? message.id : 'assistant';
    const prior = emitted.get(key) ?? '';
    // OpenAI deltas cannot retract text already delivered to the caller.
    if (!current.startsWith(prior)) throw new UpstreamError('ChatGPT revised text already streamed.', 502);
    emitted.set(key, current);
    return current.length > prior.length ? [{ type: 'content', text: current.slice(prior.length) }] : [];
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('ChatGPT SSE frame too large.', 502);
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      yield* frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      if (completed) return;
    }
  }
  if (buffer.trim()) yield* frame(buffer);
  if (!completed) throw new UpstreamError('ChatGPT response ended before completion.', 502);
}
