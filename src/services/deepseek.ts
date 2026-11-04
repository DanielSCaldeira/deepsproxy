import { getDeepSeekHeaders, DeepSeekHeaders } from './playwright.ts';
import { createLogger } from '../utils/logger.ts';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { diagnostic, diagnosticContext, diagnosticError } from '../utils/diagnostics.ts';
import { getGenerationGuard, generationSignal, UpstreamError, retryAfterMilliseconds } from './generation-guard.ts';
import { upstreamMessage } from '../utils/api-error.ts';

const log = createLogger('deepseek');
const egressProxy = process.env.APP_MODE === 'worker' ? new ProxyAgent('http://egress:3128') : null;

const sessionStates: Record<string, number | null> = (globalThis as any)._sessionStates || {};
(globalThis as any)._sessionStates = sessionStates;

export function updateSessionParent(sessionId: string, parentId: number | null): void {
  if (sessionId) {
    sessionStates[sessionId] = parentId;
  }
}

export interface DeepSeekPayload {
  chat_session_id?: string;
  parent_message_id?: number | null;
  model_type: string | null;
  prompt: string;
  ref_file_ids: string[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  preempt: boolean;
}

export interface DeepSeekStreamResult {
  stream: ReadableStream;
  headers: DeepSeekHeaders;
  uiSessionId: string;
}

const DEEPSEEK_CHAT_URL = 'https://chat.deepseek.com/api/v0/chat/completion';
let lastDispatchAt: number | undefined;

/** Observe reads without buffering, consuming extra chunks or changing cancellation. */
export function observeDeepSeekStream(stream: ReadableStream, finish: () => void = () => {}, signal?: AbortSignal): ReadableStream {
  const trace = { ...diagnosticContext() };
  const started = Date.now();
  const reader = stream.getReader();
  let finished = false;
  let empty = true;
  let output: ReadableStreamDefaultController;
  const cleanup = () => { signal?.removeEventListener('abort', abort); finish(); };
  const abort = () => {
    if (finished) return;
    finished = true;
    void reader.cancel(signal?.reason).catch(() => undefined).finally(() => reader.releaseLock());
    output.error(signal?.reason);
    cleanup();
  };
  diagnostic('stream.started', {}, trace);
  return new ReadableStream({
    start(controller) {
      output = controller;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true;
          diagnostic('stream.finished', { durationMs: Date.now() - started, outcome: empty ? 'empty' : 'ok' }, trace);
          reader.releaseLock();
          controller.close();
          cleanup();
        } else {
          if (next.value?.byteLength) empty = false;
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        diagnostic('stream.failed', { durationMs: Date.now() - started, category: diagnosticError(error) }, trace);
        reader.releaseLock();
        controller.error(error);
        cleanup();
      }
    },
    async cancel(reason) {
      finished = true;
      diagnostic('stream.cancelled', { durationMs: Date.now() - started }, trace);
      try { await reader.cancel(reason); } finally { reader.releaseLock(); cleanup(); }
    },
  }, { highWaterMark: 0 });
}

function buildRequestHeaders(headers: DeepSeekHeaders): Record<string, string> {
  const appVersion = process.env.DEEPSEEK_APP_VERSION || '2.0.0';
  const clientVersion = process.env.DEEPSEEK_CLIENT_VERSION || appVersion;
  const clientLocale = process.env.DEEPSEEK_CLIENT_LOCALE || 'pt_BR';
  const acceptLanguage = process.env.DEEPSEEK_ACCEPT_LANGUAGE || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';

  return {
    accept: '*/*',
    'accept-language': acceptLanguage,
    authorization: headers.authorization,
    'content-type': 'application/json',
    origin: 'https://chat.deepseek.com',
    cookie: headers.cookie,
    'x-ds-pow-response': headers['x-ds-pow-response'],
    'x-hif-dliq': headers['x-hif-dliq'],
    'x-hif-leim': headers['x-hif-leim'],
    'x-app-version': appVersion,
    'x-client-locale': clientLocale,
    'x-client-platform': 'web',
    'x-client-version': clientVersion,
  };
}

export async function createDeepSeekStream(
  prompt: string,
  enableThinking: boolean,
  isProModel: boolean = false,
  forcedParentId?: number | null
): Promise<DeepSeekStreamResult> {
  const guard = getGenerationGuard();
  const signal = generationSignal();
  const release = await guard.acquire(signal);
  try {
    return await dispatchDeepSeekStream(prompt, enableThinking, isProModel, forcedParentId, release, signal);
  } catch (error) { release(); throw error; }
}

async function dispatchDeepSeekStream(prompt: string, enableThinking: boolean, isProModel: boolean,
  forcedParentId: number | null | undefined, release: () => void, signal?: AbortSignal): Promise<DeepSeekStreamResult> {
  const { headers, chatSessionId, parentMessageId } = await getDeepSeekHeaders(forcedParentId === null);
  signal?.throwIfAborted();
  getGenerationGuard().assertAllowed();

  let actualParentId: number | null = parentMessageId;
  if (forcedParentId !== undefined) {
    actualParentId = forcedParentId;
  } else if (chatSessionId && sessionStates[chatSessionId] !== undefined) {
    actualParentId = sessionStates[chatSessionId];
  }

  const payload: DeepSeekPayload = {
    chat_session_id: chatSessionId || undefined,
    parent_message_id: actualParentId,
    model_type: isProModel ? 'expert' : null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: enableThinking,
    search_enabled: true,
    preempt: false,
  };

  log.debug('Dispatching DeepSeek request', {
    sessionId: chatSessionId || '(new)',
    parentId: actualParentId,
    promptChars: prompt.length,
    thinking: enableThinking,
    pro: isProModel,
  });

  const request = {
    method: 'POST',
    headers: buildRequestHeaders(headers),
    body: JSON.stringify(payload),
    signal,
  };
  const started = Date.now();
  diagnostic('upstream.started', { route: 'chat_completion', promptChars: prompt.length, thinking: enableThinking, pro: isProModel,
    ...(lastDispatchAt === undefined ? {} : { intervalMs: started - lastDispatchAt }) });
  lastDispatchAt = started;
  let response;
  try {
    response = egressProxy
      ? await proxyFetch(DEEPSEEK_CHAT_URL, { ...request, dispatcher: egressProxy })
      : await fetch(DEEPSEEK_CHAT_URL, request);
  } catch (error) {
    diagnostic('upstream.failed', { category: diagnosticError(error), durationMs: Date.now() - started });
    throw error;
  }
  diagnostic('upstream.response', { route: 'chat_completion', status: response.status, durationMs: Date.now() - started });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    const originalMessage = upstreamMessage(errText);
    const guard = getGenerationGuard();
    if (response.status === 401) guard.block({ state: 'login_required', originalMessage });
    if (response.status === 403 && /suspend|suspens|suspensa/i.test(originalMessage ?? '')) guard.block({ state: 'suspended', originalMessage });
    if (response.status === 429) guard.defer(retryAfterMilliseconds(response.headers.get('retry-after')));
    guard.assertAllowed();
    throw new UpstreamError(`Failed to fetch from DeepSeek: ${response.status} ${response.statusText}`, response.status,
      response.status === 429 || response.status >= 500, originalMessage);
  }

  return { stream: observeDeepSeekStream(response.body as unknown as ReadableStream, release, signal), headers, uiSessionId: chatSessionId };
}
