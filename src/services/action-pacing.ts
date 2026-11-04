import { Mutex } from '../utils/mutex.ts';
import { createLogger } from '../utils/logger.ts';
import { diagnostic } from '../utils/diagnostics.ts';
import { setTimeout as abortableSleep } from 'node:timers/promises';
import { generationSignal } from './generation-guard.ts';

const log = createLogger('pacing');
const DEFAULT_RANGE = { minMs: 10_000, maxMs: 15_000 };
const MAX_DELAY_MS = 60_000;

export interface ActionDelayRange {
  minMs: number;
  maxMs: number;
}

export function getActionDelayRange(env: NodeJS.ProcessEnv = process.env): ActionDelayRange {
  const minMs = Number(env.DEEPSPROXY_ACTION_DELAY_MIN_MS ?? DEFAULT_RANGE.minMs);
  const maxMs = Number(env.DEEPSPROXY_ACTION_DELAY_MAX_MS ?? DEFAULT_RANGE.maxMs);
  if (!Number.isInteger(minMs) || !Number.isInteger(maxMs) || minMs < 0 || maxMs < minMs || maxMs > MAX_DELAY_MS) {
    return { ...DEFAULT_RANGE };
  }
  return { minMs, maxMs };
}

/** Queue waits so concurrent requests cannot all resume after the same delay. */
export class ActionPacer {
  private readonly mutex = new Mutex();

  constructor(
    private readonly sleep: (ms: number) => Promise<void> = ms => abortableSleep(ms, undefined, { signal: generationSignal() }),
    private readonly random: () => number = Math.random,
  ) {}

  async pause(action: string, range = getActionDelayRange()): Promise<void> {
    await this.mutex.withLock(async () => {
      if (range.maxMs === 0) return;
      const delayMs = range.minMs + Math.floor(this.random() * (range.maxMs - range.minMs + 1));
      if (delayMs === 0) return;
      log.info('Waiting before DeepSeek action', { action, delayMs });
      diagnostic('action.wait', { action, delayMs });
      await this.sleep(delayMs);
    });
  }
}

const pacer = new ActionPacer();

export async function pauseBeforeDeepSeekAction(action: string): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  await pacer.pause(action);
}
