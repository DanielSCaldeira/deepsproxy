import { createHash } from 'node:crypto';
import { Message } from './types.ts';
import { createLogger } from './logger.ts';
import { isTerminalGenerationError } from '../services/generation-guard.ts';

const log = createLogger('context-summary');
const DEFAULT_TRIGGER_RATIO = 0.72;
const RECENT_CONTEXT_RATIO = 0.35;
const SUMMARY_BUDGET_RATIO = 0.12;
const MAX_SUMMARY_INPUT_RATIO = 0.55;
const MIN_SUMMARY_INPUT_CHARS = 4_000;
const MIN_SUMMARY_BUDGET_CHARS = 1_000;
const MAX_SUMMARY_BUDGET_CHARS = 6_000;
const CACHE_TTL_MS = 30 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 128;

interface SummaryCacheEntry {
  summary: string;
  messageCount: number;
  expiresAt: number;
}

export interface ContextSummaryOptions {
  model: string;
  targetLimit: number;
  measure: (messages: Message[]) => number;
  serialize: (messages: Message[]) => { prompt: string; systemPrompt: string };
  summarize: (previousSummary: string, sourceText: string, maxSummaryChars: number) => Promise<string>;
  triggerRatio?: number;
}

const summaryCache = new Map<string, SummaryCacheEntry>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function getTriggerRatio(configured?: number): number {
  const fromEnv = Number(process.env.DEEPSPROXY_SUMMARY_TRIGGER_RATIO);
  const ratio = configured ?? (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 1 ? fromEnv : DEFAULT_TRIGGER_RATIO);
  return Math.max(0.5, Math.min(0.9, ratio));
}

function summaryBudget(targetLimit: number): number {
  return Math.max(
    MIN_SUMMARY_BUDGET_CHARS,
    Math.min(MAX_SUMMARY_BUDGET_CHARS, Math.floor(targetLimit * SUMMARY_BUDGET_RATIO))
  );
}

function cacheKeys(model: string, systems: Message[], history: Message[], budget: number): string[] {
  const base = sha256(`${process.env.PROVIDER || 'deepseek'}\0${process.env.PROVIDER_PROFILE_DIR || process.env.QWEN_PROFILE_DIR || process.env.DEEPSEEK_PROFILE_DIR || ''}\0${model}\0${budget}\0${JSON.stringify(systems)}`);
  let current = base;
  const keys: string[] = [];
  for (const message of history) {
    current = sha256(`${current}\0${JSON.stringify(message)}`);
    keys.push(current);
  }
  return keys;
}

function getCachedPrefix(keys: string[]): { key: string; entry: SummaryCacheEntry } | undefined {
  const now = Date.now();
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index];
    const entry = summaryCache.get(key);
    if (!entry) continue;
    if (entry.expiresAt <= now) {
      summaryCache.delete(key);
      continue;
    }
    summaryCache.delete(key);
    summaryCache.set(key, entry);
    return { key, entry };
  }
  return undefined;
}

function saveSummary(key: string, entry: SummaryCacheEntry): void {
  summaryCache.delete(key);
  summaryCache.set(key, entry);
  const now = Date.now();
  for (const [cachedKey, cachedEntry] of summaryCache) {
    if (cachedEntry.expiresAt <= now) summaryCache.delete(cachedKey);
  }
  while (summaryCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = summaryCache.keys().next().value;
    if (oldestKey === undefined) break;
    summaryCache.delete(oldestKey);
  }
}

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function findRecentStart(
  systems: Message[],
  history: Message[],
  targetLimit: number,
  measure: (messages: Message[]) => number
): number | null {
  const userStarts: number[] = [];
  for (let index = 0; index < history.length; index++) {
    if (history[index].role === 'user') userStarts.push(index);
  }
  if (userStarts.length < 2) return null;

  let keepStart = userStarts[userStarts.length - 1];
  const recentBudget = Math.floor(targetLimit * RECENT_CONTEXT_RATIO);
  for (let index = userStarts.length - 2; index >= 0; index--) {
    const candidate = userStarts[index];
    if (measure([...systems, ...history.slice(candidate)]) <= recentBudget) {
      keepStart = candidate;
    } else {
      break;
    }
  }
  return keepStart;
}

export async function summarizeOlderContext(
  messages: Message[],
  options: ContextSummaryOptions
): Promise<Message[]> {
  const { model, targetLimit, measure, serialize, summarize } = options;
  if (!messages.length || measure(messages) <= targetLimit * getTriggerRatio(options.triggerRatio)) {
    return messages;
  }

  const systems = messages.filter((message) => message.role === 'system');
  const history = messages.filter((message) => message.role !== 'system');
  const keepStart = findRecentStart(systems, history, targetLimit, measure);
  if (keepStart === null || keepStart <= 0) {
    log.debug('Context is large but has no complete older turn to summarize', { model });
    return messages;
  }

  const olderMessages = history.slice(0, keepStart);
  const recentMessages = history.slice(keepStart);
  const budget = summaryBudget(targetLimit);
  const keys = cacheKeys(model, systems, olderMessages, budget);
  const cached = getCachedPrefix(keys);
  let rollingSummary = cached?.entry.summary || '';
  const alreadySummarized = cached?.entry.messageCount || 0;
  const deltaMessages = olderMessages.slice(alreadySummarized);
  const deltaText = serialize(deltaMessages).prompt;
  const maxInputChars = Math.max(MIN_SUMMARY_INPUT_CHARS, Math.floor(targetLimit * MAX_SUMMARY_INPUT_RATIO));
  const chunks = splitText(deltaText, maxInputChars);

  try {
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      rollingSummary = (await summarize(rollingSummary, chunk, budget)).trim();
      if (!rollingSummary) throw new Error('Summary model returned empty content');
    }
  } catch (error: any) {
    if (isTerminalGenerationError(error)) throw error;
    log.warn('Automatic context summary failed; using regular compression', {
      model,
      error: error?.message || String(error),
    });
    return messages;
  }

  if (!rollingSummary) return messages;

  const finalKey = keys[keys.length - 1];
  if (finalKey) {
    saveSummary(finalKey, {
      summary: rollingSummary,
      messageCount: olderMessages.length,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  const summarized: Message[] = [
    ...systems,
    {
      role: 'context_summary',
      content: rollingSummary,
    },
    ...recentMessages,
  ];

  log.info('Summarized older conversation context', {
    model,
    summarizedMessages: olderMessages.length,
    retainedMessages: recentMessages.length,
    summaryChars: rollingSummary.length,
    cacheHit: !!cached,
  });
  return summarized;
}
