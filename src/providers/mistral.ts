import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { inspectMistralPage, installMistralCapture } from './mistral-browser.ts';
import { MISTRAL_MODES, mistralError, mistralModels, parseMistralStream } from './mistral-protocol.ts';

const ORIGIN = 'https://chat.mistral.ai';
const CHAT_URL = ORIGIN + '/chat';
// Observed (public HTML, 2026-11-06): a ProseMirror editor inside
// `[data-composer-editor]` within the composer form, placeholder "Ask anything".
const EDITOR = '[data-composer-editor] [contenteditable="true"]:visible, form [contenteditable="true"].ProseMirror:visible';
const COMPOSER_FORM = 'form:has([data-composer-editor]), form:has([contenteditable="true"].ProseMirror)';
const FORMS = COMPOSER_FORM.split(', ');
// Bundle (2026-11-06): the primary action is a `type="submit"` button labelled by
// `message_input.send_message_button` ("Send"; "Cannot send empty message" when empty),
// and a hidden `button[type=submit]` sits before the editor. Enter is the fallback.
const SEND = ['Send', 'Enviar'].flatMap(label => FORMS.map(form =>
  `${form} button[type="submit"][aria-label="${label}"]:not([disabled]):not([aria-disabled="true"]):visible`)).join(', ');
// Bundle: `message_input.stop_generation` ("Stop generation"), `type="button"`.
const STOP = 'button[aria-label="Stop generation"], button[aria-label="Parar geração"]';
const MODE_LABEL = /^\s*(Fast|Think|Thinking|Rápido|Pensar|Raciocínio)\s*$/i;
const SIGN_IN = 'button:text-is("Sign in"), button:text-is("Entrar")';

/** One account per worker. The website prepares and sends its own requests. */
export class MistralProvider implements ProviderAdapter {
  readonly id = 'mistral' as const;
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
      await context.addInitScript(installMistralCapture);
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
  private async navigate(): Promise<void> {
    if (!this.page) throw new UpstreamError('Mistral browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        // The human signs in from the chat (Sign in → auth.mistral.ai: e-mail/password, Google, Microsoft or Apple).
        this.interactive ??= new InteractiveBrowser(this.directory, CHAT_URL);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  /** Anonymous visitors can chat too, so a visible editor alone is not authentication. */
  private async validate(): Promise<{ terms: boolean; limit: string | null }> {
    const page = this.page;
    if (!page || new URL(page.url()).origin !== ORIGIN) {
      this.checkedAt = new Date().toISOString(); this.authenticated = false; this.state = 'login_required';
      throw new UpstreamError('Mistral login is required; complete login in the browser.', 401);
    }
    // Wait for hydration: either the composer or the visitor's Sign in control.
    await page.locator(`${EDITOR}, ${SIGN_IN}`).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const result = await page.evaluate(inspectMistralPage);
    this.checkedAt = new Date().toISOString();
    if (result.challenge) {
      this.state = 'unavailable';
      throw new UpstreamError('Mistral is showing a browser verification; open the login screen and complete it.', 503);
    }
    if (result.anonymous || result.signIn) {
      this.authenticated = false; this.state = 'login_required'; this.availableModels = [];
      throw new UpstreamError('Mistral login is required; complete login in the browser.', 401);
    }
    if (!result.composer) { this.state = 'unavailable'; throw new UpstreamError('Mistral chat did not load; verify the browser.', 502); }
    this.authenticated = true;
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
    return { terms: result.terms, limit: result.limit };
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Mistral login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Mistral login is required. Conclua o acesso ao chat e clique em Concluir login novamente.', 401);
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
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Mistral atingido.' : null };
  }
  /** Bundle: the mode trigger's aria-label and visible span are the current mode title (`fast`/`think`). */
  private modeButton() {
    const page = this.page!;
    return page.locator(FORMS.map(form => `${form} button`).join(', ')).filter({ hasText: MODE_LABEL })
      .or(page.locator(FORMS.flatMap(form => ['Fast', 'Think'].map(label => `${form} button[aria-label="${label}"]`)).join(', '))).first();
  }
  private async currentMode(): Promise<string> {
    const button = this.modeButton();
    return ((await button.getAttribute('aria-label', { timeout: 3000 }).catch(() => null)) || (await button.textContent({ timeout: 3000 }).catch(() => '')) || '').trim();
  }
  private menuItems() {
    const page = this.page!;
    return page.getByRole('menuitem').or(page.getByRole('menuitemradio')).or(page.getByRole('option'));
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    if (!this.page) return [];
    const button = this.modeButton();
    // Without the mode control nothing is advertised; there is no invented fallback.
    if (!await button.isVisible().catch(() => false)) return [];
    const current = await this.currentMode();
    await button.click({ timeout: 5000 });
    try {
      await this.menuItems().first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      return mistralModels(await this.menuItems().allTextContents(), current);
    } finally { await this.page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Mistral login is required.', 401);
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
    const mode = MISTRAL_MODES.find(m => m.id === model);
    if (!mode) throw new UpstreamError('Unknown Mistral model.', 400);
    const button = this.modeButton();
    if (!await button.isVisible().catch(() => false)) throw new UpstreamError('Mistral mode selection unavailable.', 400);
    if (mode.label.test(await this.currentMode())) return;
    await button.click({ timeout: 5000 });
    const option = this.menuItems().filter({ hasText: mode.label }).first();
    if (!await option.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
      await page.keyboard.press('Escape');
      throw new UpstreamError('Requested Mistral mode is not selectable on this account.', 400);
    }
    await option.click({ timeout: 5000 });
    await page.keyboard.press('Escape').catch(() => {});
    // A mode that the frontend did not apply must fail instead of silently switching.
    if (!mode.label.test(await this.currentMode()))
      throw new UpstreamError('Mistral did not apply the requested mode.', 400);
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) { this.state = 'suspended'; this.guard.block({ state: 'suspended', authenticated: this.authenticated }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else if (error.status !== 400) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('mistral/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Mistral model unavailable or login is required.', this.manualLogin ? 401 : 400);
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
        scope.__proxyMistral?.controller?.abort(); delete scope.__proxyMistral;
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
      timer = setTimeout(() => controller.abort(new UpstreamError('Mistral generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        // A fresh /chat load reflects the current session in the server-rendered payload.
        interaction = 'opening chat'; await this.navigate();
        interaction = 'authentication';
        const checked = await this.validate();
        if (checked.terms) throw new UpstreamError('Mistral login is required: accept the terms of service in the login screen.', 401);
        interaction = 'focusing editor';
        const editor = page!.locator(EDITOR).first();
        await editor.click({ timeout: 20_000 });
        // Reacquire after focus in case hydration replaced the node.
        interaction = 'waiting for editor';
        await page!.locator(EDITOR).first().waitFor({ state: 'visible', timeout: 30_000 });
        if (!/^\/chat\/?$/.test(new URL(page!.url()).pathname)) throw new UpstreamError('Mistral did not open a new conversation.', 502);
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt }) => {
          (globalThis as any).__proxyMistral = { prompt, chunks: [], bytes: 0, claimed: false, promptSeen: false, done: false };
        }, { prompt });
        interaction = 'filling editor'; await page!.locator(EDITOR).first().fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /chat/<id> after submission. Capture owns completion;
        // never time out (or resend) an already-dispatched message waiting for navigation.
        const send = page!.locator(SEND).first();
        if (await send.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false))
          await send.click({ timeout: 10_000, noWaitAfter: true });
        else await page!.locator(EDITOR).first().press('Enter', { timeout: 5_000, noWaitAfter: true });
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
            const c = (globalThis as any).__proxyMistral;
            if (!c) throw new Error('Mistral capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined,
              status: c.status as number | undefined, code: c.code as string | undefined, retryAfter: c.retryAfter as string | null };
          });
          if (!part.claimed && Date.now() > claimDeadline) {
            // The message may already be on the site: report, never resend automatically.
            const visible = await page!.evaluate(inspectMistralPage).catch(() => null);
            if (visible?.limit) throw mistralError(429, visible.limit === 'capacity' ? 'at_capacity' : 'quota');
            throw new UpstreamError('Mistral did not send a supported conversation request; verify the browser.', 502);
          }
          if (part.error) { const error = mistralError(part.status ?? 502, part.code); self.rememberError(error, part.retryAfter); throw error; }
          for (const chunk of part.chunks) yield chunk;
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseMistralStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Mistral web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Mistral web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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
