import type { ProviderEvent } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** Composer modes found in the public frontend bundle (`composer-chat-mode-<mode>-button`).
 * `chat` is the internal default and is not offered in the mode menu; `analyst` and the
 * long-running task modes (research, computerUse...) are not text chat and are excluded. */
export const COPILOT_MODES = ['smart', 'reasoning', 'study', 'search'] as const;
export type CopilotMode = typeof COPILOT_MODES[number];
export const isCopilotMode = (value: string): value is CopilotMode => (COPILOT_MODES as readonly string[]).includes(value);

/** Carries the service's own availability instant, never an invented one. */
export class CopilotError extends UpstreamError {
  constructor(message: string, status: number, readonly until: string | null = null) { super(message, status); }
  get retryAfter(): string | null { return this.status === 429 ? copilotRetryAfter(this.until) : null; }
}

/** Service errors from the `/c/api/chat` WebSocket schema. Never inferred from a generic close. */
export function copilotError(code?: string | null, nextAvailableAt?: string | null): UpstreamError {
  const until = typeof nextAvailableAt === 'string' && Number.isFinite(Date.parse(nextAvailableAt)) ? nextAvailableAt : null;
  if (code === 'banned') return new CopilotError(`Copilot account is suspended${until ? ` until ${until}` : ''}.`, 403, until);
  if (code === 'sign-in-required' || code === 'not-signed-in') return new UpstreamError('Copilot login is required.', 401);
  if (code && /^(throttled|over-turn-limit|turn-limit-reached|too-many-messages|over-task-quota|over-lifetime-task-quota)$/.test(code))
    return new CopilotError('Copilot usage limit reached.', 429, until);
  if (code && /^(text-too-long|message-too-large|empty-message|empty-text|prompt-too-long)$/.test(code))
    return new UpstreamError(`Copilot rejected the message (${code}).`, 400);
  return new UpstreamError(`Copilot web request failed${code && /^[\w-]{1,80}$/.test(code) ? ` (${code})` : ''}.`, 502);
}

/** Retry-After in seconds derived from `errorDetail.nextAvailableAt`, when present. */
export function copilotRetryAfter(nextAvailableAt?: string | null): string | null {
  if (!nextAvailableAt) return null;
  const at = Date.parse(nextAvailableAt);
  return Number.isFinite(at) ? String(Math.max(1, Math.ceil((at - Date.now()) / 1000))) : null;
}

/**
 * Decode the frontend's WebSocket events (one JSON object per frame), already filtered
 * by the browser capture to the claimed conversation. Text arrives as `appendText`
 * deltas per part; `replaceText` may restate a part; `done` closes the AI message.
 */
export async function* parseCopilotEvents(frames: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  const messages = new Set<string>();
  const parts = new Map<string, string>();
  let lastPart: string | null = null, emitted = false;
  const emit = (key: string, current: string): ProviderEvent[] => {
    const prior = parts.get(key);
    if (prior !== undefined && !current.startsWith(prior)) throw new UpstreamError('Copilot revised text already streamed.', 502);
    let text = current.slice(prior?.length ?? 0);
    parts.set(key, current);
    if (!text) return [];
    // Separate text parts of the same answer as the frontend renders them: as blocks.
    if (prior === undefined && lastPart !== null && lastPart !== key && emitted) text = '\n\n' + text;
    lastPart = key; emitted = true;
    return [{ type: 'content', text }];
  };
  for await (const frame of frames) {
    signal?.throwIfAborted();
    if (frame.length > 4 * 1024 * 1024) throw new UpstreamError('Copilot frame too large.', 502);
    let event: any;
    try { event = JSON.parse(frame); } catch { throw new UpstreamError('Malformed Copilot WebSocket event.', 502); }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') throw new UpstreamError('Malformed Copilot WebSocket event.', 502);
    const id = typeof event.messageId === 'string' ? event.messageId : null;
    switch (event.event) {
      case 'startMessage':
        if (id) messages.add(id);
        break;
      case 'appendText':
        // Generative UI parts (with a parent) are not plain answer text.
        if (!id || !messages.has(id) || typeof event.text !== 'string' || event.parentPartId) break;
        yield* emit(`${id}:${event.partId ?? ''}`, (parts.get(`${id}:${event.partId ?? ''}`) ?? '') + event.text);
        break;
      case 'replaceText':
        if (!id || !messages.has(id) || typeof event.text !== 'string') break;
        yield* emit(`${id}:${event.partId ?? ''}`, event.text);
        break;
      case 'done':
        if (!id || !messages.has(id)) break;
        if (!emitted) throw new UpstreamError('Copilot returned no final text.', 502);
        yield { type: 'finish' };
        return;
      case 'error': throw copilotError(event.errorCode, event.errorDetail?.nextAvailableAt);
      case 'chatMessageError':
        if (id && !messages.has(id)) break;
        throw copilotError(event.errorCode, event.errorDetail?.nextAvailableAt);
      case 'turnLimitReached': throw copilotError('turn-limit-reached');
      case 'banned': throw copilotError('banned', event.expiresAt);
      default: break; // chainOfThought, citations, cards, titles, suggestions, telemetry...
    }
  }
  throw new UpstreamError('Copilot response ended before completion.', 502);
}
