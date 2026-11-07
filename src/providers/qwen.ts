import type { BrowserContext, Page } from 'playwright';
import { BROWSER_LOCALE, chromium, configureBrowserUserAgent, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { GenerationGuard, getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { createSessionStore } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { Mutex } from '../utils/mutex.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { qwenBrowserFetch, qwenResponseJson, type QwenResponse } from './qwen-browser.ts';
import { parseQwenStream, qwenModels, qwenPayload } from './qwen-protocol.ts';

const ORIGIN = 'https://chat.qwen.ai';
const AUTH_ORIGIN = 'https://auth.qwen.ai';
const SIGN_IN = `${ORIGIN}/auth?action=signin`;

/** One persistent profile/account per isolated process; login is exclusively manual. */
export class QwenProvider implements ProviderAdapter {
  readonly id = 'qwen' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialization?: Promise<void>;
  private token: string | null = null;
  private version: string | null = null;
  private checkedAt: string | null = null;
  private state: ProviderStatus['state'] = 'not_initialized';
  private unlock?: () => Promise<void>;
  private active = new Set<AbortController>();
  private directory = path.resolve(fileURLToPath(new URL('../../', import.meta.url)),
    process.env.PROVIDER_PROFILE_DIR || process.env.QWEN_PROFILE_DIR || (process.env.APP_MODE === 'worker' ? '/profile' : 'qwen_profile'));
  private session = createSessionStore(this.directory);
  private guard?: GenerationGuard;
  private catalog?: { models: ProviderModel[]; checkedAt: number };

  private readonly loginMutex = new Mutex();
  private interactive?: InteractiveBrowser;
  private manualLogin = false;
  private transitioning = false;

  initialize(headless = true): Promise<void> {
    if (this.manualLogin || this.transitioning) return Promise.resolve();
    if (this.context && this.page && !this.page.isClosed()) return Promise.resolve();
    return this.initialization ??= this.launch(headless).catch(error => { this.initialization = undefined; throw error; });
  }
  private async launch(headless: boolean): Promise<void> {
    this.unlock = await this.session.lockProfile();
    try {
      this.guard = getGenerationGuard();
      const worker = process.env.APP_MODE === 'worker';
      await pauseBeforeProviderAction('open-browser');
      configureBrowserUserAgent();
      const context = await chromium.launchPersistentContext(this.directory, {
        channel: getBrowserChannel(), headless, locale: BROWSER_LOCALE,
        // Hide Chromium's automation infobar; site-side detection is independent.
        ignoreDefaultArgs: ['--enable-automation'],
        args: [`--lang=${BROWSER_LOCALE}`, '--disable-dev-shm-usage', ...(worker ? ['--disable-quic', '--proxy-bypass-list=<-loopback>'] : [])],
        ...(worker ? { chromiumSandbox: true, acceptDownloads: false, proxy: { server: 'http://egress:3128', bypass: '<-loopback>' } } : {}),
      });
      this.context = context;
      // Skipped while a fresh human login in the profile is still unconfirmed.
      await this.session.restoreSession(this.context);
      this.context.on('request', request => {
        if (![ORIGIN, AUTH_ORIGIN].includes(new URL(request.url()).origin)) return;
        const headers = request.headers();
        if (/^Bearer /i.test(headers.authorization || '')) this.token = headers.authorization;
        if (headers.version) this.version = headers.version;
      });
      this.context.on('response', async response => {
        if (response.url().split('?')[0] !== 'https://auth.qwen.ai/api/v2/auths/refresh') return;
        try {
          const body = await response.json();
          if (typeof body?.data?.access_token === 'string') this.token = `Bearer ${body.data.access_token}`;
        } catch { /* Frontend will expose login status on the next validation. */ }
      });
      this.context.on('close', () => {
        // The close event may not race a later launch's profile reservation.
        if (this.context !== context) return;
        this.context = null; this.page = null; this.token = null; this.state = 'not_initialized';
        this.initialization = undefined;
        const unlock = this.unlock; this.unlock = undefined; void unlock?.();
        for (const controller of this.active) controller.abort();
      });
      this.page = await createBrowserPage(this.context);
      // Restore an existing session on the chat page. The sign-in form is
      // opened only when the user explicitly connects through the panel.
      await this.navigate(ORIGIN);
    } catch (error) { await this.closeAutomation(); throw error; }
  }
  getActivePage(): Page | null { return this.page; }
  isReady() { return this.transitioning || (this.manualLogin ? !!this.interactive?.running : !!this.page && !this.page.isClosed()); }
  async connect(interactive = true): Promise<void> {
    if (process.env.APP_MODE !== 'worker' || !interactive) {
      await this.initialize(false);
      await this.navigate(interactive ? SIGN_IN : ORIGIN);
      return;
    }
    return this.loginMutex.withLock(async () => {
      if (this.manualLogin && this.interactive?.running) return;
      this.transitioning = true;
      try {
        await this.closeAutomation();
        // Google rejects sign-in from a browser driven over CDP ("Esse navegador ou app pode não
        // ser seguro"), so the person signs in through a plain Chromium on the same profile.
        this.interactive ??= new InteractiveBrowser(this.directory, SIGN_IN);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  async finishLogin(): Promise<void> {
    return this.loginMutex.withLock(async () => {
      if (!this.manualLogin) return this.confirmLogin(true);
      this.transitioning = true;
      try {
        await this.interactive!.close();
        await this.launch(false);
        await this.waitForToken();
        await this.validate();
        await this.session.saveSession(this.context!);
        this.guard?.confirmInteractiveLogin();
        this.manualLogin = false;
      } catch {
        await this.closeAutomation();
        if (!this.interactive!.running) await this.interactive!.start();
        throw new UpstreamError('Qwen login is required. Conclua o acesso no Qwen e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  /** The chat frontend sends its stored bearer token with its first API calls after loading. */
  private async waitForToken(timeout = 20_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!this.token && Date.now() < deadline) await delay(250);
  }
  private async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error('Qwen browser is not initialized.');
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    this.state = 'login_required';
  }
  private headers(): Record<string, string> {
    return { accept: 'application/json', 'content-type': 'application/json', source: 'web',
      ...(this.token ? { authorization: this.token } : {}), ...(this.version ? { version: this.version } : {}),
      'x-request-id': randomUUID() };
  }
  private async request(route: string, body?: unknown, signal?: AbortSignal, origin = ORIGIN): Promise<QwenResponse> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Qwen login is required.', 401);
    const headers = { ...this.headers(), ...(origin === AUTH_ORIGIN ? { 'x-request-origin': ORIGIN } : {}) };
    const response = await qwenBrowserFetch(this.page, `${origin}${route}`, headers, body, signal);
    if (response.status >= 400) {
      await response.cancel();
      if (response.status === 401) { this.state = 'login_required'; this.guard?.block({ state: 'login_required' }); }
      if (response.status === 429) this.guard?.defer(Math.max(60_000, retryAfterMilliseconds(response.retryAfter)));
      throw new UpstreamError(`Qwen upstream returned HTTP ${response.status}; validate the session in the browser if required.`, response.status, response.status === 429);
    }
    return response;
  }
  private async validate(signal?: AbortSignal): Promise<void> {
    if (!this.token) await this.waitForToken();
    if (!this.token && this.page) {
      const stored = await this.page.evaluate(() => localStorage.getItem('token')).catch(() => null);
      if (stored?.trim()) this.token = /^Bearer /i.test(stored) ? stored : `Bearer ${stored}`;
    }
    if (!this.token) throw new UpstreamError('Qwen login is required; complete login in the browser.', 401);
    // /users/status is frontend telemetry, including for guests. Only the auth
    // service's successful user response proves this is a signed-in session.
    const result = await qwenResponseJson(await this.request('/api/v2/auths/', undefined, signal, AUTH_ORIGIN));
    if (result?.success !== true || typeof result?.data?.id !== 'string' || !result.data.id) {
      this.state = 'login_required'; this.catalog = undefined;
      throw new UpstreamError('Qwen login is required; complete login in the browser.', 401);
    }
    this.state = 'authenticated'; this.checkedAt = new Date().toISOString();
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Qwen login is required. Clique em Concluir login.', 401);
    await this.validate();
    if (!this.context) throw new Error('Qwen browser is not initialized.');
    await this.session.saveSession(this.context);
    if (interactive) this.guard?.confirmInteractiveLogin();
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', checkedAt: this.checkedAt,
      sessionSaved: await this.session.hasSavedSession(), confirmationRequired: true };
    if (this.page && !this.guard?.status().block && !this.guard?.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15_000)) {
      try { await this.validate(); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; this.checkedAt = new Date().toISOString(); }
    }
    return { state: this.guard?.status().block?.state ?? this.state, checkedAt: this.checkedAt, sessionSaved: await this.session.hasSavedSession(),
      ...(this.guard?.status() ?? {}), profileInUse: !this.page && await this.session.isProfileInUse() };
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Qwen login is required.', 401);
    this.guard?.assertAllowed();
    if (this.state === 'authenticated' && this.catalog && Date.now() - this.catalog.checkedAt < 300_000) return this.catalog.models;
    await this.validate();
    const models = qwenModels(await qwenResponseJson(await this.request('/api/v2/models/')));
    this.catalog = { models, checkedAt: Date.now() };
    return models;
  }
  async generate(prompt: string, model: string, thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    signal?.throwIfAborted();
    if (!model.startsWith('qwen/') || !model.slice(5)) throw new UpstreamError('Invalid Qwen model ID.', 400);
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Qwen login is required.', 401);
    if (!this.guard) throw new Error('Qwen browser is not initialized.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let release: (() => void) | undefined;
    let response: QwenResponse | undefined;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try { await response?.cancel(); } finally { release?.(); }
    };
    const timeout = setTimeout(() => controller.abort(new Error('Qwen generation timed out.')), 180_000);
    controller.signal.addEventListener('abort', () => { void cleanup(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      await this.validate(controller.signal);
      await withGenerationSignal(controller.signal, () => pauseBeforeProviderAction('send-message'));
      const upstream = model.slice(5);
      const created = await qwenResponseJson(await this.request('/api/v2/chats/new', {
        title: 'API conversation', models: [upstream], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '',
      }, controller.signal));
      const chatId = created?.chat_id ?? created?.id ?? created?.data?.chat_id ?? created?.data?.id;
      if (typeof chatId !== 'string' || !chatId) throw new Error('Qwen did not return a chat ID.');
      response = await this.request(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
        qwenPayload(prompt, upstream, thinking, chatId, randomUUID()), controller.signal);
      if (!response.contentType.includes('text/event-stream')) throw new Error('Qwen returned a non-SSE response; validate the browser session manually.');
      const stream = response;
      return (async function* () {
        try { yield* parseQwenStream(stream.chunks, controller.signal); }
        finally { await cleanup(); }
      })();
    } catch (error) { await cleanup(); throw error; }
  }
  private async closeAutomation(): Promise<void> {
    for (const controller of this.active) controller.abort();
    const context = this.context; this.context = null; this.page = null; this.token = null; this.catalog = undefined;
    try { await context?.close(); }
    finally { const unlock = this.unlock; this.unlock = undefined; await unlock?.(); this.initialization = undefined; this.state = 'not_initialized'; }
  }
  async close(): Promise<void> {
    return this.loginMutex.withLock(async () => {
      await this.interactive?.close(); this.manualLogin = false; await this.closeAutomation();
    });
  }
}
