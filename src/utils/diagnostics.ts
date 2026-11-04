import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = randomUUID();
export interface DiagnosticContext {
  requestId?: string;
  operationId?: string;
  operation?: 'client' | 'summary';
  attempt?: number;
}
const scope = new AsyncLocalStorage<DiagnosticContext>();
export const diagnosticContext = () => scope.getStore();
export function withDiagnostics<T>(context: DiagnosticContext, fn: () => T): T {
  return scope.run({ ...scope.getStore(), ...context }, fn);
}
export function setDiagnosticAttempt(attempt: number): void {
  const context = scope.getStore();
  if (context) context.attempt = attempt;
}

const events = new Set([
  'process.started', 'process.stopping', 'browser.launch', 'browser.launch_failed', 'browser.opened', 'browser.closed',
  'browser.close_requested', 'browser.crashed', 'browser.page_closed', 'browser.navigation',
  'browser.recovery', 'browser.network_response', 'browser.network_failed',
  'session.restore', 'session.save', 'session.transition', 'session.observed',
  'capture.started', 'capture.ready', 'capture.failed', 'capture.intentional_abort',
  'request.started', 'request.finished', 'request.cancelled', 'attempt.started', 'attempt.failed',
  'attempt.empty', 'summary.started', 'summary.finished', 'summary.failed',
  'upstream.started', 'upstream.response', 'upstream.failed',
  'stream.started', 'stream.finished', 'stream.failed', 'stream.cancelled', 'stream.code',
  'action.wait', 'queue.acquired',
]);
const enums: Record<string, readonly string[]> = {
  operation: ['client', 'summary'],
  model: ['deepseek-v4-flash', 'deepseek-v4-flash-thinking', 'deepseek-v4-pro', 'deepseek-v4-pro-thinking', 'other'],
  state: ['not_initialized', 'authenticated', 'login_required', 'suspended', 'unavailable'],
  previousState: ['not_initialized', 'authenticated', 'login_required', 'suspended', 'unavailable'],
  reason: ['login_route', 'login_text', 'editor_visible', 'editor_missing', 'suspension_signal', 'status_probe', 'browser_closed', 'snapshot_saved'],
  category: ['login_required', 'suspended', 'input_unavailable', 'capture_timeout', 'timeout', 'network', 'http_error', 'tool_call', 'unknown'],
  route: ['chat_completion', 'chat_create', 'pow_challenge', 'user', 'api_other', 'login', 'chat', 'external', 'blank', 'other'],
  action: ['open-chat', 'open-browser', 'send-message'],
  outcome: ['ok', 'failed', 'missing', 'empty', 'cancelled'],
};
const numbers = new Set(['attempt', 'maxAttempts', 'durationMs', 'queueWaitMs', 'queued', 'intervalMs', 'messageCount', 'promptChars', 'status', 'code', 'delayMs']);
const booleans = new Set(['headless', 'requested', 'hasAuthorization', 'hasCookie', 'hasPow', 'hasDliq', 'hasLeim', 'stream', 'thinking', 'pro', 'loginRequired', 'suspended', 'editorVisible']);

/** An allowlist, not a redactor: arbitrary strings and unknown fields never reach disk. */
function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (booleans.has(key) && typeof value === 'boolean') safe[key] = value;
    else if (Object.hasOwn(enums, key) && enums[key]!.includes(value as string)) safe[key] = value;
    else if (['requestId', 'operationId', 'browserId'].includes(key) && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export function diagnosticRoute(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'about:') return 'blank';
    if (url.hostname !== 'chat.deepseek.com') return 'external';
    if (/sign_in|login/.test(url.pathname)) return 'login';
    const routes: Record<string, string> = {
      '/api/v0/chat/completion': 'chat_completion', '/api/v0/chat_session/create': 'chat_create',
      '/api/v0/chat/create_pow_challenge': 'pow_challenge', '/api/v0/users/current': 'user',
    };
    return routes[url.pathname] || (url.pathname.startsWith('/api/v0/') ? 'api_other' : 'chat');
  } catch { return 'other'; }
}

export function diagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/account is suspended/i.test(message)) return 'suspended';
  if (/login is required/i.test(message)) return 'login_required';
  if (/chat input unavailable/i.test(message)) return 'input_unavailable';
  if (/Timeout waiting for PoW/i.test(message)) return 'capture_timeout';
  if (/timeout/i.test(message)) return 'timeout';
  if (/Failed to fetch from DeepSeek: /i.test(message)) return 'http_error';
  if (/fetch failed|network|ECONN|ENOTFOUND/i.test(message)) return 'network';
  if (error instanceof Error && error.name === 'ToolCallError') return 'tool_call';
  return 'unknown';
}

/** Serial writes, bounded memory and bounded disk use. All failures stay observational. */
export class DiagnosticWriter {
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  private lastWarning = -Infinity;
  constructor(readonly file: string, private maxBytes = 10 * 1024 * 1024, private maxPending = 1000) {}

  private warn(): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    console.warn('[diagnostics] Não foi possível gravar todos os eventos; verifique espaço, permissões ou sobrecarga do log.');
  }

  emit(event: string, fields: Record<string, unknown> = {}, context = diagnosticContext()): void {
    if (!events.has(event)) return;
    if (this.pending >= this.maxPending) { this.warn(); return; }
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, runId, event, ...safeFields({ ...context, ...fields }) }) + '\n';
    this.pending++;
    this.tail = this.tail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const size = await fs.stat(this.file).then(s => s.size, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return 0; throw e; });
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
        for (let index = 3; index >= 1; index--) {
          const destination = this.backup(index);
          await fs.rm(destination, { force: true });
          await fs.rename(index === 1 ? this.file : this.backup(index - 1), destination).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        }
      }
      await fs.appendFile(this.file, line, { mode: 0o600 });
    }).catch(() => this.warn()).finally(() => { this.pending--; });
  }
  private backup(index: number): string {
    const base = this.file.endsWith('.log') ? this.file.slice(0, -4) : this.file;
    return `${base}.${index}.log`;
  }
  async flush(): Promise<void> { await this.tail; }
}

let writer: DiagnosticWriter | undefined;
function enabled(): boolean {
  if (process.env.DEEPSPROXY_DIAGNOSTICS !== undefined) return process.env.DEEPSPROXY_DIAGNOSTICS !== '0';
  return process.env.APP_MODE !== 'worker' && !process.env.NODE_TEST_CONTEXT && !process.env.TEST_MOCK_PLAYWRIGHT;
}
export function diagnostic(event: string, fields: Record<string, unknown> = {}, context = diagnosticContext()): void {
  if (!enabled()) return;
  writer ??= new DiagnosticWriter(path.resolve(root, process.env.DEEPSPROXY_DIAGNOSTICS_FILE || 'logs/deepsproxy-diagnostic.log'));
  writer.emit(event, fields, context);
}
export async function flushDiagnostics(): Promise<void> { await writer?.flush(); }
