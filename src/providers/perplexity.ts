import type { BrowserContext, Locator, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installPerplexityCapture } from './perplexity-browser.ts';
import { parsePerplexityStream, perplexityError, perplexityModels, type PerplexityCatalogModel } from './perplexity-protocol.ts';

const ORIGIN = 'https://www.perplexity.ai';
// Public composer observed on 2026-11-06: a Lexical editor without ID whose
// aria-label changes after focus ("Ask anything…" → "Type @ for connectors").
const EDITOR = '#ask-input:visible, div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]:visible';
// Submit appears only after the editor has text; Portuguese labels are not yet observed.
const SEND = 'button[aria-label="Submit"]:visible, button[aria-label="Enviar"]:visible';
const STOP = 'button[aria-label^="Stop response"], button[aria-label^="Parar resposta"]';
const MODEL_BUTTON = 'button[aria-haspopup="menu"][aria-label="Model"], button[aria-haspopup="menu"][aria-label="Modelo"]';
const MENU_ITEMS = '[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]';
const AUTO_LABEL = /^(Best|Melhor)$/i;
// Observed 2026-11-07 (pt-BR): a non-modal role="dialog" fixed at the bottom
// ("Nós e nossos parceiros usamos cookies…", buttons "Recusar opcionais" and
// "Entendi") intercepts clicks on the model selector. Accepting closes it.
const COOKIE_BANNER = '[role="dialog"]:has-text("cookies")';
const COOKIE_ACCEPT = /^\s*(Entendi|Got it|Aceitar|Aceitar todos|Accept|Accept all)\s*$/i;

/** The selector hydrates after the editor; an instant check advertised only "auto". */
function modelButtonReady(button: Locator): Promise<boolean> {
  return button.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
}

// Observed 2026-11-07 (pt-BR, free plan): choosing a paid model opens a
// full-screen subscription offer ("/mês ou equivalente, na cobrança anual").
const UPSELL_TEXT = /na cobrança anual|billed annually/i;

/** Close the subscription offer without choosing a plan. */
export async function dismissPerplexityUpsell(page: Page): Promise<void> {
  const offer = page.getByText(UPSELL_TEXT).first();
  for (let attempt = 0; attempt < 3 && await offer.isVisible().catch(() => false); attempt++) {
    const close = page.locator('button[aria-label="Fechar"]:visible, button[aria-label="Close"]:visible').first();
    if (await close.isVisible().catch(() => false)) await close.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press('Escape');
    await offer.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  }
  if (await offer.isVisible().catch(() => false)) throw new UpstreamError('Perplexity subscription offer could not be closed; verify the browser.', 502);
}

/** Accept the cookie banner whenever it covers an element the adapter clicks. */
export async function installPerplexityCookieConsent(page: Page): Promise<void> {
  const banner = page.locator(COOKIE_BANNER).filter({ visible: true }).first();
  await page.addLocatorHandler(banner, async dialog => {
    const accept = dialog.locator('button, [role="button"], a').filter({ hasText: COOKIE_ACCEPT }).first();
    await accept.click({ timeout: 5000 });
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  }, { noWaitAfter: true });
  // A leftover subscription offer must not block every later click.
  await page.addLocatorHandler(page.getByText(UPSELL_TEXT).first(), async () => { await dismissPerplexityUpsell(page); }, { noWaitAfter: true });
}

/** One account per worker. The website prepares and sends its own requests. */
export class PerplexityProvider implements ProviderAdapter {
  readonly id = 'perplexity' as const;
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
  private catalog: PerplexityCatalogModel[] = [];
  private availableModels: ProviderModel[] = [];
  /** Menu labels that opened the subscription offer on this account. */
  private readonly paidOnly = new Set<string>();
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
      await context.addInitScript(installPerplexityCapture);
      context.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== ORIGIN || url.pathname !== '/rest/models/config/v2' || !response.ok()) return;
        void response.json().then(body => { if (this.context === context) this.catalog = perplexityModels(body); }).catch(() => {});
      });
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = null; this.page = null; this.initialization = undefined;
        this.authenticated = false; this.state = 'not_initialized'; this.catalog = [];
        for (const controller of this.active) controller.abort();
        const unlock = this.unlock; this.unlock = undefined; void unlock?.();
      });
      this.page = await createBrowserPage(context, { rejectCookies: false });
      await installPerplexityCookieConsent(this.page);
      await this.navigate();
    } catch (error) { await this.closeAutomation(); throw error; }
  }
  private async navigate(): Promise<void> {
    if (!this.page) throw new UpstreamError('Perplexity browser unavailable.', 503);
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
        this.interactive ??= new InteractiveBrowser(this.directory, ORIGIN + '/');
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async validate(): Promise<void> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Perplexity login is required.', 401);
    // NextAuth session endpoint used by the frontend. Guests receive {}.
    // Only a boolean leaves the browser; no token or identity reaches Node.
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include', cache: 'no-store' });
      const challenge = !!response.headers.get('cf-mitigated')?.includes('challenge');
      if (!response.ok || !response.headers.get('content-type')?.includes('json'))
        return { status: response.status, challenge: challenge || response.ok, authenticated: false };
      const body = await response.json().catch(() => null);
      const user = body?.user;
      // No named helpers here: page functions are serialized without bundler helpers.
      return { status: response.status, challenge: false, authenticated: !!user && typeof user === 'object' &&
        [user.id, user.email, user.username].some(value => typeof value === 'string' && value.length > 0) &&
        (!body.expires || Date.parse(body.expires) > Date.now()) };
    });
    this.checkedAt = new Date().toISOString();
    if (result.challenge || (result.status !== 200 && result.status !== 401)) {
      this.state = 'unavailable'; throw perplexityError(result.status, undefined, result.challenge);
    }
    this.authenticated = result.authenticated;
    if (!this.authenticated) {
      this.state = 'login_required'; this.catalog = [];
      throw new UpstreamError('Perplexity login is required; complete login in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Perplexity login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Perplexity login is required. Conclua o acesso ao Perplexity e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    if (this.page && !this.guard.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15000)) {
      try { await this.validate(); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; }
    }
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Perplexity atingido.' : null };
  }
  /** Menu items render the label on the first line and badges ("Max", "Novo") below it. */
  private async menuLabels(): Promise<Array<{ label: string; disabled: boolean }>> {
    const items = this.page!.locator(MENU_ITEMS);
    await items.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    return items.evaluateAll(nodes => nodes.map(node => ({
      label: ((node as HTMLElement).innerText || '').split('\n')[0].trim(),
      disabled: node.getAttribute('aria-disabled') === 'true' })));
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    if (!this.page) return [];
    const automatic = { id: 'perplexity/auto', contextLength: 0 };
    const button = this.page.locator(MODEL_BUTTON).first();
    if (!await modelButtonReady(button)) return [automatic];
    await button.click({ timeout: 5000 });
    try {
      const labels = (await this.menuLabels()).filter(item => !item.disabled && !this.paidOnly.has(item.label)).map(item => item.label);
      return [automatic, ...this.catalog.filter(m => labels.includes(m.label)).map(({ id, contextLength }) => ({ id, contextLength }))];
    } finally { await this.page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Perplexity login is required.', 401);
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
    const page = this.page!;
    const button = page.locator(MODEL_BUTTON).first();
    if (!await modelButtonReady(button)) {
      if (model !== 'perplexity/auto') throw new UpstreamError('Perplexity model selection unavailable.', 400);
      return;
    }
    const label = model === 'perplexity/auto' ? null : this.catalog.find(m => m.id === model)?.label;
    if (model !== 'perplexity/auto' && !label) throw new UpstreamError('Unknown Perplexity model.', 400);
    await button.click({ timeout: 5000 });
    const items = await this.menuLabels();
    // The site remembers the last choice; "auto" restores its default entry when listed.
    const index = items.findIndex(item => !item.disabled && (label ? item.label === label : AUTO_LABEL.test(item.label)));
    if (index < 0) {
      await page.keyboard.press('Escape');
      if (model === 'perplexity/auto') return;
      throw new UpstreamError('Requested Perplexity model is not selectable on this account.', 400);
    }
    await page.locator(MENU_ITEMS).nth(index).click({ timeout: 5000 });
    if (await page.locator('[role="menu"]').first().isVisible().catch(() => false)) await page.keyboard.press('Escape');
    // A paid model on this plan opens the subscription offer instead of switching.
    if (label && await page.getByText(UPSELL_TEXT).first().waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) {
      await dismissPerplexityUpsell(page);
      this.paidOnly.add(label);
      this.availableModels = this.availableModels.filter(m => m.id !== model);
      throw new UpstreamError('This Perplexity model requires a paid plan on this account.', 400);
    }
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else if (error.status !== 400) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('perplexity/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Perplexity model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
        scope.__proxyPerplexity?.controller?.abort(); delete scope.__proxyPerplexity;
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
      timer = setTimeout(() => controller.abort(new UpstreamError('Perplexity generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted(); interaction = 'authentication'; await this.validate();
        interaction = 'opening chat'; await this.navigate();
        interaction = 'waiting for editor';
        const editor = page!.locator(EDITOR).first();
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        if (new URL(page!.url()).pathname !== '/') throw new UpstreamError('Perplexity did not open a new thread.', 502);
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, model }) => {
          (globalThis as any).__proxyPerplexity = { prompt, model, chunks: [], bytes: 0, claimed: false, done: false };
        }, { prompt, model: model.slice('perplexity/'.length) });
        // Focus first: the editor's aria-label changes and the frontend re-renders it.
        interaction = 'focusing editor'; await editor.click({ timeout: 10_000 });
        interaction = 'filling editor'; await page!.locator(EDITOR).first().fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /search/<slug>; the capture owns completion.
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
            const c = (globalThis as any).__proxyPerplexity;
            if (!c) throw new Error('Perplexity capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined, challenge: !!c.challenge,
              status: c.status as number | undefined, code: c.code as string | undefined, retryAfter: c.retryAfter as string | null };
          });
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('Perplexity did not send a supported ask request; verify the browser.', 502);
          for (const chunk of part.chunks) yield chunk;
          if (part.error) {
            if (part.error === 'model_mismatch') {
              // Observed 2026-11-07 (free plan): the site keeps its default model for
              // paid choices. Stop advertising a model this account cannot use.
              const label = self.catalog.find(m => m.id === model)?.label;
              if (label) self.paidOnly.add(label);
              self.availableModels = self.availableModels.filter(m => m.id !== model);
            }
            const error = part.error === 'model_mismatch' ? new UpstreamError('Perplexity did not honor the requested model; it may require a paid plan on this account.', 400) :
              perplexityError(part.status ?? 502, part.code, part.challenge);
            self.rememberError(error, part.retryAfter); throw error;
          }
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parsePerplexityStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Perplexity web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Perplexity web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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
