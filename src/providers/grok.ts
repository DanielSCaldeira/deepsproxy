import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, chromium, configureBrowserUserAgent, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installGrokCapture } from './grok-browser.ts';
import { grokError, grokModes, parseGrokStream, type GrokMode } from './grok-protocol.ts';

const ORIGIN = 'https://grok.com';
// Observed 2026-11-06 (pt-BR, logged out): a TipTap/ProseMirror editor with
// role="combobox" inside form[data-composer], wrapped by data-testid="chat-input".
const EDITOR = 'form[data-composer] [data-testid="chat-input"] [contenteditable="true"]:visible, form[data-composer] [contenteditable="true"][role="combobox"]:visible';
const SEND = 'form[data-composer] button[data-testid="chat-submit"][type="submit"]:visible';
// Label from the public bundle ("stop-stream-button-label"); not observed during a real generation.
const STOP = 'button[aria-label="Parar a resposta do modelo"], button[aria-label="Stop model response"]';
const MODEL_BUTTON = '#model-select-trigger';
// Rendered after an anonymous submission; the request is never sent to the chat API.
const LOGGED_OUT = '[data-testid="anon-paywall-sign-up-card"], [data-testid="anon-paywall-error-card"]';
const LOCKED_OPTION = /Requer login|Requires login|Iniciar sessão|Sign in/i;
const AUTO = /^(Auto|Automático|Automatic)$/i;

/** One account per worker. The website prepares and sends its own requests. */
export class GrokProvider implements ProviderAdapter {
  readonly id = 'grok' as const;
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
  private catalog: GrokMode[] = [];
  private labels = new Map<string, string>();
  private availableModels: ProviderModel[] = [];
  private rateLimit: { remaining: number; waitSeconds: number; at: number } | null = null;
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
      // Cloudflare protects grok.com and accounts.x.ai; keep the stealth launcher used by Qwen.
      configureBrowserUserAgent();
      const context = await chromium.launchPersistentContext(this.directory, {
        channel: getBrowserChannel(), headless, locale: BROWSER_LOCALE,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--lang=pt-BR', '--disable-field-trial-config', '--password-store=basic', '--disable-dev-shm-usage',
          ...(worker ? ['--disable-quic', '--proxy-bypass-list=<-loopback>'] : [])],
        ...(worker ? { chromiumSandbox: true, acceptDownloads: false, proxy: { server: 'http://egress:3128', bypass: '<-loopback>' } } : {}),
      });
      this.context = context;
      if (restore) await this.session.restoreSession(context);
      await context.addInitScript(installGrokCapture);
      this.observe(context);
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
  /** Catalog and quota requests issued by the website itself; nothing is sent by the proxy. */
  private observe(context: BrowserContext): void {
    context.on('response', response => {
      let url: URL;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== ORIGIN || !response.ok()) return;
      if (/^\/rest\/modes\/?$/.test(url.pathname))
        void response.json().then(body => { if (this.context === context) this.catalog = grokModes(body); }).catch(() => {});
      else if (/^\/rest\/rate-limits\/?$/.test(url.pathname))
        void response.json().then(body => {
          if (this.context !== context || !Number.isFinite(body?.remainingQueries)) return;
          this.rateLimit = { remaining: body.remainingQueries, waitSeconds: Number(body.waitTimeSeconds) || 0, at: Date.now() };
        }).catch(() => {});
    });
  }
  private async navigate(): Promise<void> {
    if (!this.page) throw new UpstreamError('Grok browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
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
        // grok.com offers X, Google, Apple and e-mail sign-in through accounts.x.ai.
        this.interactive ??= new InteractiveBrowser(this.directory, ORIGIN + '/');
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async validate(): Promise<void> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Grok login is required.', 401);
    // The frontend's own session endpoint: { status: "authenticated", session } or
    // "unauthenticated" (verified anonymously). Only a status string leaves the browser.
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      let status: unknown = null, session = false;
      try { const body = await response.json(); status = body?.status; session = !!body?.session && typeof body.session === 'object'; } catch { /* challenge HTML */ }
      return { http: response.status, status: typeof status === 'string' ? status.slice(0, 40) : null, session };
    });
    this.checkedAt = new Date().toISOString();
    if (result.http !== 200 || !result.status) {
      this.state = 'unavailable';
      throw result.http === 401 ? grokError(401) : new UpstreamError(`Grok session check failed (HTTP ${result.http}).`, 503);
    }
    if (result.status === 'blocked' || result.status === 'user_deleted') {
      this.authenticated = false; this.state = 'suspended';
      this.guard.block({ state: 'suspended', authenticated: false });
      throw grokError(403, result.status);
    }
    this.authenticated = result.status === 'authenticated' && result.session;
    if (!this.authenticated) {
      this.state = 'login_required'; this.catalog = [];
      throw new UpstreamError('Grok login is required; complete login in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Grok login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Grok login is required. Conclua o acesso ao chat e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    if (this.page && !this.guard.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15000)) {
      try { await this.validate(); }
      catch (error) {
        if (this.state !== 'suspended') this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable';
      }
    }
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Grok atingido.' : null };
  }
  /** Menu items expose the mode title first, followed by an optional description or badge. */
  private async menuOptions(): Promise<Array<{ label: string; text: string; enabled: boolean }>> {
    const items = this.page!.getByRole('menuitemradio');
    await items.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    return items.evaluateAll(nodes => nodes.map(node => {
      const element = node as HTMLElement;
      const text = (element.innerText || element.textContent || '').trim();
      return { label: text.split('\n')[0].trim(), text,
        disabled: element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('data-disabled') };
    })).then(options => options.map(o => ({ label: o.label, text: o.text, enabled: !o.disabled && !LOCKED_OPTION.test(o.text) })));
  }
  private labelMatches(text: string, label: string): boolean {
    return text.trim().toLowerCase() === label.trim().toLowerCase();
  }
  /** Title and badge may render on one line ("AutoRequer login"): accept a capitalized boundary. */
  private optionMatches(option: { label: string; text: string }, label: string): boolean {
    if (this.labelMatches(option.label, label)) return true;
    const text = option.text.trim();
    return text.toLowerCase().startsWith(label.trim().toLowerCase()) && !/^[a-zà-ÿ0-9]/.test(text.slice(label.trim().length));
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    if (!this.page) return [];
    const button = this.page.locator(MODEL_BUTTON).first();
    if (!await button.isVisible()) { this.labels = new Map(); return [{ id: 'grok/auto', contextLength: 0 }]; }
    await button.click({ timeout: 5000 });
    try {
      const options = (await this.menuOptions()).filter(o => o.enabled && o.label);
      const labels = new Map<string, string>();
      if (this.catalog.length) {
        for (const mode of this.catalog) if (options.some(o => this.optionMatches(o, mode.label))) labels.set(mode.id, mode.label);
      } else {
        // Without an observed /rest/modes catalog, use the stable product names shown in the menu.
        for (const option of options) {
          const slug = option.label.toLowerCase().normalize('NFD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
          if (slug && /^[\w.-]{1,64}$/.test(slug)) labels.set(`grok/${slug}`, option.label);
        }
      }
      if (!labels.has('grok/auto') && options.some(o => AUTO.test(o.label))) labels.set('grok/auto', options.find(o => AUTO.test(o.label))!.label);
      this.labels = labels;
      return [...labels.keys()].sort((a, b) => a === 'grok/auto' ? -1 : b === 'grok/auto' ? 1 : 0).map(id => ({ id, contextLength: 0 }));
    } finally { await this.page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Grok login is required.', 401);
    // Do not query auth or operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      this.availableModels = await this.selectableModels();
      return this.availableModels;
    });
  }
  private async currentMode(): Promise<string> {
    const button = this.page!.locator(MODEL_BUTTON).first();
    const aria = await button.getAttribute('aria-label').catch(() => null);
    return (aria?.replace(/^(Modelo|Model)\s*:\s*/i, '') || await button.innerText().catch(() => '')).trim();
  }
  private async selectModel(model: string): Promise<void> {
    const page = this.page!;
    const button = page.locator(MODEL_BUTTON).first();
    if (!await button.isVisible()) {
      if (model !== 'grok/auto') throw new UpstreamError('Grok model selection unavailable.', 400);
      return;
    }
    const label = this.labels.get(model) ?? this.catalog.find(m => m.id === model)?.label;
    // Without an "Auto" option, grok/auto keeps the website's current default mode.
    if (!label && model === 'grok/auto') return;
    if (!label) throw new UpstreamError('Unknown Grok model.', 400);
    if (this.labelMatches(await this.currentMode(), label)) return;
    await button.click({ timeout: 5000 });
    const options = await this.menuOptions();
    const index = options.findIndex(o => this.optionMatches(o, label));
    if (index < 0 || !options[index].enabled) {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Requested Grok model is not selectable on this account.', 400);
    }
    await page.getByRole('menuitemradio').nth(index).click({ timeout: 5000 });
    // An upsell dialog leaves the previous mode selected; never send with another model.
    for (let i = 0; i < 30 && !this.labelMatches(await this.currentMode(), label); i++) await delay(100);
    if (!this.labelMatches(await this.currentMode(), label)) {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Grok did not select the requested model.', 400);
    }
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('grok/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Grok model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
        scope.__proxyGrok?.controller?.abort(); delete scope.__proxyGrok;
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
      // Expert/Heavy modes reason for minutes before answering.
      timer = setTimeout(() => controller.abort(new UpstreamError('Grok generation timed out.', 504)), 300_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted(); interaction = 'authentication'; await this.validate();
        interaction = 'opening chat'; await this.navigate();
        interaction = 'waiting for editor';
        const editor = page!.locator(EDITOR).first();
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        if (new URL(page!.url()).pathname !== '/') throw new UpstreamError('Grok did not open a new conversation.', 502);
        interaction = 'selecting model';
        if (!this.labels.has(model)) await this.selectableModels();
        await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, mode }) => {
          (globalThis as any).__proxyGrok = { prompt, mode, chunks: [], bytes: 0, claimed: false, done: false };
        }, { prompt, mode: model.slice('grok/'.length) });
        interaction = 'filling editor';
        await editor.click({ timeout: 10_000 });
        // Reacquire the active editor in case hydration replaced the focused node.
        await page!.locator(EDITOR).first().fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /c/... after submission. Capture owns completion;
        // do not time out an already-dispatched message waiting for navigation.
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
            const c = (globalThis as any).__proxyGrok;
            if (!c) throw new Error('Grok capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined,
              status: c.status as number | undefined, code: c.code as string | undefined, retryAfter: c.retryAfter as string | null };
          });
          if (!part.claimed) {
            // Anonymous submissions render a sign-up card instead of calling the chat API.
            if (await page!.locator(LOGGED_OUT).first().isVisible().catch(() => false)) {
              const error = grokError(401); self.rememberError(error); throw error;
            }
            const quota = self.rateLimit;
            if (quota && quota.remaining <= 0 && quota.waitSeconds > 0 && Date.now() - quota.at < 60_000) {
              const error = grokError(429); self.rememberError(error, String(quota.waitSeconds)); throw error;
            }
            if (Date.now() > claimDeadline)
              throw new UpstreamError('Grok did not send a supported conversation request; verify the browser.', 502);
          }
          if (part.error) {
            const error = part.error === 'model_mismatch' ? new UpstreamError('Grok did not honor the requested model.', 400) : grokError(part.status ?? 502, part.code);
            self.rememberError(error, part.retryAfter); throw error;
          }
          for (const chunk of part.chunks) yield chunk;
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseGrokStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Grok web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Grok web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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
