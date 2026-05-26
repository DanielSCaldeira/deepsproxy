const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-ds-pow-response',
  'x-hif-dliq',
  'x-hif-leim',
]);

export function redactHeaders(headers: Record<string, unknown> | undefined | null): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(key)) {
      const s = typeof v === 'string' ? v : '';
      out[k] = s ? `[REDACTED:${s.length}]` : '[REDACTED]';
    } else {
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < currentLevel()) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}] [${scope}]`;
  if (meta && Object.keys(meta).length > 0) {
    console.log(`${prefix} ${message}`, meta);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
  };
}
