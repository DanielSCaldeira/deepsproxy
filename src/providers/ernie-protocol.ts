import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** `#chat-textarea` declares maxlength="20000" (observed 2026-11-06). */
export const ERNIE_INPUT_LIMIT = 20_000;
/** Model value used by the website's "自动" (automatic) option. */
export const ERNIE_DEFAULT_MODEL = 'smartMode';

export function ernieError(status: number, code?: string): UpstreamError {
  if (status === 401 || code === 'login_required') return new UpstreamError('Ernie login is required.', 401);
  if (status === 429 || code === 'rate_limit') return new UpstreamError('Ernie usage limit reached.', 429);
  if (code === 'security_verification')
    return new UpstreamError('Ernie requires a human security verification (百度安全验证); open the login screen in the panel.', 503);
  if (code === 'risk_hint') return new UpstreamError('Ernie rejected the request (service or risk-control notice).', 502);
  return new UpstreamError(`Ernie web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

/** Selectable models come from the composer menu: `[role=menuitemradio][data-model-name]`. */
export function ernieModels(items: Array<{ name?: string | null; label?: string | null }>): Array<ProviderModel & { label: string }> {
  const seen = new Set<string>();
  return items.filter(item => typeof item.name === 'string' && /^[\w.-]{1,64}$/.test(item.name) && !seen.has(item.name) && !!seen.add(item.name))
    // The website publishes no context window for its chat models.
    .map(item => ({ id: `ernie/${item.name}`, label: (item.label || item.name!).trim(), contextLength: 0 }));
}

/** Reads only the login flag from the server-rendered `aiTabFrameBaseData` script. */
export function ernieLoginFromHtml(html: string): boolean | null {
  const match = /<script[^>]*name=["']aiTabFrameBaseData["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const flag = JSON.parse(match[1])?.userInfo?.isUserLogin;
    return flag === undefined || flag === null ? null : flag === true || Number(flag) === 1;
  } catch { return null; }
}

const TEXT_COMPONENTS = new Set(['markdown-yiyan', 'ai-markdown', 'markdown']);

/**
 * Decodes the website's `/aichat/api/conversation` SSE (event: basedata/ping/message).
 * Answer packets carry text deltas in `generator.data.value`; the frontend appends
 * each packet. Completion is `metaData.state === "generate-complete"` with `endTurn`.
 */
export async function* parseErnieStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', completed = false, text = false, reasoning = '';
  const frame = (raw: string): ProviderEvent[] => {
    const lines = raw.split('\n');
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || completed || event === 'ping') return [];
    let value: any;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Ernie SSE data.', 502); }
    // Visitor answers are valid: the chat does not require a Baidu login.
    if (event === 'basedata') return [];
    // The frontend restarts from a checkpoint or a background task; not supported by the proxy.
    if (event === 'reconnect' || event === 'task') throw new UpstreamError(`Ernie switched to an unsupported ${event} flow.`, 502);
    if (event !== 'message') return [];
    if (value?.status !== 0) {
      if (value?.status === 1004) throw new UpstreamError('Ernie deleted the conversation topic.', 502);
      throw ernieError(502, 'risk_hint');
    }
    const message = value?.data?.message;
    const meta = message?.metaData ?? {};
    const generator = message?.content?.generator;
    const events: ProviderEvent[] = [];
    const component = generator?.component;
    if (TEXT_COMPONENTS.has(component) && generator?.isSafe !== 0) {
      const delta = generator?.data?.value ?? generator?.data?.content;
      if (typeof delta === 'string' && delta) { text = true; events.push({ type: 'content', text: delta }); }
    } else if (component === 'thinkingSteps' && Array.isArray(generator?.data?.reasoningContentArr) && generator.data.noReasoning !== true) {
      // Reasoning visible on the website arrives as an array snapshot; never retract emitted text.
      const current = generator.data.reasoningContentArr.filter((p: unknown) => typeof p === 'string').join('\n');
      if (current.startsWith(reasoning) && current.length > reasoning.length) {
        events.push({ type: 'reasoning', text: current.slice(reasoning.length) }); reasoning = current;
      }
    }
    if (meta.state === 'generate-complete' && meta.endTurn === true) {
      if (!text) throw new UpstreamError('Ernie returned no final text.', 502);
      completed = true; events.push({ type: 'finish' });
    }
    return events;
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Ernie SSE frame too large.', 502);
    // Keep a trailing CR until the next chunk arrives.
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      yield* frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      if (completed) return;
    }
  }
  signal?.throwIfAborted();
  if (buffer.trim()) yield* frame(buffer);
  if (!completed) throw new UpstreamError('Ernie response ended before completion.', 502);
}
