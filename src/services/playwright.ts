import { chromium, BrowserContext, Page, Request } from 'playwright';
import { randomUUID } from 'node:crypto';
import { diagnostic, diagnosticContext, diagnosticError, diagnosticRoute, type DiagnosticContext } from '../utils/diagnostics.ts';
import { getProfileDirectory, hasSavedSession, restoreSession, saveSession, lockProfile, isProfileInUse } from './session-store.ts';
import { createLogger } from '../utils/logger.ts';
import { Mutex } from '../utils/mutex.ts';
import { pauseBeforeDeepSeekAction } from './action-pacing.ts';
import { getGenerationGuard, generationSignal, UpstreamError } from './generation-guard.ts';

const log = createLogger('playwright');

let context: BrowserContext | null = null;
let activePage: Page | null = null;

const sessionMutex = new Mutex();
const lifecycleMutex = new Mutex();
const CHAT_INPUT_SELECTOR = 'textarea:visible, [role="textbox"]:visible, [contenteditable="true"]:visible';

type SessionState = 'not_initialized' | 'authenticated' | 'login_required' | 'suspended' | 'unavailable';
let sessionStatus: { state: SessionState; checkedAt: string | null; suspendedUntil?: string | null; originalMessage?: string | null } = {
  state: 'not_initialized', checkedAt: null,
};
let lastSavedAt = 0;
let closeRequested = false;
let browserTrace: DiagnosticContext | undefined;

function updateSession(next: typeof sessionStatus, reason: string): void {
  if (next.state === 'suspended' || next.state === 'login_required') {
    getGenerationGuard().block({ state: next.state, suspendedUntil: next.suspendedUntil, originalMessage: next.originalMessage });
  }
  if (next.state !== sessionStatus.state) {
    diagnostic('session.transition', { previousState: sessionStatus.state, state: next.state, reason }, browserTrace ?? diagnosticContext());
  }
  sessionStatus = next;
}

function observePage(page: Page, browserId: string): void {
  const requests = new WeakMap<Request, { started: number; trace?: DiagnosticContext }>();
  page.on('request', request => {
    requests.set(request, { started: Date.now(), trace: browserTrace && { ...browserTrace } });
  });
  page.on('response', response => {
    const route = diagnosticRoute(response.url());
    if (!['chat_completion', 'chat_create', 'pow_challenge', 'user', 'api_other'].includes(route)) return;
    const request = requests.get(response.request());
    diagnostic('browser.network_response', { browserId, route, status: response.status(), durationMs: request ? Date.now() - request.started : 0 }, request?.trace);
  });
  page.on('requestfailed', request => {
    const route = diagnosticRoute(request.url());
    if (!['chat_completion', 'chat_create', 'pow_challenge', 'user', 'api_other'].includes(route)) return;
    const observed = requests.get(request);
    diagnostic(intentionalAborts.has(request) ? 'capture.intentional_abort' : 'browser.network_failed',
      { browserId, route, category: 'network', durationMs: observed ? Date.now() - observed.started : 0 }, observed?.trace);
  });
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) diagnostic('browser.navigation', { browserId, route: diagnosticRoute(frame.url()) }, browserTrace);
  });
  page.on('crash', () => diagnostic('browser.crashed', { browserId }));
  page.on('close', () => diagnostic('browser.page_closed', { browserId, requested: closeRequested }));
}
const intentionalAborts = new WeakSet<Request>();

export interface DeepSeekHeaders {
  'x-ds-pow-response': string;
  'x-hif-dliq': string;
  'x-hif-leim': string;
  authorization: string;
  cookie: string;
}

export interface HeaderCaptureResult {
  headers: DeepSeekHeaders;
  chatSessionId: string;
  parentMessageId: number | null;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--exclude-switches=enable-automation',
  '--disable-infobars',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

export function getActivePage(): Page | null {
  return activePage;
}

export async function openDeepSeekChat(page: Page, timeout?: number): Promise<void> {
  await pauseBeforeDeepSeekAction('open-chat');
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', ...(timeout === undefined ? {} : { timeout }) });
}

export async function waitForAuthenticatedChat(page: Page): Promise<void> {
  while (!page.isClosed()) {
    const state = await inspectPageState(page);
    if (state.suspended) {
      updateSession({ state: 'suspended', checkedAt: new Date().toISOString(), suspendedUntil: state.suspendedUntil, originalMessage: state.suspensionOriginal }, 'suspension_signal');
      throw new UpstreamError('DeepSeek account is suspended; interactive login could not be confirmed.', 403);
    }
    const url = new URL(page.url());
    if (url.hostname === 'chat.deepseek.com' && !/sign_in|login/.test(url.pathname) &&
        await page.locator(CHAT_INPUT_SELECTOR).first().isVisible()) return;
    await page.waitForTimeout(250);
  }
  throw new Error('A janela de login foi fechada antes da confirmação.');
}

export async function initPlaywright(headless = true): Promise<void> {
  return lifecycleMutex.withLock(() => initializeBrowser(headless));
}

async function initializeBrowser(headless: boolean): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) return;

  const profilePath = getProfileDirectory();
  const userAgent = process.env.DEEPSEEK_USER_AGENT || DEFAULT_USER_AGENT;

  log.info('Launching persistent context', { profilePath, headless });
  diagnostic('browser.launch', { headless });

  const unlock = await lockProfile();
  try {
    await pauseBeforeDeepSeekAction('open-browser');
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless,
      userAgent,
      args: process.env.APP_MODE === 'worker' ? DEFAULT_LAUNCH_ARGS.filter(arg => arg !== '--no-sandbox').concat(['--disable-quic', '--proxy-bypass-list=<-loopback>']) : DEFAULT_LAUNCH_ARGS,
      ...(process.env.APP_MODE === 'worker' ? { chromiumSandbox: true, acceptDownloads: false, proxy: { server: 'http://egress:3128', bypass: '<-loopback>' } } : {}),
    });
  } catch (error) {
    diagnostic('browser.launch_failed', { category: diagnosticError(error) });
    await unlock();
    throw error;
  }

  try {
    const restored = await restoreSession(context);
    diagnostic('session.restore', { outcome: restored ? 'ok' : 'missing' });
    if (restored) log.info('Restored saved DeepSeek session');
  } catch (error) {
    diagnostic('session.restore', { outcome: 'failed', category: diagnosticError(error) });
    log.warn('Could not restore session snapshot; using the persistent browser profile');
  }
  // Chromium already opens a blank tab; reuse it instead of opening another.
  activePage = context.pages().find(page => page.url() === 'about:blank') || await context.newPage();
  closeRequested = false;
  const browserId = randomUUID();
  diagnostic('browser.opened', { browserId, headless });
  for (const page of context.pages()) observePage(page, browserId);
  context.on('page', page => observePage(page, browserId));
  context.on('close', () => {
    diagnostic('browser.closed', { browserId, requested: closeRequested });
    void unlock();
    context = null;
    activePage = null;
    updateSession({ state: 'not_initialized', checkedAt: null }, 'browser_closed');
  });
}

export async function saveAuthenticatedSession(interactive = false): Promise<void> {
  try {
    if (!interactive) getGenerationGuard().assertAllowed();
    if (!context || !activePage) throw new Error('O navegador da sessão não está disponível.');
    const state = await inspectPageState(activePage);
    if (state.suspended) {
      updateSession({ state: 'suspended', checkedAt: new Date().toISOString(), suspendedUntil: state.suspendedUntil, originalMessage: state.suspensionOriginal }, 'suspension_signal');
      throw new UpstreamError('DeepSeek account is suspended; login could not be confirmed.', 403);
    }
    if (new URL(activePage.url()).hostname !== 'chat.deepseek.com' || /sign_in|login/.test(new URL(activePage.url()).pathname) ||
        !await activePage.locator(CHAT_INPUT_SELECTOR).first().isVisible()) {
      throw new Error('A autenticação ainda não foi confirmada; mantenha o navegador aberto.');
    }
    await saveSession(context);
    if (interactive) getGenerationGuard().confirmInteractiveLogin();
    diagnostic('session.save', { outcome: 'ok' });
  } catch (error) {
    diagnostic('session.save', { outcome: 'failed', category: diagnosticError(error) });
    throw error;
  }
  lastSavedAt = Date.now();
  updateSession({ state: 'authenticated', checkedAt: new Date().toISOString() }, 'snapshot_saved');
}

export async function getSessionStatus() {
  const guard = getGenerationGuard();
  if (!guard.status().block && activePage && !guard.status().busy && sessionMutex.queueDepth === 0 &&
      (!sessionStatus.checkedAt || Date.now() - Date.parse(sessionStatus.checkedAt) > 15_000)) {
    await sessionMutex.withLock(async () => {
      try {
        if (activePage?.url() === 'about:blank') {
          await openDeepSeekChat(activePage, 15_000);
        }
        if (activePage) await ensureChatInputReady(activePage);
      } catch (error) {
        updateSession({
          ...sessionStatus,
          state: classifySessionError(String(error)),
          checkedAt: new Date().toISOString(),
        }, 'status_probe');
      }
    });
  }
  return {
    ...sessionStatus,
    ...(guard.status().block ?? {}),
    busy: guard.status().busy || sessionMutex.queueDepth > 0,
    block: guard.status().block,
    nextAllowedAt: guard.status().nextAllowedAt,
    queued: guard.status().queued,
    sessionSaved: await hasSavedSession(),
    profileInUse: !activePage && await isProfileInUse(),
  };
}

export function classifySessionError(message: string): SessionState {
  if (/account is suspended/i.test(message)) return 'suspended';
  return /login is required/i.test(message) ? 'login_required' : 'unavailable';
}

export async function closePlaywright(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    closeRequested = true;
    diagnostic('browser.close_requested');
    await context.close();
    context = null;
    activePage = null;
  }
}

interface PageState {
  url?: string;
  title?: string;
  suspended?: boolean;
  suspendedUntil?: string | null;
  suspensionOriginal?: string | null;
  loginRequired?: boolean;
  evaluateError?: string;
}

async function inspectPageState(page: Page): Promise<PageState> {
  return page
    .evaluate(() => {
      const fullBodyText = document.body?.innerText || '';
      // Visible dialogs/alerts are authoritative even with an editor underneath.
      // Conversation text alone must never block an authenticated chat.
      const notices = Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], [aria-modal="true"]'))
        .filter(node => (node as HTMLElement).getClientRects().length > 0)
        .map(node => (node as HTMLElement).innerText).join('\n');
      const editor = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]'))
        .some(node => (node as HTMLElement).getClientRects().length > 0);
      const text = editor ? notices : fullBodyText;
      const suspensionMatch = text.match(/(?:account (?:has been|is) suspended until|conta foi suspensa até)\s+([^\n]+?)(?:\.(?:\s|$)|\n|$)/i);
      const original = text.match(/(?:Due to violation of user policies|Devido à violação das políticas do usuário|(?:your )?account (?:has been|is) suspended|(?:sua )?conta foi suspensa)[^\n]*/i)?.[0];
      return {
        url: location.href,
        title: document.title,
        suspended: /suspended until|violation of user policies|account (?:has been|is) suspended|conta foi suspensa|violação das políticas do usuário/i.test(text),
        suspendedUntil: suspensionMatch?.[1]?.trim() || null,
        suspensionOriginal: original?.trim().slice(0, 4096) || null,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    })
    .catch((e: any) => ({ evaluateError: e?.message || String(e) }));
}

async function ensureChatInputReady(page: Page): Promise<void> {
  const chatInputSelector = CHAT_INPUT_SELECTOR;
  const timeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');

  const initial = await inspectPageState(page);
  diagnostic('session.observed', { route: diagnosticRoute(page.url()), loginRequired: !!initial.loginRequired, suspended: !!initial.suspended }, browserTrace ?? diagnosticContext());
  // A user's conversation can quote a suspension message. Only treat it as
  // account status before input detection when the chat editor is absent.
  if (initial.suspended) {
    updateSession({ state: 'suspended', checkedAt: new Date().toISOString(), suspendedUntil: initial.suspendedUntil, originalMessage: initial.suspensionOriginal }, 'suspension_signal');
    throw new Error('DeepSeek account is suspended; chat input is unavailable.');
  }
  if (new URL(page.url()).hostname !== 'chat.deepseek.com' || /sign_in|login/.test(new URL(page.url()).pathname)) {
    updateSession({ state: 'login_required', checkedAt: new Date().toISOString() }, 'login_route');
    throw new Error('DeepSeek login is required; chat input is unavailable.');
  }
  try {
    await page.waitForSelector(chatInputSelector, { timeout: timeoutMs });
    diagnostic('session.observed', { editorVisible: true, reason: 'editor_visible' }, browserTrace ?? diagnosticContext());
    updateSession({ state: 'authenticated', checkedAt: new Date().toISOString() }, 'editor_visible');
    if (Date.now() - lastSavedAt > 60_000) {
      await saveAuthenticatedSession().catch(() => log.warn('Could not save DeepSeek session snapshot'));
    }
  } catch {
    const state = await inspectPageState(page);
    if (state.suspended) {
      updateSession({ state: 'suspended', checkedAt: new Date().toISOString(), suspendedUntil: state.suspendedUntil, originalMessage: state.suspensionOriginal }, 'suspension_signal');
      const detail =
        state.suspensionOriginal ||
        (state.suspendedUntil
          ? `Due to violation of user policies, your account has been suspended until ${state.suspendedUntil}.`
          : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state.loginRequired) {
      updateSession({ state: 'login_required', checkedAt: new Date().toISOString() }, 'login_text');
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    diagnostic('session.observed', { editorVisible: false, reason: 'editor_missing' }, browserTrace ?? diagnosticContext());
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  }
}

async function captureHeadersFromInterception(page: Page): Promise<HeaderCaptureResult> {
  // Start the interception timeout after pacing, so slow settings do not expire it.
  await pauseBeforeDeepSeekAction('send-message');
  generationSignal()?.throwIfAborted();
  const started = Date.now();
  const trace = { ...diagnosticContext() };
  diagnostic('capture.started');
  const signal = generationSignal();
  let removeAbort = () => {};
  return new Promise<HeaderCaptureResult>((resolve, reject) => {
    let settled = false;
    const timeoutMs = Number(process.env.DEEPSPROXY_POW_TIMEOUT_MS || '30000');
    const timeout = setTimeout(() => {
      settled = true;
      diagnostic('capture.failed', { category: 'capture_timeout', durationMs: Date.now() - started }, trace);
      reject(new Error('Timeout waiting for PoW headers'));
      void page.unroute(route, routeHandler).catch(() => undefined);
    }, timeoutMs);

    const route = '**/api/v0/chat/completion';
    const routeHandler = async (r: any, request: any) => {
      if (settled) { await r.abort('aborted'); return; }
      settled = true;
      clearTimeout(timeout);

      const reqHeaders = request.headers();
      let uiSessionId = '';
      let uiParentMessageId: number | null = null;

      const postData = request.postData();
      if (postData) {
        try {
          const payload = JSON.parse(postData);
          if (payload.chat_session_id) uiSessionId = payload.chat_session_id;
          if (payload.parent_message_id !== undefined) uiParentMessageId = payload.parent_message_id;
        } catch {
          // ignore parse error - payload not JSON
        }
      }

      const headers: DeepSeekHeaders = {
        'x-ds-pow-response': reqHeaders['x-ds-pow-response'] || '',
        'x-hif-dliq': reqHeaders['x-hif-dliq'] || '',
        'x-hif-leim': reqHeaders['x-hif-leim'] || '',
        authorization: reqHeaders['authorization'] || '',
        cookie: reqHeaders['cookie'] || '',
      };

      intentionalAborts.add(request);
      diagnostic('capture.ready', { durationMs: Date.now() - started, hasAuthorization: !!headers.authorization, hasCookie: !!headers.cookie, hasPow: !!headers['x-ds-pow-response'], hasDliq: !!headers['x-hif-dliq'], hasLeim: !!headers['x-hif-leim'] }, trace);
      await r.abort('aborted');
      await page.unroute(route, routeHandler).catch(() => undefined);

      resolve({ headers, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };
    const abort = () => {
      settled = true;
      clearTimeout(timeout);
      void page.unroute(route, routeHandler).catch(() => undefined);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { abort(); return; }

    page
      .route(route, routeHandler)
      .then(async () => {
        try {
          if (settled) { await page.unroute(route, routeHandler); return; }
          await page.locator(CHAT_INPUT_SELECTOR).first().fill('a');
          if (settled) return;
          generationSignal()?.throwIfAborted();
          await page.keyboard.press('Enter');
        } catch (e: any) {
          diagnostic('capture.failed', { category: diagnosticError(e), durationMs: Date.now() - started }, trace);
          clearTimeout(timeout);
          await page.unroute(route, routeHandler).catch(() => undefined);
          reject(new Error(`Failed to trigger PoW: ${e?.message || String(e)}`));
        }
      })
      .catch((e: any) => {
        diagnostic('capture.failed', { category: diagnosticError(e), durationMs: Date.now() - started }, trace);
        clearTimeout(timeout);
        reject(new Error(`Failed to install route: ${e?.message || String(e)}`));
      });
  }).finally(() => removeAbort());
}

export async function getDeepSeekHeaders(forceNew = false): Promise<HeaderCaptureResult> {
  generationSignal()?.throwIfAborted();
  getGenerationGuard().assertAllowed();
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const mockSessionId = process.env.TEST_SESSION_ID || 'mock-session';
    return {
      headers: {
        authorization: 'Bearer MOCK',
        cookie: '',
        'x-ds-pow-response': '',
        'x-hif-dliq': '',
        'x-hif-leim': '',
      },
      chatSessionId: mockSessionId,
      parentMessageId: null,
    };
  }

  const queuedAt = Date.now();
  const trace = diagnosticContext();
  return sessionMutex.withLock(async () => {
    browserTrace = trace && { ...trace };
    diagnostic('queue.acquired', { queueWaitMs: Date.now() - queuedAt, queued: sessionMutex.queueDepth });
    try {
      generationSignal()?.throwIfAborted();
      getGenerationGuard().assertAllowed();
      if (!activePage) throw new Error('Playwright not initialized');
      const page = activePage;

      if (sessionMutex.queueDepth > 1) {
        log.debug('Serialized PoW capture', { queued: sessionMutex.queueDepth });
      }

      const currentUrl = page.url();
      const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
      const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

      // Observe any existing account notice before replacing the current page.
      if (isOnDeepSeek && (await inspectPageState(page)).suspended) await ensureChatInputReady(page);

      if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
        generationSignal()?.throwIfAborted();
        await openDeepSeekChat(page);
      }

      await ensureChatInputReady(page);
      try { return await captureHeadersFromInterception(page); }
      catch (error) {
        if (error instanceof Error && /Timeout waiting for PoW/.test(error.message)) {
          // Inspect in place: never create another chat or resend after a capture timeout.
          await ensureChatInputReady(page);
        }
        throw error;
      }
    } finally { browserTrace = undefined; }
  });
}
