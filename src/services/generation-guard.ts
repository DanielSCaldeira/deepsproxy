import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { getProfileDirectory } from './session-store.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('generation');
const signals = new AsyncLocalStorage<AbortSignal>();
export const generationSignal = () => signals.getStore();
export const withGenerationSignal = <T>(signal: AbortSignal, fn: () => T): T => signals.run(signal, fn);

export type AccountBlock = { state: 'suspended' | 'login_required'; authenticated?: boolean; suspendedUntil?: string | null; originalMessage?: string | null };
interface SavedGuard { nextAllowedAt: number; block: AccountBlock | null; rateLimitUntil?: number }

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number, readonly retryable = false, readonly originalMessage: string | null = null) { super(message); }
}

export function getRequestDelayRange(env: NodeJS.ProcessEnv = process.env) {
  const minMs = Number(env.DEEPSPROXY_REQUEST_DELAY_MIN_MS ?? 15_000);
  const maxMs = Number(env.DEEPSPROXY_REQUEST_DELAY_MAX_MS ?? 30_000);
  return Number.isSafeInteger(minMs) && Number.isSafeInteger(maxMs) && minMs >= 0 && maxMs >= minMs && maxMs <= 3_600_000
    ? { minMs, maxMs } : { minMs: 15_000, maxMs: 30_000 };
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = value.trim() !== '' && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** One lease covers browser capture, dispatch and the complete response body. */
export class GenerationGuard {
  private saved: SavedGuard = { nextAllowedAt: 0, block: null };
  private active = false;
  private waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private file?: string, private now = Date.now, private random = Math.random,
    private wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => sleep(ms, undefined, { signal })) {
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedGuard;
      if (!Number.isFinite(data.nextAllowedAt) || data.nextAllowedAt < 0 ||
          (data.rateLimitUntil !== undefined && (!Number.isFinite(data.rateLimitUntil) || data.rateLimitUntil < 0)) ||
          (data.block !== null && !['suspended', 'login_required'].includes(data.block?.state))) {
        throw new Error('Invalid generation guard state; verify the profile before restarting.');
      }
      this.saved = data;
    }
  }
  private persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  status() {
    return { block: this.saved.block, nextAllowedAt: this.saved.nextAllowedAt ? new Date(this.saved.nextAllowedAt).toISOString() : null,
      ...(this.saved.rateLimitUntil && this.saved.rateLimitUntil > this.now() ? { rateLimitUntil: new Date(this.saved.rateLimitUntil).toISOString() } : {}),
      busy: this.active, queued: this.waiters.length };
  }
  assertAllowed() {
    if (this.saved.block) throw new UpstreamError(this.saved.block.state === 'suspended'
      ? `${process.env.PROVIDER === 'claude' ? 'Claude' : process.env.PROVIDER === 'perplexity' ? 'Perplexity' : process.env.PROVIDER === 'chatgpt' ? 'ChatGPT' : process.env.PROVIDER === 'qwen' ? 'Qwen' : 'DeepSeek'} account is suspended; interactive login validation is required.`
      : `${process.env.PROVIDER === 'claude' ? 'Claude' : process.env.PROVIDER === 'perplexity' ? 'Perplexity' : process.env.PROVIDER === 'chatgpt' ? 'ChatGPT' : process.env.PROVIDER === 'qwen' ? 'Qwen' : 'DeepSeek'} login is required; interactive login validation is required.`, this.saved.block.state === 'suspended' ? 403 : 401,
      false, this.saved.block.originalMessage ?? null);
  }
  block(block: AccountBlock) {
    // A later login redirect must not erase the stronger suspension diagnosis.
    if (this.saved.block?.state !== 'suspended' || block.state === 'suspended') {
      this.saved.block = { ...block, originalMessage: block.originalMessage ?? (this.saved.block?.state === block.state ? this.saved.block.originalMessage : null) };
    }
    this.persist();
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      try { this.assertAllowed(); } catch (error) { waiter.reject(error); }
    }
  }
  confirmInteractiveLogin() { this.saved.block = null; this.persist(); }
  defer(ms: number, reason?: 'rate_limit') {
    this.saved.nextAllowedAt = Math.max(this.saved.nextAllowedAt, this.now() + ms);
    if (reason === 'rate_limit') this.saved.rateLimitUntil = Math.max(this.saved.rateLimitUntil ?? 0, this.now() + ms);
    this.persist();
  }
  private unlock() {
    const next = this.waiters.shift();
    if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active = false;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    this.assertAllowed();
    if (this.active) await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(signal?.reason);
      } };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
    else this.active = true;
    try {
      this.assertAllowed();
      while (this.saved.nextAllowedAt > this.now()) {
        const delayMs = this.saved.nextAllowedAt - this.now();
        log.info('Waiting before next generation', { delayMs, reason: 'request_cooldown' });
        await this.wait(Math.min(delayMs, 60_000), signal);
        this.assertAllowed();
      }
      signal?.throwIfAborted();
    } catch (error) { this.unlock(); throw error; }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const range = getRequestDelayRange();
      const delayMs = range.minMs + Math.floor(this.random() * (range.maxMs - range.minMs + 1));
      try { this.defer(delayMs); } finally { this.unlock(); }
    };
  }
}

const guards = new Map<string, GenerationGuard>();
export function getGenerationGuard(): GenerationGuard {
  const directory = getProfileDirectory();
  // Mock transports must never read or modify the user's real account state.
  const key = process.env.TEST_MOCK_PLAYWRIGHT ? `mock:${directory}` : directory;
  let guard = guards.get(key);
  if (!guard) {
    guard = new GenerationGuard(process.env.TEST_MOCK_PLAYWRIGHT ? undefined : path.join(directory, '.generation-state.json'));
    guards.set(key, guard);
  }
  return guard;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof UpstreamError) return error.retryable;
  return error instanceof Error && /fetch failed|network|ECONN|ENOTFOUND/i.test(error.message);
}

export function isTerminalGenerationError(error: unknown): boolean {
  if (generationSignal()?.aborted) return true;
  if (error instanceof UpstreamError) return !error.retryable;
  return error instanceof Error && (error.name === 'AbortError' || /Timeout waiting for PoW|login is required|account is suspended/i.test(error.message));
}
