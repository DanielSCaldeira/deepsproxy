import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installQuillBotCapture, quillBotAuthProbe } from './quillbot-browser.ts';
import { parseQuillBotStream, QUILLBOT_MODELS, quillBotError } from './quillbot-protocol.ts';

export const QUILLBOT_ORIGIN = 'https://quillbot.com';
export const QUILLBOT_CHAT_URL = QUILLBOT_ORIGIN + '/ai-chat';
// Login route referenced by the site's auth bundle; returnUrl brings the human back to the chat.
export const QUILLBOT_LOGIN_URL = QUILLBOT_ORIGIN + '/login?returnUrl=/ai-chat';
// Composer elements observed on the public pages (2026-11-06). /ai-chat renders
// the legacy composer; /ai-chat/c/... renders the "unified" one, whose send
// button stays disabled until the textarea has text and becomes a stop button.
const EDITOR = 'textarea[data-testid="ai-chat-input"]:visible, textarea[data-testid="unified-ai-chat-input"]:visible';
const SEND = 'button[data-testid="quill-chat-send-button"]:visible, button[data-testid="ai-chat-send-button"]:visible';
const STOP = 'button[data-testid="ai-chat-stop-button"]:visible';

/** One account per worker. The website prepares and sends its own requests. */
export class QuillBotProvider implements ProviderAdapter {
  readonly id = 'quillbot' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialization?: Promise<void>;
  private unlock?: () => Promise<void>;
  private readonly directory = getProfileDirectory();
  private readonly session = createSessionStore(this.directory);
  private readonly guard = getGenerationGuard();
  private readonly loginMutex = new Mutex();
  private readonly pageMutex = new Mutex();
  private interactive?: InteractiveBrowser;
  private manualLogin = false;
  private transitioning = false;
  private authenticated = false;
  private checkedAt: string | null = null;
  private state: ProviderStatus['state'] = 'not_initialized';
  private message: string | null = null;
  private quotaExhausted = false;
  private active = new Set<AbortController>();

  initialize(headless = true): Promise<void> {
    if (this.manualLogin || this.transitioning) return Promise.resolve();
    if (this.context && this.page && !this.page.isClosed()) return Promise.resolve();
    return this.initialization ??= this.launch(headless).catch(error => { this.initialization = undefined; throw error; });
  }
  private async launch(headless: boolean, restore = true): Promise<void> {
    this.unlock = await this.session.lockProfile();
    try {
      await pauseBeforeProviderAction('open-browser');
      const worker = process.env.APP_MODE === 'worker';
      const context = await nativeChromium.launchPersistentContext(this.directory, {
        channel: getBrowserChannel(), headless, locale: BROWSER_LOCALE,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--lang=pt-BR', '--disable-field-trial-config', '--password-store=basic', '--disable-dev-shm-usage',
          ...(worker ? ['--disable-quic', '--proxy-bypass-list=<-loopback>'] : [])],
        ...(worker ? { chromiumSandbox: true, acceptDownloads: false, proxy: { server: 'http://egress:3128', bypass: '<-loopback>' } } : {}),
      });
      this.context = context;
      if (restore) await this.session.restoreSession(context);
      await context.addInitScript(installQuillBotCapture);
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = null; this.page = null; this.initialization = undefined;
        this.authenticated = false; this.state = 'not_initialized';
        for (const controller of this.active) controller.abort();
        const unlock = this.unlock; this.unlock = undefined; void unlock?.();
      });
      this.page = await createBrowserPage(context);
      await this.navigate();
    } catch (error) { await this.closeAutomation(); throw error; }
  }
  private async navigate(url = QUILLBOT_CHAT_URL): Promise<void> {
    if (!this.page) throw new UpstreamError('QuillBot browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  getActivePage() { return this.page; }
  isReady() { return this.transitioning || (this.manualLogin ? !!this.interactive?.running : !!this.page && !this.page.isClosed()); }

  async connect(interactive = true): Promise<void> {
    if (process.env.APP_MODE !== 'worker' || !interactive) {
      await this.initialize(false); await this.navigate(interactive ? QUILLBOT_LOGIN_URL : QUILLBOT_CHAT_URL); return;
    }
    return this.loginMutex.withLock(async () => {
      if (this.manualLogin && this.interactive?.running) return;
      this.transitioning = true;
      try {
        await this.closeAutomation();
        // E-mail, Google, Apple and Facebook sign-in all start on the site's login page.
        this.interactive ??= new InteractiveBrowser(this.directory, QUILLBOT_LOGIN_URL);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async validate(): Promise<void> {
    if (!this.page || new URL(this.page.url()).origin !== QUILLBOT_ORIGIN) throw new UpstreamError('QuillBot login is required.', 401);
    const result = await this.page.evaluate(quillBotAuthProbe);
    this.checkedAt = new Date().toISOString();
    if (result.challenge) {
      this.state = 'unavailable'; this.message = 'Verificação do site pendente no navegador.';
      throw new UpstreamError('QuillBot browser verification is pending; open the login screen in the panel.', 503);
    }
    // A network failure (0) or server error says nothing about the login.
    if (result.status !== 200 && result.status !== 401 && result.status !== 403) {
      this.state = 'unavailable'; throw quillBotError(result.status || 503);
    }
    // A free account gets 403 from user-cache just like a visitor (live worker, 2026-11-06),
    // so the site's stored Firebase user is the login signal; 200 still counts (paid plans).
    this.authenticated = result.cookie && (result.firebaseUser || result.status === 200);
    if (!this.authenticated) {
      this.state = 'login_required'; this.message = null;
      throw new UpstreamError('QuillBot login is required; complete login in the browser.', 401);
    }
    // The site's own freemium counter. It is reported, not turned into a long
    // queue wait; a send attempt with no remaining messages fails immediately.
    this.quotaExhausted = result.remaining === 0;
    this.message = this.quotaExhausted ? 'Limite de mensagens do QuillBot atingido.' : null;
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil || this.quotaExhausted ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('QuillBot login is required. Clique em Concluir login.', 401);
    await this.validate();
    await this.session.saveSession(this.context!);
    if (interactive && this.state !== 'suspended') this.guard.confirmInteractiveLogin();
  }
  async finishLogin(): Promise<void> {
    return this.loginMutex.withLock(async () => {
      if (!this.manualLogin) return this.confirmLogin(true);
      this.transitioning = true;
      try {
        await this.interactive!.close();
        await this.launch(false, false);
        await this.validate();
        await this.session.saveSession(this.context!);
        // Authentication alone never clears a known suspension.
        if (this.guard.status().block?.state !== 'suspended') this.guard.confirmInteractiveLogin();
        this.manualLogin = false;
      } catch {
        await this.closeAutomation();
        if (!this.interactive!.running) await this.interactive!.start();
        throw new UpstreamError('QuillBot login is required. Conclua o acesso ao chat e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    if (this.page && !this.guard.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15000)) {
      try { await this.pageMutex.withLock(() => this.validate()); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; }
    }
    const guard = this.guard.status();
    return { ...guard, state: guard.block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? this.message ?? 'Limite de uso do QuillBot atingido.' : this.state === 'unavailable' ? this.message : null };
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('QuillBot login is required.', 401);
    if (this.guard.status().busy) return this.authenticated ? [...QUILLBOT_MODELS] : [];
    await this.pageMutex.withLock(() => this.validate());
    return [...QUILLBOT_MODELS];
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!QUILLBOT_MODELS.some(m => m.id === model) || this.manualLogin || this.transitioning)
      throw new UpstreamError('QuillBot model unavailable or login is required.', this.manualLogin ? 401 : 400);
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false, setupDone = false;
    let interaction = 'initialization';
    const page = this.page;
    const cancelCapture = async () => {
      if (!page || page.isClosed()) return;
      // Stop only an unfinished generation, as a person would, then abort the capture.
      const pending = await page.evaluate(() => { const c = (globalThis as any).__proxyQuillBot; return !!c && !c.done; }).catch(() => false);
      const stop = page.locator(STOP).first();
      if (pending && await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
      await page.evaluate(() => {
        const scope = globalThis as any;
        const capture = scope.__proxyQuillBot;
        if (capture && !capture.done) { capture.cancel?.(); capture.controller?.abort(); }
        delete scope.__proxyQuillBot;
      }).catch(() => {});
    };
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try { await cancelCapture(); } finally { release?.(); }
    };
    controller.signal.addEventListener('abort', () => { if (setupDone) void cleanup(); else void cancelCapture(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      timer = setTimeout(() => controller.abort(new UpstreamError('QuillBot generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        // A fresh /ai-chat page starts a new conversation; history stays in the serialized prompt.
        interaction = 'opening chat'; await this.navigate();
        interaction = 'authentication'; await this.validate();
        if (this.quotaExhausted) throw new UpstreamError('QuillBot usage limit reached.', 429);
        const editor = page!.locator(EDITOR).first();
        interaction = 'waiting for editor';
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(prompt => {
          (globalThis as any).__proxyQuillBot = { prompt, chunks: [], bytes: 0, claimed: false, done: false };
        }, prompt);
        interaction = 'filling editor'; await editor.fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site moves to /ai-chat/c/<id> after submission. The capture owns
        // completion; never time out a dispatched message waiting for navigation.
        await page!.locator(SEND).first().click({ timeout: 10_000, noWaitAfter: true });
        controller.signal.throwIfAborted();
      }));
      setupDone = true;
      controller.signal.throwIfAborted();
      const self = this;
      const claimDeadline = Date.now() + 30_000;
      const chunks = (async function* () {
        while (true) {
          controller.signal.throwIfAborted();
          const part = await page!.evaluate(() => {
            const c = (globalThis as any).__proxyQuillBot;
            if (!c) throw new Error('QuillBot capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined,
              status: c.status as number | undefined, code: c.code as string | undefined, retryAfter: c.retryAfter as string | null };
          });
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('QuillBot did not send a supported conversation request; verify the browser.', 502);
          for (const chunk of part.chunks) yield chunk;
          if (part.error) {
            const error = quillBotError(part.status ?? 502, part.code);
            self.rememberError(error, part.retryAfter); throw error;
          }
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseQuillBotStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('QuillBot web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`QuillBot web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
    }
  }
  private async closeAutomation(): Promise<void> {
    for (const controller of this.active) controller.abort();
    const context = this.context;
    // The close event may not race a later launch's profile reservation.
    this.context = null; this.page = null; this.initialization = undefined; this.authenticated = false;
    try { await context?.close(); }
    finally { const unlock = this.unlock; this.unlock = undefined; await unlock?.(); this.state = 'not_initialized'; }
  }
  async close(): Promise<void> {
    return this.loginMutex.withLock(async () => {
      await this.interactive?.close(); this.manualLogin = false; await this.closeAutomation();
    });
  }
}
