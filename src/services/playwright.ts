import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import { createLogger } from '../utils/logger.ts';
import { Mutex } from '../utils/mutex.ts';

const log = createLogger('playwright');

let context: BrowserContext | null = null;
let activePage: Page | null = null;

const sessionMutex = new Mutex();

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

export async function initPlaywright(headless = true): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) return;

  const profilePath = path.resolve(process.env.DEEPSEEK_PROFILE_DIR || 'deepseek_profile');
  const userAgent = process.env.DEEPSEEK_USER_AGENT || DEFAULT_USER_AGENT;

  log.info('Launching persistent context', { profilePath, headless });

  context = await chromium.launchPersistentContext(profilePath, {
    headless,
    userAgent,
    args: DEFAULT_LAUNCH_ARGS,
  });

  activePage = await context.newPage();
}

export async function closePlaywright(): Promise<void> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
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
      const suspensionMatch = fullBodyText.match(
        /Due to violation of user policies, your account has been suspended until\s+([^\.\n]+)\.\s*If you have any questions, please Contact us\./i
      );
      return {
        url: location.href,
        title: document.title,
        suspended: /suspended until|violation of user policies|account has been suspended/i.test(fullBodyText),
        suspendedUntil: suspensionMatch?.[1]?.trim() || null,
        suspensionOriginal: suspensionMatch?.[0]?.trim() || null,
        loginRequired: /log in|login|sign in|entrar/i.test(fullBodyText),
      };
    })
    .catch((e: any) => ({ evaluateError: e?.message || String(e) }));
}

async function ensureChatInputReady(page: Page): Promise<void> {
  const chatInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
  const timeoutMs = Number(process.env.DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS || '8000');

  try {
    await page.waitForSelector(chatInputSelector, { timeout: timeoutMs });
  } catch {
    const state = await inspectPageState(page);
    if (state.suspended) {
      const detail =
        state.suspensionOriginal ||
        (state.suspendedUntil
          ? `Due to violation of user policies, your account has been suspended until ${state.suspendedUntil}.`
          : 'DeepSeek reported an account suspension.');
      throw new Error(`DeepSeek account is suspended; chat input is unavailable. Original DeepSeek message: ${detail}`);
    }
    if (state.loginRequired) {
      throw new Error('DeepSeek login is required; chat input is unavailable.');
    }
    throw new Error('DeepSeek chat input unavailable; page did not expose an input box.');
  }
}

async function captureHeadersFromInterception(page: Page): Promise<HeaderCaptureResult> {
  return new Promise<HeaderCaptureResult>((resolve, reject) => {
    const timeoutMs = Number(process.env.DEEPSPROXY_POW_TIMEOUT_MS || '30000');
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for PoW headers')), timeoutMs);

    const route = '**/api/v0/chat/completion';
    const routeHandler = async (r: any, request: any) => {
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

      await r.abort('aborted');
      await page.unroute(route, routeHandler).catch(() => undefined);

      resolve({ headers, chatSessionId: uiSessionId, parentMessageId: uiParentMessageId });
    };

    page
      .route(route, routeHandler)
      .then(async () => {
        try {
          await page.fill('textarea', 'a');
          await page.keyboard.press('Enter');
        } catch (e: any) {
          clearTimeout(timeout);
          await page.unroute(route, routeHandler).catch(() => undefined);
          reject(new Error(`Failed to trigger PoW: ${e?.message || String(e)}`));
        }
      })
      .catch((e: any) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to install route: ${e?.message || String(e)}`));
      });
  });
}

export async function getDeepSeekHeaders(forceNew = false): Promise<HeaderCaptureResult> {
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

  return sessionMutex.withLock(async () => {
    if (!activePage) throw new Error('Playwright not initialized');
    const page = activePage;

    if (sessionMutex.queueDepth > 1) {
      log.debug('Serialized PoW capture', { queued: sessionMutex.queueDepth });
    }

    const currentUrl = page.url();
    const isOnDeepSeek = currentUrl.includes('chat.deepseek.com');
    const isOnSpecificChat = isOnDeepSeek && /\/chat\/\d+/.test(currentUrl);

    if (!isOnDeepSeek || forceNew || isOnSpecificChat) {
      await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
    }

    await ensureChatInputReady(page);
    return captureHeadersFromInterception(page);
  });
}
