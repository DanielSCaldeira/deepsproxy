import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/**
 * Perplexity web protocol, as observed in the public frontend bundles (2026-11-06):
 * POST /rest/sse/perplexity_ask with {params:{model_preference,...}, query_str};
 * SSE events `message`, `end_of_stream`, `info` and `ping`; each message carries
 * `blocks` keyed by `intended_usage`, where a `diff_block` patches one field of the
 * previous block with RFC 6902 operations. The answer is the `markdown_block` of
 * `ask_text` usages; sources come from `web_result_block.web_results`.
 */

/** Service errors only; a Cloudflare challenge is never treated as an expired login. */
export function perplexityError(status: number, code?: string, challenge = false): UpstreamError {
  if (challenge) return new UpstreamError('Perplexity anti-bot verification is pending; verify the browser.', 503);
  if (code && /^(ACCOUNT_(SUSPENDED|BANNED|DISABLED)|USER_BANNED)$/i.test(code)) return new UpstreamError('Perplexity account is suspended.', 403);
  if (status === 401) return new UpstreamError('Perplexity login is required.', 401);
  if (status === 429 || (code && /RATE_LIMIT|QUOTA|OUT_OF_CREDITS|LIMIT_REACHED/i.test(code)))
    return new UpstreamError('Perplexity usage limit reached.', 429);
  if (code && /^VIEWER_TIER_RESTRICTED$/i.test(code)) return new UpstreamError('Requested Perplexity model is not available for this account.', 400);
  return new UpstreamError(`Perplexity web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

export type PerplexityCatalogModel = ProviderModel & { label: string };

/** `/rest/models/config/v2`: selectable search models; reasoning variants are not advertised. */
export function perplexityModels(body: unknown): PerplexityCatalogModel[] {
  const entries = (body as any)?.search_config;
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  return entries.filter(m => typeof m?.label === 'string' && m.label.trim() && typeof m.non_reasoning_model === 'string' &&
    /^[\w.-]{1,80}$/.test(m.non_reasoning_model) && !/^comet_browser_agent/.test(m.non_reasoning_model))
    .map(m => ({ id: `perplexity/${m.non_reasoning_model}`, label: m.label.trim(),
      // The web configuration does not publish a context window.
      contextLength: 0 }))
    .filter(m => !seen.has(m.id) && !!seen.add(m.id));
}

const safeKey = (key: string) => {
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new UpstreamError('Unsafe Perplexity patch path.', 502);
  return key;
};
const clone = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** Minimal RFC 6902 subset used by the frontend's diff_block merge. */
export function applyPerplexityPatch(document: unknown, patches: unknown): unknown {
  if (!Array.isArray(patches) || patches.length > 10000) throw new UpstreamError('Invalid Perplexity patch.', 502);
  const root = { value: clone(document) ?? {} };
  const resolve = (path: unknown) => {
    if (typeof path !== 'string' || path.length > 4096 || (path && !path.startsWith('/'))) throw new UpstreamError('Invalid Perplexity patch path.', 502);
    const keys = ['value', ...(path ? path.slice(1).split('/').map(k => safeKey(k.replace(/~1/g, '/').replace(/~0/g, '~'))) : [])];
    if (keys.length > 34) throw new UpstreamError('Invalid Perplexity patch path.', 502);
    const last = keys.pop()!;
    let target: any = root;
    for (const key of keys) {
      if (target[key] === null || typeof target[key] !== 'object') throw new UpstreamError('Invalid Perplexity patch target.', 502);
      target = target[key];
    }
    return { target, last };
  };
  const read = (path: unknown) => { const { target, last } = resolve(path); return target[last]; };
  const write = (path: unknown, value: unknown, insert: boolean) => {
    const { target, last } = resolve(path);
    if (Array.isArray(target)) {
      const index = last === '-' ? target.length : Number(last);
      if (!Number.isSafeInteger(index) || index < 0 || index > target.length) throw new UpstreamError('Invalid Perplexity patch index.', 502);
      if (insert) target.splice(index, 0, value); else target[index] = value;
    } else target[last] = value;
  };
  const remove = (path: unknown) => {
    const { target, last } = resolve(path);
    if (Array.isArray(target)) target.splice(Number(last), 1); else delete target[last];
  };
  for (const patch of patches as any[]) {
    switch (patch?.op) {
      case 'add': write(patch.path, clone(patch.value), true); break;
      case 'replace': write(patch.path, clone(patch.value), false); break;
      case 'remove': remove(patch.path); break;
      case 'copy': write(patch.path, clone(read(patch.from)), true); break;
      case 'move': { const value = read(patch.from); remove(patch.from); write(patch.path, value, true); break; }
      case 'test': break;
      default: throw new UpstreamError('Unsupported Perplexity patch operation.', 502);
    }
  }
  return root.value;
}

type Block = Record<string, any> & { intended_usage: string };
export type PerplexitySource = { title: string; url: string };

/** Mirrors the frontend merge: diff blocks patch one field, other blocks replace by usage. */
function mergeBlocks(previous: Map<string, Block>, incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  if (incoming.length > 1000) throw new UpstreamError('Too many Perplexity blocks.', 502);
  for (const block of incoming) {
    if (!block || typeof block !== 'object' || typeof block.intended_usage !== 'string') continue;
    const usage = block.intended_usage;
    if (block.diff_block) {
      const field = block.diff_block.field;
      if (typeof field !== 'string') throw new UpstreamError('Invalid Perplexity diff block.', 502);
      safeKey(field);
      previous.set(usage, { intended_usage: usage, [field]: applyPerplexityPatch(previous.get(usage)?.[field], block.diff_block.patches ?? []) });
      continue;
    }
    const prior = previous.get(usage)?.markdown_block;
    const markdown = block.markdown_block;
    // A windowed chunk list continues the chunks already received.
    if (markdown && Number.isSafeInteger(markdown.chunk_starting_offset) && markdown.chunk_starting_offset > 0 &&
        Array.isArray(prior?.chunks) && Array.isArray(markdown.chunks)) {
      previous.set(usage, { ...block, markdown_block: { ...markdown, chunks: [...prior.chunks.slice(0, markdown.chunk_starting_offset), ...markdown.chunks], chunk_starting_offset: 0 } });
    } else previous.set(usage, block);
  }
}

const markdownText = (block: any): string => {
  const chunks = Array.isArray(block?.chunks) ? block.chunks.filter((c: unknown) => typeof c === 'string') : [];
  if (chunks.some((c: string) => c.trim())) return chunks.join('');
  return typeof block?.answer === 'string' ? block.answer : '';
};

export function perplexityAnswer(blocks: Map<string, Block>, usages?: unknown): string {
  const selected = Array.isArray(usages) && usages.length
    ? usages.filter((u): u is string => typeof u === 'string').map(u => blocks.get(u))
    : [...blocks.values()].filter(b => b.intended_usage === 'ask_text' || b.intended_usage.startsWith('ask_text_') || b.intended_usage === 'workflow_root');
  return selected.flatMap(b => {
    if (b?.markdown_block) return [markdownText(b.markdown_block)];
    if (!Array.isArray(b?.workflow_block?.steps)) return [];
    // Search queries, tool results and reasoning share the workflow block.
    // Only the items marked as the answer belong in the response.
    return b.workflow_block.steps.flatMap((step: any) => Array.isArray(step?.items) ? step.items : [])
      .filter((item: any) => item?.type === 'WORKFLOW_ITEM_TEXT' &&
        (item.variant === 'answer' || item.payload?.text_payload?.variant === 'answer'))
      .map((item: any) => markdownText({chunks:item.payload?.text_payload?.chunks,answer:item.payload?.text_payload?.text}));
  }).filter(text => text.length).join('\n\n');
}

export function perplexitySources(blocks: Map<string, Block>): PerplexitySource[] {
  const sources: PerplexitySource[] = [];
  for (const block of blocks.values()) {
    const results = block.web_result_block?.web_results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (typeof result?.url !== 'string' || !/^https?:\/\//i.test(result.url) || sources.some(s => s.url === result.url)) continue;
      const title = typeof result.name === 'string' && result.name.trim() ? result.name : typeof result.title === 'string' ? result.title : '';
      sources.push({ title: title.replace(/\s+/g, ' ').trim().slice(0, 200), url: result.url.slice(0, 2048) });
    }
  }
  return sources.slice(0, 20);
}

/**
 * Citation representation: inline markers such as [1] stay as written by the site;
 * a numbered "Fontes:" list is appended once at completion when the answer cites them. It is omitted when the
 * answer contains a tool call (IDE protocol) or PERPLEXITY_SOURCES=none.
 */
export function formatPerplexitySources(sources: PerplexitySource[], answer: string): string {
  if (!sources.length || !/\[\d+(?:[\s,–-]+\d+)*\]/.test(answer) || /<tool_call>/.test(answer) || process.env.PERPLEXITY_SOURCES === 'none') return '';
  return '\n\nFontes:\n' + sources.map((s, i) => `[${i + 1}] ${s.title ? `${s.title} - ` : ''}${s.url}`).join('\n');
}

/** Decode the frontend's SSE response into shared provider events. */
export async function* parsePerplexityStream(chunks: AsyncIterable<string>, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
  let buffer = '', emitted = '', diverged = false, completed = false, usages: unknown;
  const blocks = new Map<string, Block>();
  const update = (value: any): ProviderEvent[] => {
    if (!value || typeof value !== 'object') throw new UpstreamError('Invalid Perplexity message.', 502);
    if (value.status === 'FAILED' || value.error || value.error_code)
      throw perplexityError(502, value.error_code ?? value.error?.code ?? value.detail?.error_code);
    if (value.structured_answer_block_usages !== undefined) usages = value.structured_answer_block_usages;
    mergeBlocks(blocks, value.blocks);
    const current = perplexityAnswer(blocks, usages);
    const events: ProviderEvent[] = [];
    // OpenAI deltas cannot retract text already delivered; wait for a consistent snapshot.
    if (current.startsWith(emitted)) {
      diverged = false;
      if (current.length > emitted.length) { events.push({ type: 'content', text: current.slice(emitted.length) }); emitted = current; }
    } else diverged = true;
    if (value.final === true || value.final_sse_message === true || value.status === 'COMPLETED') events.push(...finish());
    return events;
  };
  const finish = (): ProviderEvent[] => {
    if (completed) return [];
    if (diverged) throw new UpstreamError('Perplexity revised text already streamed.', 502);
    if (!emitted.trim()) throw new UpstreamError('Perplexity returned no final text.', 502);
    completed = true;
    const sources = formatPerplexitySources(perplexitySources(blocks), emitted);
    return [...(sources ? [{ type: 'content' as const, text: sources }] : []), { type: 'finish' }];
  };
  const frame = (text: string): ProviderEvent[] => {
    const lines = text.split('\n');
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (completed || event === 'ping' || event === 'info') return [];
    if (event === 'end_of_stream') {
      if (data.trim()) {
        let value: any;
        try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Perplexity SSE data.', 502); }
        if (value && typeof value === 'object' && (value.blocks || value.status)) return [...update(value), ...finish()];
      }
      return finish();
    }
    if (event !== 'message' || !data) return [];
    let value: any;
    try { value = JSON.parse(data); } catch { throw new UpstreamError('Malformed Perplexity SSE data.', 502); }
    return update(value);
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) throw new UpstreamError('Perplexity SSE frame too large.', 502);
    buffer = buffer.replace(/\r\n?/g, '\n');
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      yield* frame(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      if (completed) return;
    }
  }
  if (buffer.trim()) yield* frame(buffer);
  if (!completed) throw new UpstreamError('Perplexity response ended before completion.', 502);
}
