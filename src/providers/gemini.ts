import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { GEMINI_SELECTORS as S, installGeminiCopyCapture, readGeminiState, type GeminiDomState } from './gemini-browser.ts';
import { geminiAuthenticated, geminiError, geminiLimitNotice, geminiModels, geminiModelSlug, geminiPromptMatches, type GeminiAuthProbe, type GeminiModeOption } from './gemini-protocol.ts';

const ORIGIN = 'https://gemini.google.com';
const CHAT = ORIGIN + '/app';
const AUTO = 'gemini/auto';

/**
 * One Google account per worker. The website sends its own requests (WebChannel
 * with binary payloads for the observed anonymous flow), so the adapter operates
 * the composer and reads the finished answer through the site's "Copiar" button.
 */
export class GeminiProvider implements ProviderAdapter {
  readonly id = 'gemini' as const;
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
      await context.addInitScript(installGeminiCopyCapture);
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
    if (!this.page) throw new UpstreamError('Gemini browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(CHAT, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        // Google sign-in (password, 2FA, device checks) is completed by the person in this browser.
        this.interactive ??= new InteractiveBrowser(this.directory, CHAT);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async probe(): Promise<GeminiAuthProbe> {
    const page = this.page;
    if (!page || new URL(page.url()).origin !== ORIGIN) return { status: 401, offOrigin: true, token: false, signInLink: false, accountLink: false };
    return page.evaluate(async () => {
      const response = await fetch('/app', { credentials: 'include', cache: 'no-store', redirect: 'follow' });
      const html = response.ok ? await response.text() : '';
      return { status: response.status, offOrigin: new URL(response.url).origin !== location.origin,
        token: /"SNlM0e":"[^"]+"/.test(html), signInLink: /accounts\.google\.com\/ServiceLogin/.test(html),
        accountLink: /accounts\.google\.com\/SignOutOptions/.test(html) };
    }).catch(() => ({ status: 0, offOrigin: false, token: false, signInLink: false, accountLink: false }));
  }
  private async validate(): Promise<void> {
    const result = await this.probe();
    this.checkedAt = new Date().toISOString();
    if (result.status !== 200 && result.status !== 401) { this.state = 'unavailable'; throw geminiError(result.status); }
    this.authenticated = geminiAuthenticated(result);
    if (!this.authenticated) {
      this.state = 'login_required'; this.catalog = [];
      throw new UpstreamError('Gemini login is required; complete Google sign-in in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Gemini login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Gemini login is required. Conclua o acesso com a conta Google e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    // The probe downloads the /app HTML; keep periodic checks sparse.
    if (this.page && !this.guard.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 60_000)) {
      try { await this.validate(); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; }
    }
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Gemini atingido.' : null };
  }
  private async readModes(): Promise<GeminiModeOption[] | null> {
    const page = this.page!;
    const button = page.locator(S.modeButton).first();
    if (!await button.isVisible().catch(() => false)) return null;
    await button.click({ timeout: 5000 });
    try {
      const items = page.locator(S.modeItem);
      await items.first().waitFor({ state: 'visible', timeout: 5000 });
      return await items.evaluateAll(elements => elements.map(e => ({
        label: (e.querySelector('.label')?.textContent || e.textContent || '').replace(/\s+/g, ' ').trim(),
        disabled: e.getAttribute('aria-disabled') === 'true', checked: e.getAttribute('aria-checked') === 'true' })));
    } finally { await page.keyboard.press('Escape').catch(() => {}); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Gemini login is required.', 401);
    // Do not query auth or operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      const modes = await this.readModes();
      this.catalog = modes ? geminiModels(modes) : [];
      this.availableModels = [{ id: AUTO, contextLength: 0 }, ...this.catalog.map(({ id, contextLength }) => ({ id, contextLength }))];
      return this.availableModels;
    });
  }
  private async selectModel(model: string): Promise<void> {
    // gemini/auto keeps the mode currently selected on the site.
    if (model === AUTO) return;
    const page = this.page!;
    const slug = model.slice('gemini/'.length);
    const button = page.locator(S.modeButton).first();
    if (!await button.isVisible().catch(() => false)) throw new UpstreamError('Gemini model selection unavailable.', 400);
    await button.click({ timeout: 5000 });
    const items = page.locator(S.modeItem);
    await items.first().waitFor({ state: 'visible', timeout: 5000 });
    const count = await items.count();
    for (let index = 0; index < count; index++) {
      const item = items.nth(index);
      const option = await item.evaluate(e => ({ label: (e.querySelector('.label')?.textContent || e.textContent || '').replace(/\s+/g, ' ').trim(),
        disabled: e.getAttribute('aria-disabled') === 'true', checked: e.getAttribute('aria-checked') === 'true' }));
      if (geminiModelSlug(option.label) !== slug) continue;
      if (option.disabled) break;
      if (option.checked) { await page.keyboard.press('Escape'); return; }
      await item.click({ timeout: 5000 });
      return;
    }
    await page.keyboard.press('Escape').catch(() => {});
    throw new UpstreamError('Requested Gemini model is not selectable on this account.', 400);
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else if (error.status >= 500) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('gemini/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Gemini model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
      const stop = page.locator(S.stop).first();
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
      await page.evaluate(() => { delete (globalThis as any).__proxyGemini; }).catch(() => {});
    };
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try { await cancelCapture(); } finally { release?.(); }
    };
    controller.signal.addEventListener('abort', () => { if (setupDone) void cleanup(); else void cancelCapture(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      timer = setTimeout(() => controller.abort(new UpstreamError('Gemini generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted(); interaction = 'authentication'; await this.validate();
        interaction = 'opening chat'; await this.navigate();
        const editor = page!.locator(S.editor).first();
        interaction = 'waiting for editor';
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        if (new URL(page!.url()).pathname !== '/app') throw new UpstreamError('Gemini did not open a new conversation.', 502);
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(() => { (globalThis as any).__proxyGemini = { armed: false, copied: null }; });
        interaction = 'filling editor';
        await editor.click({ timeout: 10_000 });
        await editor.fill(prompt, { timeout: 30_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site moves to /app/<id> after submission. DOM state owns completion;
        // never wait for navigation on an already-dispatched message.
        await page!.locator(S.send).first().click({ timeout: 10_000, noWaitAfter: true });
        controller.signal.throwIfAborted();
      }));
      setupDone = true;
      controller.signal.throwIfAborted();
      const self = this;
      return (async function* () {
        try {
          const text = await self.awaitAnswer(page!, prompt, controller.signal);
          yield { type: 'content', text } as ProviderEvent;
          yield { type: 'finish' } as ProviderEvent;
        } catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Gemini web response unavailable; verify the browser before retrying.', 502);
        } finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Gemini web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
    }
  }
  /** Waits for the matching turn to finish, then copies its Markdown through the site's own button. */
  private async awaitAnswer(page: Page, prompt: string, signal: AbortSignal): Promise<string> {
    const startDeadline = Date.now() + 60_000;
    let started = false, settled = 0;
    let state: GeminiDomState;
    while (true) {
      signal.throwIfAborted();
      state = await page.evaluate(readGeminiState, S);
      if (new URL(state.url).origin !== ORIGIN) throw new UpstreamError('Gemini login is required.', 401);
      if (geminiLimitNotice(state.notice)) throw geminiError(429, 'usage_limit');
      if (!started) {
        if (state.responses > 0) {
          if (!geminiPromptMatches(state.userTurn, prompt))
            throw new UpstreamError('Gemini displayed a different conversation turn; verify the browser before retrying.', 502);
          started = true;
        } else if (Date.now() > startDeadline) throw new UpstreamError('Gemini did not start a response; verify the browser.', 502);
      }
      // Completion: no stop control, markdown no longer aria-busy and the turn's actions rendered.
      settled = started && !state.stop && !state.busy && state.copy ? settled + 1 : 0;
      if (settled >= 2) break;
      await delay(250, undefined, { signal });
    }
    await page.evaluate(() => { const capture = (globalThis as any).__proxyGemini; if (capture) { capture.armed = true; capture.copied = null; delete capture.error; } });
    await page.locator(S.response).last().locator(S.copy).last().click({ timeout: 5000 });
    const copyDeadline = Date.now() + 5000;
    while (Date.now() < copyDeadline) {
      signal.throwIfAborted();
      state = await page.evaluate(readGeminiState, S);
      if (state.copied !== null || state.copyError) break;
      await delay(100, undefined, { signal });
    }
    if (state.copied === null) throw new UpstreamError('Gemini answer could not be copied from the page.', 502);
    if (!state.copied.trim()) throw new UpstreamError('Gemini returned no final text.', 502);
    return state.copied;
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
