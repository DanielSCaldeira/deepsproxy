import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { inspectMetaPage, installMetaCapture, metaMessageIds, readMetaModeOptions, readMetaTurn } from './meta-browser.ts';
import { classifyMetaPage, metaError, metaEvents, metaModels, metaTurnProgress } from './meta-protocol.ts';

const ORIGIN = 'https://www.meta.ai';
// Selectors from the public frontend bundles (2026-11-06). The signed-in composer is a
// Lexical editor; the logged-out landing renders a plain input with the same purpose.
const EDITOR = '[data-testid="composer-input"]:visible';
const LANDING_INPUT = 'input[aria-label="Ask Meta AI"]:visible, input[aria-label="Pergunte à Meta AI"]:visible';
const SEND = '[data-testid="composer-send-button"]:visible, button[aria-label="Send"]:visible, button[aria-label="Enviar"]:visible';
const STOP = '[data-testid="composer-stop-button"]';
const MODE_BUTTON = '[data-testid="composer-mode-dropdown-button"]';
const COPY = 'button[aria-label="Copy response"], button[aria-label="Copiar resposta"]';

/** One account per worker. The website's own composer sends the message. */
export class MetaProvider implements ProviderAdapter {
  readonly id = 'meta' as const;
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
  private providerMessage: string | null = null;
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
      await context.addInitScript(installMetaCapture);
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
    if (!this.page) throw new UpstreamError('Meta AI browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        // The human signs in with Facebook, Instagram or a Meta account in a native
        // browser over the worker's VNC tunnel; automation never sees credentials.
        this.interactive ??= new InteractiveBrowser(this.directory, ORIGIN + '/');
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  /** Signed-in evidence from the page itself; anonymous visitors also get a composer. */
  private async validate(timeoutMs = 20_000): Promise<'authenticated' | 'rate_limited'> {
    const page = this.page;
    if (!page) throw metaError('login');
    let url: URL | null = null;
    try { url = new URL(page.url()); } catch { /* about:blank */ }
    if (!url || url.origin !== ORIGIN) await this.navigate();
    const deadline = Date.now() + timeoutMs;
    let result = null;
    while (true) {
      result = classifyMetaPage(await page.evaluate(inspectMetaPage));
      if (result || Date.now() >= deadline) break;
      await delay(250);
    }
    this.checkedAt = new Date().toISOString();
    if (!result) { this.state = 'unavailable'; throw new UpstreamError('Meta AI page did not show a signed-in or signed-out state.', 503); }
    if (result.state === 'unavailable') {
      this.state = 'unavailable'; this.providerMessage = result.message;
      throw metaError('region', result.message);
    }
    if (result.state === 'login_required') {
      this.authenticated = false; this.state = 'login_required'; this.catalog = [];
      throw metaError('login', result.message);
    }
    this.authenticated = true;
    if (result.state === 'rate_limited') { this.providerMessage = result.message; this.rememberError(metaError('limit', result.message)); return 'rate_limited'; }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
    return 'authenticated';
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Meta AI login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Meta AI login is required. Entre com Facebook, Instagram ou conta Meta, abra o chat e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    if (this.page && !this.guard.status().busy && this.pageMutex.queueDepth === 0 &&
        (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15000)) {
      try { await this.pageMutex.withLock(() => this.validate(5000)); }
      catch (error) {
        if (!(error instanceof UpstreamError) || error.status !== 401) this.state = 'unavailable';
      }
    }
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? this.providerMessage ?? 'Limite de uso do Meta AI atingido.' :
        this.state === 'unavailable' ? this.providerMessage : null };
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    const page = this.page;
    const automatic = { id: 'meta/auto', contextLength: 0 };
    if (!page) return [];
    const button = page.locator(MODE_BUTTON).first();
    if (!await button.isVisible().catch(() => false)) { this.catalog = []; return [automatic]; }
    await button.click({ timeout: 5000 });
    try {
      await page.locator('[data-testid^="composer-mode-option-"]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      this.catalog = metaModels(await page.evaluate(readMetaModeOptions));
    } finally { await page.keyboard.press('Escape'); }
    return [automatic, ...this.catalog.map(({ id, contextLength }) => ({ id, contextLength }))];
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Meta AI login is required.', 401);
    // Do not operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      this.availableModels = await this.selectableModels();
      return this.availableModels;
    });
  }
  /** `meta/auto` keeps the mode currently selected on the site. Explicit modes must be honoured. */
  private async selectMode(model: string): Promise<void> {
    if (model === 'meta/auto') return;
    const page = this.page!;
    const mode = model.slice('meta/'.length);
    if (!/^think_[a-z0-9_]{1,40}$/.test(mode)) throw new UpstreamError('Unknown Meta AI model.', 400);
    const button = page.locator(MODE_BUTTON).first();
    if (!await button.isVisible().catch(() => false)) throw new UpstreamError('Meta AI mode selection unavailable.', 400);
    const option = page.locator(`[data-testid="composer-mode-option-${mode}"]`).first();
    await button.click({ timeout: 5000 });
    if (!await option.isVisible().catch(() => false) || await option.getAttribute('data-disabled') !== null ||
        await option.getAttribute('aria-disabled') === 'true') {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Requested Meta AI mode is not selectable on this account.', 400);
    }
    if (await option.getAttribute('aria-checked') !== 'true') await option.click({ timeout: 5000 });
    if (await option.isVisible().catch(() => false)) await page.keyboard.press('Escape');
    // Reopen to confirm the frontend kept the selection; never send with another mode.
    await button.click({ timeout: 5000 });
    const checked = await option.getAttribute('aria-checked', { timeout: 5000 }).catch(() => null);
    await page.keyboard.press('Escape');
    if (checked !== 'true') throw new UpstreamError('Meta AI did not honor the requested mode.', 400);
  }
  private rememberError(error: unknown): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (error.status === 429) {
      this.state = 'rate_limited'; this.providerMessage = error.originalMessage ?? this.providerMessage;
      // The site gives no machine-readable deadline; wait a conservative interval.
      this.guard.defer(15 * 60_000, 'rate_limit');
    } else this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('meta/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Meta AI model unavailable or login is required.', this.manualLogin ? 401 : 400);
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let release: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let cleaned = false, setupDone = false, dispatched = false;
    let interaction = 'initialization';
    let before: string[] = [];
    const page = this.page;
    const stopResponse = async () => {
      if (!page || page.isClosed() || !dispatched) return;
      const stop = page.locator(STOP).first();
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
    };
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try {
        await page?.evaluate(() => { delete (globalThis as any).__proxyMeta; }).catch(() => {});
      } finally { release?.(); }
    };
    controller.signal.addEventListener('abort', () => { void stopResponse(); if (setupDone) void cleanup(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      timer = setTimeout(() => controller.abort(new UpstreamError('Meta AI generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        interaction = 'opening chat'; await this.navigate();
        interaction = 'authentication';
        if (await this.validate() === 'rate_limited') throw metaError('limit', this.providerMessage);
        before = await page!.evaluate(metaMessageIds);
        interaction = 'focusing editor';
        await page!.locator(`${EDITOR}, ${LANDING_INPUT}`).first().click({ timeout: 20_000 });
        // Reacquire the active editor after hydration; never fill a detached placeholder.
        const editor = await page!.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 5000 })
          .then(() => page!.locator(EDITOR).first(), () => page!.locator(LANDING_INPUT).first());
        interaction = 'selecting model'; await this.selectMode(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        interaction = 'filling editor'; await editor.fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        await page!.evaluate(() => { (globalThis as any).__proxyMeta = { copying: false, copied: null }; });
        interaction = 'clicking send';
        // A sent message must never be re-sent; completion is read from the conversation.
        dispatched = true;
        await page!.locator(SEND).first().click({ timeout: 10_000, noWaitAfter: true });
        controller.signal.throwIfAborted();
      }));
      setupDone = true;
      controller.signal.throwIfAborted();
      const self = this;
      const userDeadline = Date.now() + 30_000, answerDeadline = Date.now() + 90_000;
      return (async function* () {
        try {
          let text: string | null = null, assistantId: string | null = null;
          while (text === null) {
            controller.signal.throwIfAborted();
            const turn = await page!.evaluate(readMetaTurn, before);
            if (!turn.userFound && Date.now() > userDeadline) {
              const progress = metaTurnProgress(turn);
              if (progress.kind === 'error') throw progress.error;
              throw new UpstreamError('Meta AI did not show the sent message; verify the browser before retrying.', 502);
            }
            if (turn.userFound && !turn.assistantId && Date.now() > answerDeadline)
              throw new UpstreamError('Meta AI did not start a response; verify the browser before retrying.', 502);
            const progress = metaTurnProgress(turn);
            if (progress.kind === 'error') throw progress.error;
            if (progress.kind === 'done') { text = progress.text; assistantId = turn.assistantId; break; }
            await delay(250, undefined, { signal: controller.signal });
          }
          // The site's copy action yields the answer's source text (markdown, tool markers)
          // instead of the rendered DOM. Fall back to the rendered text if it is unavailable.
          const copied = await self.pageMutex.withLock(() => self.copyAnswer(page!, assistantId)).catch(() => null);
          yield* metaEvents(copied?.trim() ? copied : text);
        } catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Meta AI web response unavailable; verify the browser before retrying.', 502);
        } finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Meta AI web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
    }
  }
  private async copyAnswer(page: Page, assistantId: string | null): Promise<string | null> {
    if (!assistantId || !/^[\w:.-]{1,200}$/.test(assistantId)) return null;
    const row = page.locator(`[data-message-item][data-message-id="${assistantId}"]`).first();
    const copy = row.locator(COPY).first();
    await row.hover({ timeout: 2000 }).catch(() => {});
    if (!await copy.count()) return null;
    await page.evaluate(() => { const c = (globalThis as any).__proxyMeta; if (c) { c.copying = true; c.copied = null; } });
    try {
      await copy.click({ timeout: 3000 });
      for (let i = 0; i < 20; i++) {
        const copied = await page.evaluate(() => (globalThis as any).__proxyMeta?.copied as string | null);
        if (typeof copied === 'string') return copied;
        await delay(100);
      }
      return null;
    } finally { await page.evaluate(() => { const c = (globalThis as any).__proxyMeta; if (c) c.copying = false; }).catch(() => {}); }
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
