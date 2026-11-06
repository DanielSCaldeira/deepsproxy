import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/**
 * Kimi web (www.kimi.ai) uses Connect RPC with the JSON codec. Server-streaming
 * methods such as `kimi.gateway.chat.v1.ChatService/Chat` answer with
 * `application/connect+json` envelopes: 1 flag byte, 4-byte big-endian length
 * and a JSON payload. Flag 0x02 marks the end-of-stream frame (error/metadata).
 * Source: public frontend bundles inspected on 2026-11-06 (see docs/kimi-integration.md).
 */
export const KIMI_CHAT_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat';
export const KIMI_USER_PATH = '/apiv2/kimi.gateway.account.v1.UserService/GetCurrentUser';
export const KIMI_MODELS_PATH = '/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels';

const LOGIN = /^REASON_(INVALID_AUTH_TOKEN|ANONYMOUS_REQUIRE_LOGIN|ANONYMOUS_USAGE_EXCEEDED|ACCOUNT_DEVICE_LOGGED_OUT)$/;
const SUSPENDED = /^REASON_ACCOUNT_(BANNED|SUSPENDED|DISABLED|ACCESS_DENIED)$/;
const LIMIT = /^REASON_(\w*USAGE_EXCEEDED|\w*RATE_EXCEEDED|RATE_LIMIT_EXCEEDED|QUOTA_EXCEEDED\w*|CHAT_CONCURRENCY_EXCEEDED|SERVER_OVERLOADED_FOR_FREE_USER|RESEARCH_TASK_CONCURRENT_LIMIT)$/;

/** Map Connect codes and documented Kimi reasons; a generic 403 is never a suspension. */
export function kimiError(status: number, code?: string, reason?: string): UpstreamError {
  if (reason && SUSPENDED.test(reason)) return new UpstreamError('Kimi account is suspended.', 403);
  if (reason && LOGIN.test(reason)) return new UpstreamError('Kimi login is required.', 401);
  if (reason && LIMIT.test(reason)) return new UpstreamError('Kimi usage limit reached.', 429);
  if (status === 401 || code === 'unauthenticated') return new UpstreamError('Kimi login is required.', 401);
  if (status === 429 || code === 'resource_exhausted') return new UpstreamError('Kimi usage limit reached.', 429);
  return new UpstreamError(`Kimi web request failed (${code && /^[a-z_]{1,40}$/.test(code) ? code : `HTTP ${status || 502}`}).`,
    status >= 400 ? status : 502);
}

/** Extract only the enumerated reason from a Connect error body; messages are not propagated. */
export function kimiErrorReason(body: any): string | undefined {
  for (const detail of Array.isArray(body?.details) ? body.details : []) {
    const reason = detail?.debug?.reason;
    if (typeof reason === 'string' && /^REASON_[A-Z0-9_]{1,80}$/.test(reason)) return reason;
  }
  const reason = body?.reason;
  return typeof reason === 'string' && /^REASON_[A-Z0-9_]{1,80}$/.test(reason) ? reason : undefined;
}

export type KimiCatalogModel = ProviderModel & { label: string; aliases: string[] };

/**
 * GetAvailableModels lists chat and agent ("OK Computer") entries. Only the
 * plain chat scenario is advertised: agent entries run Kimi-side tools and
 * sandboxes, which conflicts with tools executed by the IDE client.
 */
export function kimiModels(body: unknown): KimiCatalogModel[] {
  const source = body as any;
  const entries = [...(Array.isArray(source?.availableModels) ? source.availableModels : []),
    ...(Array.isArray(source?.moreModels) ? source.moreModels : [])];
  const models = new Map<string, KimiCatalogModel>();
  for (const entry of entries) {
    const id = typeof entry?.id === 'string' && entry.id ? entry.id : entry?.key;
    if (typeof id !== 'string' || !/^[\w.-]{1,80}$/.test(id) || models.has(`kimi/${id}`)) continue;
    if (typeof entry.displayName !== 'string' || !entry.displayName.trim()) continue;
    if (entry.scenario !== 'SCENARIO_CHAT' || entry.kimiPlusId || entry.legacy === true) continue;
    const aliases = [id, entry.key, entry.modelId].filter((v): v is string => typeof v === 'string' && !!v);
    // The web catalog does not publish a verified context window.
    models.set(`kimi/${id}`, { id: `kimi/${id}`, label: entry.displayName.trim(), aliases: [...new Set(aliases)], contextLength: 0 });
  }
  return [...models.values()];
}

/** Test/fixture helper: encode one Connect envelope. */
export function connectFrame(value: unknown, flags = 0): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags; new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

/** Decode Connect envelopes from arbitrary byte chunk boundaries. */
export async function* decodeConnectFrames(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal):
  AsyncGenerator<{ end: boolean; value: any }> {
  let buffer = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer); next.set(chunk, buffer.length); buffer = next;
    while (buffer.length >= 5) {
      const flags = buffer[0];
      const length = new DataView(buffer.buffer, buffer.byteOffset + 1, 4).getUint32(0, false);
      if (length > 4 * 1024 * 1024) throw new UpstreamError('Kimi stream frame too large.', 502);
      if (flags & 0x01) throw new UpstreamError('Compressed Kimi stream frames are not supported.', 502);
      if (buffer.length < 5 + length) break;
      let value: any;
      try { value = JSON.parse(decoder.decode(buffer.subarray(5, 5 + length))); }
      catch { throw new UpstreamError('Malformed Kimi stream frame.', 502); }
      buffer = buffer.slice(5 + length);
      yield { end: (flags & 0x02) !== 0, value };
    }
  }
  if (buffer.length) throw new UpstreamError('Kimi stream ended inside a frame.', 502);
}

function maskPaths(mask: unknown): string[] {
  if (typeof mask === 'string') return mask.split(',').map(p => p.trim()).filter(Boolean);
  const paths = (mask as any)?.paths;
  return Array.isArray(paths) ? paths.filter((p: unknown) => typeof p === 'string') : [];
}
const isAssistant = (role: unknown) => role === 'assistant' || role === 'ROLE_ASSISTANT' || role === 3;
const isUser = (role: unknown) => role === 'user' || role === 'ROLE_USER' || role === 2;
const isSet = (op: unknown) => op === 'set' || op === 1;

/**
 * ChatResponse events: `message`, `block`, `done`, `heartbeat`, ... Text blocks
 * follow the frontend's merge rule: first event for a block id creates it; a
 * later `set` with mask `block` replaces it; anything else appends.
 */
export async function* parseKimiStream(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal,
  options: { thinking?: boolean } = {}): AsyncGenerator<ProviderEvent> {
  const users = new Set<string>(), assistants = new Set<string>();
  const text = new Map<string, string>(), thoughts = new Map<string, string>();
  let completed = false;
  const finish = (): ProviderEvent[] => {
    if (![...text.values()].some(Boolean)) throw new UpstreamError('Kimi returned no final text.', 502);
    completed = true; return [{ type: 'finish' }];
  };
  const update = (store: Map<string, string>, id: string, value: string, replace: boolean, strict = true): string => {
    const prior = store.get(id);
    if (prior === undefined || !replace) { store.set(id, (prior ?? '') + value); return value; }
    store.set(id, value);
    if (value.startsWith(prior)) return value.slice(prior.length);
    // OpenAI deltas cannot retract text already delivered to the caller.
    if (strict) throw new UpstreamError('Kimi revised text already streamed.', 502);
    return '';
  };
  for await (const frame of decodeConnectFrames(chunks, signal)) {
    if (completed) continue;
    const event = frame.value;
    if (frame.end) {
      if (event?.error) throw kimiError(502, event.error.code, kimiErrorReason(event.error));
      yield* finish(); continue;
    }
    if (event?.error) throw kimiError(502, event.error.code, kimiErrorReason(event.error));
    if (event?.message) {
      const message = event.message;
      if (typeof message.id === 'string' && message.id) (isUser(message.role) ? users : isAssistant(message.role) ? assistants : users).add(message.id);
      if (isAssistant(message.role) && message.error?.reason) throw kimiError(502, undefined, message.error.reason);
      if (isAssistant(message.role) && message.status === 'MESSAGE_STATUS_ERROR') throw kimiError(502);
      continue;
    }
    if (event?.done !== undefined) { yield* finish(); continue; }
    const block = event?.block;
    if (!block) continue;
    if (typeof block.messageId === 'string' && users.has(block.messageId)) continue;
    if (block.error?.reason) throw kimiError(502, undefined, block.error.reason);
    if (block.exception) throw kimiError(502, undefined, block.exception.error?.reason);
    const id = typeof block.id === 'string' && block.id ? block.id : 'text';
    const replace = isSet(event.op) && maskPaths(event.mask)[0] === 'block';
    if (block.text && typeof block.text.content === 'string') {
      const delta = update(text, id, block.text.content, replace);
      if (delta) yield { type: 'content', text: delta };
    } else if (block.think && typeof block.think.content === 'string') {
      const delta = update(thoughts, id, block.think.content, isSet(event.op) && block.think.content.length > 0, false);
      // Kimi shows this reasoning in its UI; forward it only when explicitly requested.
      if (delta && options.thinking) yield { type: 'reasoning', text: delta };
    }
  }
  if (!completed) throw new UpstreamError('Kimi response ended before completion.', 502);
}
