import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/**
 * Grok web errors. The REST API uses gRPC-style bodies ({ code, message }):
 * 16 UNAUTHENTICATED, 8 RESOURCE_EXHAUSTED and 7 PERMISSION_DENIED were seen in
 * the public bundles/anonymous probes. A generic 403 is never treated as a suspension.
 */
export function grokError(status: number, code?: string | number): UpstreamError {
  const text = code === undefined ? '' : String(code);
  if (/^(blocked|user_deleted|account_suspended|suspended|banned)$/i.test(text))
    return new UpstreamError('Grok account is suspended.', 403);
  if (status === 401 || text === '16' || /^unauthenticated$/i.test(text)) return new UpstreamError('Grok login is required.', 401);
  if (status === 429 || text === '8' || /rate_?limit|resource_exhausted|quota|too_many/i.test(text))
    return new UpstreamError('Grok usage limit reached.', 429);
  return new UpstreamError(`Grok web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

export type GrokMode = ProviderModel & { label: string };

/** Modes from POST /rest/modes ({ modes: [{ id, title, availability }], defaultModeId }). */
export function grokModes(body: unknown): GrokMode[] {
  const modes = (body as any)?.modes;
  if (!Array.isArray(modes)) return [];
  const seen = new Set<string>();
  return modes.filter(m => typeof m?.id === 'string' && /^[\w.-]{1,64}$/.test(m.id) && typeof m.title === 'string' && m.title.trim() &&
    // Availability details vary per plan; an explicit unavailable marker without an available one is locked.
    !(m.availability && !m.availability.available && m.availability.unavailable)).filter(m => {
    const id = m.id.toLowerCase();
    if (seen.has(id)) return false; seen.add(id); return true;
  }).map(m => ({ id: `grok/${m.id.toLowerCase()}`, label: m.title.trim(),
    // The website does not publish a verified context window.
    contextLength: 0 }));
}

const ASSISTANT = /^(assistant|model|grok)$/i;

/**
 * Decode the website's newline-delimited JSON stream from
 * POST /rest/app-chat/conversations/new. Each line is
 * { result: { conversation?, title?, response?: { token, isThinking, messageTag,
 * isSoftStop, modelResponse, finalMetadata, throttle, keepAlive, error } }, error? }.
 */
export async function* parseGrokStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', emitted = '', completed = false;
  const finish = (): ProviderEvent[] => {
    if (!emitted) throw new UpstreamError('Grok returned no final text.', 502);
    completed = true; return [{ type: 'finish' }];
  };
  const line = (text: string): ProviderEvent[] => {
    const data = text.trim();
    if (!data || completed) return [];
    let value: any;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Grok stream data.', 502); }
    if (!value || typeof value !== 'object') throw new UpstreamError('Malformed Grok stream data.', 502);
    if (value.error) throw grokError(502, value.error.code ?? value.error.status);
    const response = value.result?.response;
    if (!response || typeof response !== 'object') return [];
    if (response.error) throw grokError(502, response.error.code ?? response.error.status);
    if (response.keepAlive !== undefined || response.throttle || response.userResponse) return [];
    // Side-by-side comparisons stream a second answer; only the primary one is used.
    if (response.sideBySideIndex !== undefined && response.sideBySideIndex !== 0) return [];
    const events: ProviderEvent[] = [];
    // Thinking traces, tool cards, search headers and other tagged steps are not the answer.
    if (typeof response.token === 'string' && response.token && response.isThinking !== true &&
        (response.messageTag === undefined || response.messageTag === 'final') && !response.toolUsageCard && !response.toolUsageCardId) {
      emitted += response.token; events.push({ type: 'content', text: response.token });
    }
    const model = response.modelResponse;
    if (model && typeof model === 'object' && typeof model.message === 'string' && model.partial !== true &&
        (model.sender === undefined || ASSISTANT.test(String(model.sender)))) {
      if (model.error) throw grokError(502, model.error.code ?? model.error.status);
      const final = model.message;
      if (final) {
        // OpenAI deltas cannot retract text already delivered. The final snapshot only
        // completes a streamed prefix; a differently rendered snapshot does not replace it.
        if (final.startsWith(emitted) && final.length > emitted.length) {
          events.push({ type: 'content', text: final.slice(emitted.length) }); emitted = final;
        }
        return [...events, ...finish()];
      }
    }
    if (response.isSoftStop === true && emitted) return [...events, ...finish()];
    return events;
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Grok stream line too large.', 502);
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      yield* line(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1);
      if (completed) return;
    }
  }
  signal?.throwIfAborted();
  if (buffer.trim()) yield* line(buffer);
  if (completed) return;
  // The server closes the HTTP stream after the answer. A clean end with text is a completion;
  // a transport failure is reported by the capture as stream_failed, never reaching here.
  yield* finish();
}
