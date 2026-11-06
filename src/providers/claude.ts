import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, chromium, configureBrowserUserAgent, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installClaudeCapture } from './claude-browser.ts';
import { claudeAuthState, claudeError, claudeModels, parseClaudeStream, type ClaudeAuthProbe } from './claude-protocol.ts';

const ORIGIN = 'https://claude.ai';
// data-testid values and English labels read from the public frontend bundles
// (2026-11-06). The authenticated composer itself was not observed.
const EDITOR = '[data-testid="chat-input"]:visible, fieldset [contenteditable="true"][role="textbox"]:visible';
const SEND = '[data-testid="chat-input-send"]:visible, button[aria-label="Send message"]:visible, button[aria-label="Enviar mensagem"]:visible';
const STOP = '[data-testid="chat-input-stop"], button[aria-label="Stop response"], button[aria-label="Interromper resposta"]';
const MODEL_BUTTON = '[data-testid="model-selector-dropdown"]';
const MODEL_OPTION = '[data-testid="model-selector-option"]';
const CHALLENGE_TITLE = /^(Um momento|Just a moment|Attention Required)/i;

/** One account per worker. The website prepares and sends its own requests. */
export class ClaudeProvider implements ProviderAdapter {
  readonly id = 'claude' as const;
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
      // Cloudflare fronts claude.ai: use the same stealth launcher as Qwen/DeepSeek.
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
      await context.addInitScript(installClaudeCapture);
      context.on('response', response => {
        const url = new URL(response.url());
        if (url.origin !== ORIGIN || !/^\/(edge-)?api\/bootstrap(\/|$)/.test(url.pathname) || !response.ok()) return;
        void response.json().then(body => {
          const models = claudeModels(body);
          if (this.context === context && models.length) this.catalog = models;
        }).catch(() => {});
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
    if (!this.page) throw new UpstreamError('Claude browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(ORIGIN + '/new', { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        // E-mail code, Google and SSO are all offered on /login; the person chooses.
        this.interactive ??= new InteractiveBrowser(this.directory, ORIGIN + '/login');
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async validate(): Promise<void> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Claude login is required.', 401);
    // Observed logged out: 403 JSON {error:{type:'permission_error',details:{error_code:'account_session_invalid'}}}.
    // Only a count crosses into Node; no organization ID or identity is returned.
    const probe: ClaudeAuthProbe = await this.page.evaluate(async () => {
      const response = await fetch('/api/organizations', { credentials: 'include', cache: 'no-store' });
      const json = (response.headers.get('content-type') ?? '').includes('application/json');
      let body: any = null;
      if (json) body = await response.json().catch(() => null);
      const error = body?.error ?? {};
      return { status: response.status, json: json && body !== null,
        organizations: Array.isArray(body) ? body.filter((o: any) => typeof o?.uuid === 'string' && o.uuid).length : 0,
        code: typeof error.details?.error_code === 'string' ? error.details.error_code : undefined,
        type: typeof error.type === 'string' ? error.type : undefined };
    });
    this.checkedAt = new Date().toISOString();
    const state = claudeAuthState(probe);
    if (state === 'unavailable') {
      this.state = 'unavailable';
      if (CHALLENGE_TITLE.test(await this.page.title().catch(() => '')))
        throw new UpstreamError('Claude anti-bot verification is pending; open the login screen and complete it.', 503);
      throw claudeError(probe.status, probe.code, probe.type);
    }
    this.authenticated = state === 'authenticated';
    if (!this.authenticated) {
      this.state = 'login_required'; this.catalog = [];
      throw new UpstreamError('Claude login is required; complete login in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Claude login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Claude login is required. Conclua o acesso ao chat e clique em Concluir login novamente.', 401);
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
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Claude atingido.' : null };
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    const automatic = { id: 'claude/auto', contextLength: 0 };
    if (!this.page) return [];
    const button = this.page.locator(MODEL_BUTTON).first();
    if (!this.catalog.length || !await button.isVisible()) return [automatic];
    await button.click({ timeout: 5000 });
    try {
      const labels = (await this.page.locator(MODEL_OPTION).allTextContents()).map(text => text.trim());
      // Option text is the model name followed by its description.
      return [automatic, ...this.catalog.filter(m => labels.some(text => text.startsWith(m.label)))];
    } finally { await this.page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Claude login is required.', 401);
    // Do not query auth or operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      this.availableModels = await this.selectableModels();
      return this.availableModels;
    });
  }
  /** `claude/auto` keeps the site's current/default selection; explicit IDs are enforced by the capture. */
  private async selectModel(model: string): Promise<void> {
    if (model === 'claude/auto') return;
    const page = this.page!;
    const label = this.catalog.find(m => m.id === model)?.label;
    if (!label) throw new UpstreamError('Unknown Claude model.', 400);
    const button = page.locator(MODEL_BUTTON).first();
    if (!await button.isVisible()) throw new UpstreamError('Claude model selection unavailable.', 400);
    await button.click({ timeout: 5000 });
    const option = page.locator(MODEL_OPTION).filter({ hasText: label }).first();
    if (!await option.isVisible() || !(await option.innerText()).trim().startsWith(label)) {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Requested Claude model is not selectable on this account.', 400);
    }
    await option.click({ timeout: 5000 });
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('claude/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Claude model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
        scope.__proxyClaude?.controller?.abort(); delete scope.__proxyClaude;
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
      timer = setTimeout(() => controller.abort(new UpstreamError('Claude generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted(); interaction = 'authentication'; await this.validate();
        interaction = 'opening chat'; await this.navigate();
        const editor = page!.locator(EDITOR).first();
        interaction = 'waiting for editor';
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        if (!/^\/new\/?$/.test(new URL(page!.url()).pathname)) throw new UpstreamError('Claude did not open a new conversation.', 502);
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, model }) => {
          (globalThis as any).__proxyClaude = { prompt, model, chunks: [], bytes: 0, claimed: false, done: false };
        }, { prompt, model: model.slice('claude/'.length) });
        interaction = 'focusing editor'; await editor.click({ timeout: 10_000 });
        interaction = 'filling editor'; await editor.fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /chat/<uuid> after submission. Capture owns completion;
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
            const c = (globalThis as any).__proxyClaude;
            if (!c) throw new Error('Claude capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined,
              status: c.status as number | undefined, code: c.code as string | undefined, type: c.errorType as string | undefined,
              retryAfter: c.retryAfter as string | null, resetsAt: c.resetsAt as number | undefined };
          });
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('Claude did not send a supported completion request; verify the browser.', 502);
          if (part.error) {
            const error = part.error === 'model_mismatch' ? new UpstreamError('Claude did not honor the requested model.', 400) :
              claudeError(part.status ?? 502, part.code, part.type);
            const retryAfter = part.retryAfter ?? (part.resetsAt ? String(Math.ceil(part.resetsAt - Date.now() / 1000)) : null);
            self.rememberError(error, retryAfter); throw error;
          }
          for (const chunk of part.chunks) yield chunk;
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseClaudeStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Claude web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Claude web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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
