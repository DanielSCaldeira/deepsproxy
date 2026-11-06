import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/**
 * Mistral Vibe (formerly Le Chat) web protocol helpers.
 *
 * Read from the site's public frontend bundles on 2026-11-06 (no account):
 * `fetch("/api/chat", { method: "POST" })` with `mode` (create/start/append/edit),
 * `model` and `messageInput: [{ type: "text", text }]`. The response body is
 * newline-delimited `<code>:<payload>` parts, optionally followed by
 * `__context__:<payload>`. Codes below 15 are JSON; 15 and above use superjson
 * (`{"json": ...}`). The UI ignores code 0 (text) and renders messages only from
 * `15` state updates whose message patches are RFC 6902 operations plus a string
 * `append`. Code 6 is an error and code 8 marks completion. The behavior with an
 * authenticated account was NOT observed; see docs/mistral-integration.md.
 */

/** Mode ids are the frontend i18n keys (`mode_dropdown.fast/think`); labels are the visible menu titles. */
export const MISTRAL_MODES = [
  // Menu items concatenate title and description ("FastGet answers fast").
  { id: 'mistral/fast', label: /^\s*(Fast|FAST|Rápido)(?![a-z])/ },
  { id: 'mistral/think', label: /^\s*(Think|Thinking|THINK|Pensar|Raciocínio)(?![a-z])/ },
] as const;

/** Only modes actually listed in the account's menu are advertised. */
export function mistralModels(labels: string[], current = ''): ProviderModel[] {
  const texts = [...labels, current].map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return MISTRAL_MODES.filter(mode => texts.some(text => mode.label.test(text)))
    .map(mode => ({ id: mode.id, contextLength: 0 }));
}

// Internal codes observed in the frontend error mapping (lowercased by the capture).
const LIMIT_CODES = /^(chat_request_rate_limited|chat_message_limit_reached|message_rate_limit_reached|rate_limited|rate_limit|rate_limit_exceeded|limit_exceeded|quota_exceeded|quota|at_capacity)$/;

/** Service errors only; a generic 403 (for example a Cloudflare challenge) is not a diagnosis. */
export function mistralError(status: number, code?: string): UpstreamError {
  if (code && /^(account_suspended|account_banned|user_banned|account_disabled)$/.test(code))
    return new UpstreamError('Mistral account is suspended.', 403);
  if (status === 401) return new UpstreamError('Mistral login is required.', 401);
  if (status === 429 || (code && LIMIT_CODES.test(code))) return new UpstreamError('Mistral usage limit reached.', 429);
  return new UpstreamError(`Mistral web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

const keysOf = (path: unknown): string[] => {
  if (typeof path !== 'string' || path.length > 4096) throw new UpstreamError('Invalid Mistral patch path.', 502);
  // "" and "/" address the whole message, as in the frontend.
  if (path === '' || path === '/') return [];
  if (!path.startsWith('/')) throw new UpstreamError('Invalid Mistral patch path.', 502);
  const keys = path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (keys.length > 32 || keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)))
    throw new UpstreamError('Unsafe Mistral patch path.', 502);
  return keys;
};
const read = (root: any, keys: string[]): any => keys.reduce((node, key) => node != null && typeof node === 'object' && Object.hasOwn(node, key) ? node[key] : undefined, root);

/** Frontend message patch semantics: RFC 6902 plus `append` on existing strings. */
function applyPatch(document: any, patch: any): any {
  if (!patch || typeof patch !== 'object' || typeof patch.op !== 'string') throw new UpstreamError('Invalid Mistral patch.', 502);
  let { op, value } = patch;
  const keys = keysOf(patch.path);
  if (op === 'test') return document;
  if (op === 'append') {
    const prior = read(document, keys);
    // The frontend drops appends whose target is not a string.
    if (typeof prior !== 'string' || typeof value !== 'string') return document;
    op = 'replace'; value = prior + value;
  }
  if (op === 'copy' || op === 'move') {
    const from = keysOf(patch.from);
    value = structuredClone(read(document, from));
    if (op === 'move') document = applyPatch(document, { op: 'remove', path: patch.from });
    op = 'add';
  }
  if (!['add', 'replace', 'remove'].includes(op)) throw new UpstreamError('Unsupported Mistral patch operation.', 502);
  if (!keys.length) return op === 'remove' ? {} : value;
  const last = keys.pop()!;
  let target = document ?? {};
  const root = target;
  for (const key of keys) {
    if (target[key] == null || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  if (Array.isArray(target)) {
    const index = last === '-' ? target.length : Number(last);
    if (!Number.isSafeInteger(index) || index < 0) throw new UpstreamError('Invalid Mistral patch index.', 502);
    if (op === 'add') target.splice(index, 0, value); else if (op === 'remove') target.splice(index, 1); else target[index] = value;
  } else if (op === 'remove') delete target[last]; else target[last] = value;
  return root;
}

/** Visible answer only: text chunks. Thinking, tool and reference chunks are not forwarded. */
function visibleText(message: any): string {
  if (!message || typeof message !== 'object') return '';
  if (Array.isArray(message.contentChunks)) return message.contentChunks
    .filter((chunk: any) => chunk && chunk.type === 'text' && typeof chunk.text === 'string')
    .map((chunk: any) => chunk.text).join('');
  return typeof message.content === 'string' ? message.content : '';
}

/** Decode the frontend generation stream (`/api/chat`) into provider events. */
export async function* parseMistralStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', completed = false;
  const messages = new Map<string, any>(), emitted = new Map<string, string>();
  const finish = (): ProviderEvent[] => {
    if (![...emitted.values()].some(Boolean)) throw new UpstreamError('Mistral returned no final text.', 502);
    completed = true; return [{ type: 'finish' }];
  };
  const update = (key: string): ProviderEvent[] => {
    const message = messages.get(key);
    // Prompts and other messages share the stream; only the assistant answer is forwarded.
    if (message?.role !== 'assistant') return [];
    const current = visibleText(message), prior = emitted.get(key) ?? '';
    // OpenAI deltas cannot retract text already delivered to the caller.
    if (!current.startsWith(prior)) throw new UpstreamError('Mistral revised text already streamed.', 502);
    emitted.set(key, current);
    return current.length > prior.length ? [{ type: 'content', text: current.slice(prior.length) }] : [];
  };
  const part = (line: string): ProviderEvent[] => {
    if (!line || completed) return [];
    const separator = line.indexOf(':');
    if (separator < 1) throw new UpstreamError('Malformed Mistral stream part.', 502);
    const code = line.slice(0, separator);
    if (!/^\d{1,3}$/.test(code)) throw new UpstreamError('Malformed Mistral stream part.', 502);
    const payload = line.slice(separator + 1).split('__context__:')[0];
    let value: any;
    try { value = payload ? JSON.parse(payload) : undefined; } catch { throw new UpstreamError('Malformed Mistral stream data.', 502); }
    if (Number(code) >= 15 && value && typeof value === 'object' && 'json' in value) value = value.json;
    if (code === '6') {
      const errorCode = typeof value?.code === 'string' ? value.code.toLowerCase() : typeof value?.internalCode === 'string' ? value.internalCode.toLowerCase() : undefined;
      throw mistralError(Number(value?.httpCode ?? value?.status) || 502, errorCode);
    }
    if (code === '8') return finish();
    if (code !== '15' || !value || typeof value !== 'object') return [];
    if (value.type === 'bootstrap' && Array.isArray(value.messages)) {
      for (const message of value.messages.slice(0, 1000))
        if (message && typeof message.id === 'string') messages.set(`${message.id}@${message.version ?? 0}`, message);
      return [];
    }
    if (value.type !== 'message' || typeof value.messageId !== 'string' || !Array.isArray(value.patches)) return [];
    if (value.patches.length > 10000) throw new UpstreamError('Invalid Mistral patch.', 502);
    const key = `${value.messageId}@${value.messageVersion ?? 0}`;
    let message = messages.get(key);
    for (const patch of value.patches) message = applyPatch(message, patch);
    messages.set(key, message);
    return update(key);
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Mistral stream part too large.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      yield* part(buffer.slice(0, boundary).replace(/\r$/, '')); buffer = buffer.slice(boundary + 1);
      if (completed) return;
    }
  }
  if (buffer.trim()) yield* part(buffer.trim());
  if (completed) return;
  // The frontend also treats the end of the body as the end of the stream.
  yield* finish();
}
