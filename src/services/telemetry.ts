import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('telemetry');

export interface ModelTelemetry {
  detectedLimit: number;
  maxSuccessSize: number;
  minFailureSize: number;
}

const DEFAULT_CONTEXT_CHARACTERS = 64_000 * 3.5;
const MIN_CONTEXT_CHARACTERS = 50 * 3.5;
const PERSIST_DEBOUNCE_MS = 1000;

const telemetryStore: Record<string, ModelTelemetry> = {};

interface PersistedShape {
  version: 1;
  models: Record<string, ModelTelemetry>;
}

function persistFilePath(): string {
  if (process.env.DEEPSPROXY_TELEMETRY_FILE) return path.resolve(process.env.DEEPSPROXY_TELEMETRY_FILE);
  const profileDir = process.env.DEEPSEEK_PROFILE_DIR || 'deepseek_profile';
  return path.resolve(profileDir, '.telemetry.json');
}

function loadFromDisk(): void {
  if (process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST === '1') return;
  const file = persistFilePath();
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as PersistedShape;
    if (parsed && parsed.version === 1 && parsed.models) {
      for (const [model, stats] of Object.entries(parsed.models)) {
        if (
          stats &&
          typeof stats.detectedLimit === 'number' &&
          typeof stats.maxSuccessSize === 'number' &&
          typeof stats.minFailureSize === 'number'
        ) {
          telemetryStore[model] = {
            detectedLimit: stats.detectedLimit,
            maxSuccessSize: stats.maxSuccessSize,
            minFailureSize: stats.minFailureSize === null ? Infinity : stats.minFailureSize,
          };
        }
      }
      log.info('Loaded persisted telemetry', { models: Object.keys(telemetryStore).length, file });
    }
  } catch (e: any) {
    log.warn('Failed to load telemetry; starting fresh', { error: e?.message || String(e) });
  }
}

let persistTimer: NodeJS.Timeout | null = null;

function schedulePersist(): void {
  if (process.env.DEEPSPROXY_DISABLE_TELEMETRY_PERSIST === '1') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
}

function persistNow(): void {
  persistTimer = null;
  const file = persistFilePath();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const serializable: PersistedShape = { version: 1, models: {} };
    for (const [model, stats] of Object.entries(telemetryStore)) {
      serializable.models[model] = {
        detectedLimit: stats.detectedLimit,
        maxSuccessSize: stats.maxSuccessSize,
        minFailureSize: Number.isFinite(stats.minFailureSize) ? stats.minFailureSize : Number.MAX_SAFE_INTEGER,
      };
    }

    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(serializable, null, 2));
    fs.renameSync(tmp, file);
  } catch (e: any) {
    log.warn('Failed to persist telemetry', { error: e?.message || String(e) });
  }
}

process.once('beforeExit', () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistNow();
  }
});

loadFromDisk();

function initTelemetry(model: string): ModelTelemetry {
  if (!telemetryStore[model]) {
    telemetryStore[model] = {
      detectedLimit: DEFAULT_CONTEXT_CHARACTERS,
      maxSuccessSize: 0,
      minFailureSize: Infinity,
    };
  }
  return telemetryStore[model];
}

export function getModelTelemetry(model: string): ModelTelemetry {
  return initTelemetry(model);
}

export function getContextLength(model: string): number {
  const stats = initTelemetry(model);
  return Math.ceil(stats.detectedLimit / 3.5);
}

export function recordSuccess(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.maxSuccessSize = Math.max(stats.maxSuccessSize, promptSize);

  if (promptSize > stats.detectedLimit) {
    stats.detectedLimit = promptSize;
  }

  if (stats.detectedLimit >= stats.minFailureSize) {
    stats.detectedLimit = Math.floor(stats.minFailureSize * 0.95);
  }

  log.info('Recorded success', {
    model,
    promptChars: promptSize,
    detectedLimitChars: stats.detectedLimit,
    detectedLimitTokens: Math.ceil(stats.detectedLimit / 3.5),
  });
  schedulePersist();
}

export function recordFailure(model: string, promptSize: number): void {
  const stats = initTelemetry(model);
  stats.minFailureSize = Math.min(stats.minFailureSize, promptSize);

  const newLimit = Math.floor(promptSize * 0.85);
  stats.detectedLimit = Math.max(MIN_CONTEXT_CHARACTERS, Math.min(stats.detectedLimit, newLimit));

  if (stats.detectedLimit < stats.maxSuccessSize) {
    stats.detectedLimit = stats.maxSuccessSize;
  }

  log.warn('Recorded failure', {
    model,
    promptChars: promptSize,
    detectedLimitChars: stats.detectedLimit,
    detectedLimitTokens: Math.ceil(stats.detectedLimit / 3.5),
  });
  schedulePersist();
}
