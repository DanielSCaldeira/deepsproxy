import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { cohereSessionCheck, installCohereCapture } from './cohere-browser.ts';
import { cohereError, cohereModels, parseCohereStream } from './cohere-protocol.ts';

// NEXT_PUBLIC_CHAT_URL in the dashboard bundle. chat.cohere.com and
// coral.cohere.com redirect to the dashboard login (observed 2026-11-06).
const ORIGIN = 'https://dashboard.cohere.com';
export const COHERE_CHAT_URL = ORIGIN + '/playground/chat';
// NEXT_PUBLIC_BLOBHEART_HOSTNAME + "/rpc/BlobheartAPI/" + "Session"; 401 without a session (observed).
const SESSION_ENDPOINT = 'https://production.api.os.cohere.com/rpc/BlobheartAPI/Session';
// The authenticated playground HTML was not observable without an account.
// Semantic selectors only; the system/preamble field is explicitly excluded.
const NOT_SYSTEM = ':not([placeholder*="system" i]):not([aria-label*="system" i]):not([name*="preamble" i])';
const EDITOR = [
  `textarea[placeholder*="message" i]${NOT_SYSTEM}:visible`, `textarea[placeholder*="mensagem" i]${NOT_SYSTEM}:visible`,
  `textarea[aria-label*="message" i]${NOT_SYSTEM}:visible`, `textarea[name="message"]:visible`,
  `[contenteditable="true"][role="textbox"]${NOT_SYSTEM}:visible`,
].join(', ');
const SEND = 'button[aria-label*="send" i]:visible, button[aria-label*="enviar" i]:visible, button[data-testid*="send" i]:visible, form:has(textarea) button[type="submit"]:visible';
const STOP = 'button[aria-label*="stop" i]:visible, button[data-testid*="stop" i]:visible, button:has-text("Stop"):visible';
const MODEL_BUTTON = '[data-testid*="model" i]:is(button,[role="combobox"]):visible, button[aria-label*="model" i]:visible, [role="combobox"][aria-label*="model" i]:visible';

/** One account per worker. The playground prepares and sends its own requests. */
export class CohereProvider implements ProviderAdapter {
  readonly id = 'cohere' as const;
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
  private catalog: Array<ProviderModel & { label: string }> = [];
  private availableModels: ProviderModel[] = [];
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
      await context.addInitScript(installCohereCapture);
      context.on('response', response => {
        const url = new URL(response.url());
        // Public catalog shape (GET /v1/models); only used if the playground requests it.
        if (!/^api\.cohere\.(com|ai)$/.test(url.hostname) || !/^\/v[12]\/models\/?$/.test(url.pathname) || !response.ok()) return;
        void response.json().then(body => { if (this.context === context) { const models = cohereModels(body); if (models.length) this.catalog = models; } }).catch(() => {});
      });
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = null; this.page = null; this.initialization = undefined;
        this.authenticated = false; this.state = 'not_initialized'; this.catalog = [];
        for (const controller of this.active) controller.abort();
        const unlock = this.unlock; this.unlock = undefined; void unlock?.();
      });
      this.page = await createBrowserPage(context);
      await this.navigate();
    } catch (error) { await this.closeAutomation(); throw error; }
  }
  private async navigate(): Promise<void> {
    if (!this.page) throw new UpstreamError('Cohere browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(COHERE_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  getActivePage() { return this.page; }
  isReady() { return this.transitioning || (this.manualLogin ? !!this.interactive?.running : !!this.page && !this.page.isClosed()); }

  async connect(interactive = true): Promise<void> {
    if (process.env.APP_MODE !== 'worker' || !interactive) {
      await this.initialize(false); await this.navigate(); return;
    }
    return this.loginMutex.withLock(async () => {
      if (this.manualLogin && this.interactive?.running) return;
      this.transitioning = true;
      try {
        await this.closeAutomation();
        // Not automated: Google/GitHub sign-in and reCAPTCHA stay with the human.
        this.interactive ??= new InteractiveBrowser(this.directory, COHERE_CHAT_URL);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async check(): Promise<{ status: number; authenticated: boolean; refreshable: boolean }> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) return { status: 401, authenticated: false, refreshable: false };
    return this.page.evaluate(cohereSessionCheck, SESSION_ENDPOINT);
  }
  private async validate(): Promise<void> {
    let result = await this.check();
    // An expired access cookie with a refresh cookie: let the dashboard renew it once.
    if (!result.authenticated && result.refreshable && result.status === 401 && this.page) {
      await this.navigate(); await delay(2000); result = await this.check();
    }
    this.checkedAt = new Date().toISOString();
    if (result.status !== 200 && result.status !== 401 && result.status !== 403) { this.state = 'unavailable'; throw cohereError(result.status); }
    this.authenticated = result.authenticated;
    if (!this.authenticated) {
      this.state = 'login_required'; this.catalog = [];
      throw new UpstreamError('Cohere login is required; complete login in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Cohere login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Cohere login is required. Conclua o acesso ao playground e clique em Concluir login novamente.', 401);
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
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso da Cohere atingido.' : null };
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    const automatic = { id: 'cohere/auto', contextLength: 0 };
    if (!this.page) return [];
    const button = this.page.locator(MODEL_BUTTON).first();
    if (!this.catalog.length || !await button.isVisible()) return [automatic];
    await button.click({ timeout: 5000 });
    try {
      const labels = (await this.page.getByRole('option').or(this.page.getByRole('menuitem')).or(this.page.getByRole('menuitemradio')).allTextContents()).map(text => text.trim());
      return [automatic, ...this.catalog.filter(m => labels.some(text => text === m.label || text.startsWith(m.label + ' ')))];
    } finally { await this.page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Cohere login is required.', 401);
    // Do not query auth or operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      this.availableModels = await this.selectableModels();
      return this.availableModels;
    });
  }
  private async selectModel(model: string): Promise<void> {
    if (model === 'cohere/auto') return; // Playground default; the request is not checked against a specific model.
    const page = this.page!;
    const button = page.locator(MODEL_BUTTON).first();
    const label = this.catalog.find(m => m.id === model)?.label;
    if (!label) throw new UpstreamError('Unknown Cohere model.', 400);
    if (!await button.isVisible()) throw new UpstreamError('Cohere model selection unavailable.', 400);
    if ((await button.innerText()).trim() === label) return;
    await button.click({ timeout: 5000 });
    const option = page.getByRole('option', { name: label }).or(page.getByRole('menuitem', { name: label }))
      .or(page.getByRole('menuitemradio', { name: label })).first();
    if (!await option.isVisible()) {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Requested Cohere model is not selectable on this account.', 400);
    }
    await option.click({ timeout: 5000 });
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else if (error.status >= 500) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('cohere/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Cohere model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
      const stop = page.locator(STOP).first();
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
      await page.evaluate(() => {
        const scope = globalThis as any;
        scope.__proxyCohere?.controller?.abort(); delete scope.__proxyCohere;
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
      timer = setTimeout(() => controller.abort(new UpstreamError('Cohere generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        // A fresh playground page per request: the prompt already carries the history.
        interaction = 'opening chat'; await this.navigate();
        interaction = 'authentication'; await this.validate();
        if (!new URL(page!.url()).pathname.startsWith('/playground')) throw new UpstreamError('Cohere login is required.', 401);
        interaction = 'waiting for editor';
        const editor = page!.locator(EDITOR).first();
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, model }) => {
          (globalThis as any).__proxyCohere = { prompt, model, chunks: [], bytes: 0, claimed: false, done: false };
        }, { prompt, model: model.slice('cohere/'.length) });
        // Reacquire after any hydration replacement before filling.
        interaction = 'filling editor'; await page!.locator(EDITOR).first().fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'sending';
        const send = page!.locator(SEND).first();
        // Capture owns completion; never wait for navigation after dispatch.
        if (await send.isVisible()) await send.click({ timeout: 10_000, noWaitAfter: true });
        else await page!.locator(EDITOR).first().press('Enter', { timeout: 10_000, noWaitAfter: true });
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
            const c = (globalThis as any).__proxyCohere;
            if (!c) throw new Error('Cohere capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined,
              status: c.status as number | undefined, code: c.code as string | undefined, retryAfter: c.retryAfter as string | null };
          });
          // Never resend: an unclaimed request may still have been dispatched by another path.
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('Cohere did not send a supported chat request; verify the browser.', 502);
          if (part.error) {
            const error = part.error === 'model_mismatch' ? new UpstreamError('Cohere did not honor the requested model.', 400)
              : part.error === 'stale_history' ? new UpstreamError('Cohere playground kept a previous conversation; request not sent.', 502)
              : cohereError(part.status ?? 502, part.code);
            self.rememberError(error, part.retryAfter); throw error;
          }
          for (const chunk of part.chunks) yield chunk;
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseCohereStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Cohere web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Cohere web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
    }
  }
  private async closeAutomation(): Promise<void> {
    for (const controller of this.active) controller.abort();
    const context = this.context;
    // The close event may not race a later launch's profile reservation.
    this.context = null; this.page = null; this.initialization = undefined; this.catalog = []; this.authenticated = false;
    try { await context?.close(); }
    finally { const unlock = this.unlock; this.unlock = undefined; await unlock?.(); this.state = 'not_initialized'; }
  }
  async close(): Promise<void> {
    return this.loginMutex.withLock(async () => {
      await this.interactive?.close(); this.manualLogin = false; await this.closeAutomation();
    });
  }
}
