import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/**
 * claude.ai web protocol helpers. The event names and stop reasons were read from
 * the public frontend bundles on 2026-11-06 (see docs/claude-integration.md);
 * an authenticated response was not observed.
 */

/** Error classification uses only service JSON codes, never a generic 403/HTML challenge. */
export function claudeError(status: number, code?: string, type?: string): UpstreamError {
  const text = `${code ?? ''} ${type ?? ''}`;
  if (/account_(suspended|banned|disabled|deactivated)|\bbanned\b|suspended/.test(text))
    return new UpstreamError('Claude account is suspended.', 403);
  // Observed logged-out JSON: 403 permission_error with error_code account_session_invalid.
  // A bare permission_error (e.g. a plan restriction) is not treated as an expired login.
  if (status === 401 || /account_session_invalid|authentication_error/.test(text))
    return new UpstreamError('Claude login is required.', 401);
  if (status === 429 || /rate_limit|exceeded_limit|usage_limit/.test(text))
    return new UpstreamError('Claude usage limit reached.', 429);
  if (status === 529 || /overloaded/.test(text))
    return new UpstreamError('Claude is temporarily overloaded.', 503, true);
  return new UpstreamError(`Claude web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

/** Result of `GET /api/organizations`, evaluated inside Chromium; no identity crosses to Node. */
export type ClaudeAuthProbe = { status: number; json: boolean; organizations: number; code?: string; type?: string };
export function claudeAuthState(probe: ClaudeAuthProbe): 'authenticated' | 'login_required' | 'unavailable' {
  if (probe.status === 200 && probe.json) return probe.organizations > 0 ? 'authenticated' : 'login_required';
  // Observed logged-out answer: 403 JSON permission_error / account_session_invalid.
  if ((probe.status === 401 || probe.status === 403) && probe.json &&
      (probe.code === 'account_session_invalid' || probe.type === 'authentication_error'))
    return 'login_required';
  return 'unavailable';
}

const MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{1,80}$/;
/**
 * Collects `{model|model_id, name|display_name}` entries from authenticated JSON
 * (bootstrap/account). Not verified with a real account: an empty result only
 * leaves `claude/auto` advertised.
 */
export function claudeModels(body: unknown): Array<ProviderModel & { label: string }> {
  const found = new Map<string, ProviderModel & { label: string }>();
  let visited = 0;
  const walk = (value: any, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 8 || ++visited > 20000) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    const id = typeof value.model === 'string' ? value.model : typeof value.model_id === 'string' ? value.model_id : undefined;
    const label = [value.name, value.display_name, value.displayName].find(v => typeof v === 'string' && v.trim());
    if (id && MODEL_ID.test(id) && label && value.disabled !== true && !value.disabled_reason && value.is_available !== false &&
        !found.has(id)) found.set(id, { id: `claude/${id}`, label: label.trim(), contextLength: 0 });
    for (const key of Object.keys(value)) if (key !== '__proto__') walk(value[key], depth + 1);
  };
  walk(body, 0);
  return [...found.values()];
}

/**
 * Decode the claude.ai completion SSE: Messages-API style events
 * (message_start, content_block_*, message_delta, message_stop) plus the
 * site-specific message_limit and legacy `completion` frames. Only `text`
 * content blocks are returned; thinking, tool_use and citations are dropped.
 */
export async function* parseClaudeStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', completed = false, emitted = 0, limitExceeded = false, stopReason: string | null = null;
  const textBlocks = new Set<number>(), blockText = new Map<number, number>();
  const finish = (): ProviderEvent[] => {
    if (!emitted) {
      if (limitExceeded || stopReason === 'usage_limit') throw claudeError(429, 'usage_limit');
      throw new UpstreamError('Claude returned no final text.', 502);
    }
    completed = true; return [{ type: 'finish' }];
  };
  const text = (value: string, index: number): ProviderEvent[] => {
    if (!value) return [];
    emitted += value.length; blockText.set(index, (blockText.get(index) ?? 0) + value.length);
    return [{ type: 'content', text: value }];
  };
  const frame = (raw: string): ProviderEvent[] => {
    const lines = raw.split('\n'), event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || completed) return [];
    if (data === '[DONE]') return finish();
    let value: any;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Claude SSE data.', 502); }
    if (!value || typeof value !== 'object') throw new UpstreamError('Malformed Claude SSE data.', 502);
    const type = typeof value.type === 'string' ? value.type : event;
    switch (type) {
      case 'error': {
        const error = value.error ?? {};
        throw claudeError(502, error.details?.error_code ?? error.code, error.type);
      }
      case 'message_limit':
        if (value.message_limit?.type === 'exceeded_limit') limitExceeded = true;
        return [];
      case 'content_block_start': {
        const index = Number(value.index);
        if (Number.isSafeInteger(index) && value.content_block?.type === 'text') {
          textBlocks.add(index);
          return text(typeof value.content_block.text === 'string' ? value.content_block.text : '', index);
        }
        return [];
      }
      case 'content_block_delta': {
        const index = Number(value.index);
        if (!textBlocks.has(index) || value.delta?.type !== 'text_delta') return [];
        if (typeof value.delta.text !== 'string') throw new UpstreamError('Malformed Claude text delta.', 502);
        return text(value.delta.text, index);
      }
      case 'content_block_retract': {
        // OpenAI deltas cannot retract text already delivered to the caller.
        if ((blockText.get(Number(value.index)) ?? 0) > 0) throw new UpstreamError('Claude retracted text already streamed.', 502);
        return [];
      }
      case 'message_delta': {
        if (typeof value.delta?.stop_reason === 'string')
          stopReason = value.delta.stop_reason === 'stop_sequence' && value.delta.stop_sequence === 'usage_limit' ? 'usage_limit' : value.delta.stop_reason;
        const tokens = value.usage?.output_tokens;
        return Number.isSafeInteger(tokens) && tokens > 0 ? [{ type: 'usage', completionTokens: tokens }] : [];
      }
      case 'message_stop': return finish();
      case 'completion': {
        // Legacy frame: incremental `completion` text with an inline stop_reason.
        const events = typeof value.completion === 'string' ? text(value.completion, -1) : [];
        if (typeof value.stop_reason === 'string') {
          stopReason = value.stop_reason === 'stop_sequence' && value.stop === 'usage_limit' ? 'usage_limit' : value.stop_reason;
          return [...events, ...finish()];
        }
        return events;
      }
      default: return [];
    }
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Claude SSE frame too large.', 502);
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      yield* frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      if (completed) return;
    }
  }
  if (buffer.trim()) yield* frame(buffer);
  if (completed) return;
  if (limitExceeded || stopReason === 'usage_limit') throw claudeError(429, 'usage_limit');
  throw new UpstreamError('Claude response ended before completion.', 502);
}
