import type { BrowserContext, Page, Request } from 'playwright';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticWriter } from '../utils/diagnostics.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const attached = new WeakMap<BrowserContext, DiagnosticWriter>();
const writers = new Set<DiagnosticWriter>();
const pendingResults = new Set<Promise<void>>();
const captchaErrors = new Set(['challenge-expired', 'invalid-data', 'invalid-request', 'invalid-input-response',
  'missing-input-response', 'invalid-or-already-seen-response', 'invalid-sitekey', 'rate-limited', 'network-error',
  'internal-error', 'user-aborted']);

/** Only result flags and recognized error codes; never answers, challenge data or tokens. */
export function captchaResult(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const data = body as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ['success', 'pass']) if (typeof data[key] === 'boolean') safe[key] = data[key];
  if (Array.isArray(data['error-codes'])) safe.errorCodes = [...new Set(data['error-codes'].slice(0, 10)
    .map(code => typeof code === 'string' && captchaErrors.has(code) ? code : 'other'))];
  return safe;
}

/** Keep endpoint names while removing query values, credentials and resource IDs. */
export function browserLogUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return `${url.protocol}[redacted]`;
    const pathname = url.pathname.split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      return /@|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{24,}|^\d{4,}$/.test(decoded) ? '[id]' : segment;
    }).join('/');
    return `${url.protocol}//${url.host}${pathname}`.slice(0, 1024);
  } catch { return '[invalid-url]'; }
}

/** Console text is bounded and scrubbed; structured console arguments are not serialized. */
export function browserLogText(raw: string): string {
  return raw.slice(0, 16_384)
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"')]+/gi, browserLogUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/(["']?(?:authorization|cookie|set-cookie|password|passwd|token|access_token|refresh_token|api[_-]?key|secret|prompt|messages|content)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\n]*\]|\{[^\n]*\}|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, '[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[id]')
    .slice(0, 2048);
}

function browserFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'provider' && ['deepseek', 'qwen', 'chatgpt', 'claude', 'perplexity', 'cohere', 'ernie'].includes(String(value))) safe[key] = value;
    else if (['browserId', 'pageId', 'networkRequestId'].includes(key) && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) safe[key] = value;
    else if (['status', 'durationMs', 'line', 'column'].includes(key) && typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (key === 'url' && typeof value === 'string') safe[key] = browserLogUrl(value);
    else if (key === 'message' && typeof value === 'string') safe[key] = browserLogText(value);
    else if (['success', 'pass'].includes(key) && typeof value === 'boolean') safe[key] = value;
    else if (key === 'errorCodes' && Array.isArray(value)) safe[key] = value.slice(0, 10).filter(code => captchaErrors.has(code) || code === 'other');
    else if (['method', 'resourceType', 'level'].includes(key) && typeof value === 'string' && /^[a-zA-Z_-]{1,24}$/.test(value)) safe[key] = value;
  }
  return safe;
}

export function observeBrowser(context: BrowserContext, options: { enabled?: boolean; file?: string; mirror?: boolean } = {}): DiagnosticWriter | undefined {
  const enabled = options.enabled ?? (process.env.DEEPSPROXY_BROWSER_LOG !== '0' &&
    (process.env.DEEPSPROXY_BROWSER_LOG === '1' || (!process.env.NODE_TEST_CONTEXT && !process.env.TEST_MOCK_PLAYWRIGHT)));
  if (!enabled) return;
  const existing = attached.get(context);
  if (existing) return existing;
  const provider = process.env.PROVIDER === 'claude' ? 'claude' : process.env.PROVIDER === 'perplexity' ? 'perplexity' : process.env.PROVIDER === 'cohere' ? 'cohere' : process.env.PROVIDER === 'ernie' ? 'ernie' : process.env.PROVIDER === 'chatgpt' ? 'chatgpt' : process.env.PROVIDER === 'qwen' ? 'qwen' : 'deepseek';
  const worker = process.env.APP_MODE === 'worker';
  const file = options.file || process.env.DEEPSPROXY_BROWSER_LOG_FILE || (worker
    ? path.join(process.env.PROVIDER_PROFILE_DIR || '/profile', 'browser-diagnostic.log')
    : `logs/browser-${provider}.log`);
  const writer = new DiagnosticWriter(path.resolve(root, file), 10 * 1024 * 1024, 1000, browserFields, options.mirror ?? worker);
  attached.set(context, writer); writers.add(writer);
  const browserId = randomUUID();
  const emit = (event: string, fields: Record<string, unknown> = {}) => writer.emit(event, { provider, browserId, ...fields }, {});
  const pages = new WeakMap<Page, string>();
  const requests = new WeakMap<Request, { networkRequestId: string; started: number }>();
  const observePage = (page: Page) => {
    if (pages.has(page)) return;
    const pageId = randomUUID(); pages.set(page, pageId);
    emit('browser.page_opened', { pageId, url: page.url() });
    page.on('console', message => {
      const location = message.location();
      emit('browser.console', { pageId, level: message.type(), message: message.text(), url: location.url || page.url(), line: location.lineNumber, column: location.columnNumber });
    });
    page.on('pageerror', error => emit('browser.page_error', { pageId, message: error.message, url: page.url() }));
    page.on('crash', () => emit('browser.crashed', { pageId }));
    page.on('close', () => emit('browser.page_closed', { pageId }));
  };
  const requestFields = (request: Request) => {
    let pageId: string | undefined;
    try { pageId = pages.get(request.frame().page()); } catch { /* Service worker request. */ }
    const trace = requests.get(request);
    return { pageId, networkRequestId: trace?.networkRequestId, method: request.method(), url: request.url(), resourceType: request.resourceType(), durationMs: trace ? Date.now() - trace.started : 0 };
  };
  context.on('page', observePage);
  for (const page of context.pages()) observePage(page);
  context.on('request', request => {
    requests.set(request, { networkRequestId: randomUUID(), started: Date.now() });
    emit('browser.request', requestFields(request));
  });
  context.on('response', response => {
    const fields = { ...requestFields(response.request()), status: response.status() };
    emit('browser.response', fields);
    const url = new URL(response.url());
    if (url.protocol !== 'https:' || url.hostname !== 'api.hcaptcha.com' || !url.pathname.startsWith('/checkcaptcha/')) return;
    const task = (async () => {
      try { emit('browser.captcha_result', { ...fields, ...captchaResult(await response.json()) }); }
      catch { emit('browser.captcha_result', fields); }
    })();
    pendingResults.add(task); void task.finally(() => pendingResults.delete(task));
  });
  context.on('requestfinished', request => {
    emit('browser.request_finished', requestFields(request)); requests.delete(request);
  });
  context.on('requestfailed', request => {
    emit('browser.request_failed', { ...requestFields(request), message: request.failure()?.errorText }); requests.delete(request);
  });
  context.on('close', () => {
    emit('browser.closed'); void Promise.all([...pendingResults]).then(() => writer.flush()).finally(() => writers.delete(writer));
  });
  emit('browser.log_started');
  return writer;
}

export async function flushBrowserLogs(): Promise<void> {
  await Promise.all([...pendingResults]);
  await Promise.all([...writers].map(writer => writer.flush()));
}
