import type { BrowserContext, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installCopilotCapture } from './copilot-browser.ts';
import { COPILOT_MODES, CopilotError, isCopilotMode, parseCopilotEvents } from './copilot-protocol.ts';

export const COPILOT_ORIGIN = 'https://copilot.microsoft.com';
// `/` answers 301 to the copilot.com marketing page; `/chats/new` serves the chat app.
export const COPILOT_CHAT_URL = COPILOT_ORIGIN + '/chats/new';
// After sign-in a cookie redirects `/chats/new` to the same chat app at copilot.com/chat (2026-11-06).
const COPILOT_APP_ORIGINS = [COPILOT_ORIGIN, 'https://copilot.com', 'https://www.copilot.com'];
// Observed 2026-11-06: for a signed-in Microsoft account, copilot.microsoft.com showed a region block
// and Microsoft served the Microsoft 365 Copilot app at copilot.com/chat with the same session
// (redirect chain through login.microsoftonline.com and login.live.com). It is also the login entry:
// signed-in accounts land on the chat, others get the Microsoft sign-in (Microsoft, Google or Apple).
export const COPILOT_M365_URL = 'https://copilot.com/chat';
const COPILOT_M365_ORIGIN = 'https://copilot.com';
// Selectors from the public frontend bundle (data-testid rendered from `testId`).
export const COPILOT_SELECTORS = {
  editor: '[data-testid="composer-input"]:visible',
  send: '[data-testid="submit-button"]:visible',
  stop: '[data-testid="stop-button"]',
  modeMenu: '#composer-dropdown-button-menu-contents',
  anonymous: '[data-testid="anonymous-block-page-title"], [data-testid="sign-in-exp-chat-header-button"], [data-testid="sign-in-exp-landing-header-button"]',
  regionBlock: '[data-testid="region-block-title"]',
  // Microsoft 365 Copilot app (copilot.com/chat): contenteditable span, rendered only when signed in.
  m365Editor: '#m365-chat-editor-target-element[role="textbox"]',
  // E-mail field of the Microsoft sign-in page (login.live.com and login.microsoftonline.com).
  microsoftSignIn: 'input[name="loginfmt"]',
} as const;
const modeButton = (mode: string) => `[data-testid="composer-chat-mode-${mode}-button"]`;
const MODE_TRIGGER = `button:is(${COPILOT_MODES.map(modeButton).join(',')}):not([role="menuitem"])`;

export type CopilotPageProbe = { origin: string; anonymous: boolean; composer: boolean; userStatus: number | null; tier: string | null; m365?: boolean };
/** Login evidence from the site itself: the anonymous block page, the composer and the
 * account tier the frontend received from `GET /c/api/user` (`guest` when anonymous).
 * The Microsoft 365 Copilot app renders its editor only for a signed-in account. */
export function copilotLoginState(probe: CopilotPageProbe): 'authenticated' | 'login_required' | 'pending' {
  if (probe.m365 && probe.origin === COPILOT_M365_ORIGIN) return 'authenticated';
  if (!COPILOT_APP_ORIGINS.includes(probe.origin) || probe.anonymous) return 'login_required';
  // copilot.com also serves the marketing page; only its chat app (with the composer) counts.
  if (probe.origin !== COPILOT_ORIGIN && !probe.composer) return 'login_required';
  if (probe.userStatus === 401 || probe.userStatus === 403 || probe.tier === 'guest') return 'login_required';
  if (probe.composer && probe.tier) return 'authenticated';
  return 'pending';
}

/** One account per worker. The website prepares and sends its own WebSocket frames. */
export class CopilotProvider implements ProviderAdapter {
  readonly id = 'copilot' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private m365App = false;
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
      await context.addInitScript(installCopilotCapture);
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
    if (!this.page) throw new UpstreamError('Copilot browser unavailable.', 503);
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(COPILOT_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for the consumer app to show what it is serving this account.
    const page = this.page;
    const consumer = [COPILOT_SELECTORS.editor.replace(':visible', ''), COPILOT_SELECTORS.anonymous, COPILOT_SELECTORS.regionBlock].join(', ');
    await page.locator(consumer).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    const visible = (selector: string) => page.locator(selector).first().isVisible().catch(() => false);
    // In the headful worker the consumer app first rendered its sign-in header and only then the
    // region block for the signed-in account (2026-11-06), so anything but its signed-in chat is
    // checked against the Microsoft 365 app, where this login happens.
    const consumerChat = new URL(page.url()).origin === COPILOT_ORIGIN && await visible(COPILOT_SELECTORS.editor)
      && !await visible(COPILOT_SELECTORS.anonymous) && !await visible(COPILOT_SELECTORS.regionBlock);
    if (!consumerChat) await this.openM365();
  }
  /** Microsoft 365 Copilot app: the Microsoft account session passes through the Microsoft sign-in redirects. */
  private async openM365(): Promise<void> {
    const page = this.page!;
    await page.goto(COPILOT_M365_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Signed in, the redirect chain (login.microsoftonline.com, login.live.com) returns to copilot.com/chat
    // and renders the editor; signed out, it stops at the Microsoft sign-in form.
    await page.locator(`${COPILOT_SELECTORS.m365Editor}, ${COPILOT_SELECTORS.microsoftSignIn}`).first()
      .waitFor({ state: 'visible', timeout: 45_000 }).catch(() => {});
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
        this.interactive ??= new InteractiveBrowser(this.directory, COPILOT_M365_URL);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private async probe(): Promise<CopilotPageProbe> {
    // No named helpers inside serialized browser code: tsx (keepNames) would inject `__name`.
    return this.page!.evaluate(({ anonymous, editor, m365Editor }) => {
      const user = (globalThis as any).__proxyCopilotUser;
      return { origin: location.origin,
        anonymous: Array.from(document.querySelectorAll(anonymous)).some(e => e.getClientRects().length > 0),
        composer: Array.from(document.querySelectorAll(editor.replace(':visible', ''))).some(e => e.getClientRects().length > 0),
        userStatus: typeof user?.status === 'number' ? user.status : null, tier: typeof user?.tier === 'string' ? user.tier : null,
        m365: Array.from(document.querySelectorAll(m365Editor)).some(e => e.getClientRects().length > 0) };
    }, { anonymous: COPILOT_SELECTORS.anonymous, editor: COPILOT_SELECTORS.editor, m365Editor: COPILOT_SELECTORS.m365Editor });
  }
  /** `waitMs` 0 inspects the current page once (status polling); otherwise waits for hydration. */
  private async validate(waitMs = 30_000): Promise<void> {
    if (!this.page) throw new UpstreamError('Copilot login is required.', 401);
    const deadline = Date.now() + waitMs;
    let result: ReturnType<typeof copilotLoginState>, probe: CopilotPageProbe;
    let composerSince = 0;
    while (true) {
      // A navigation may destroy the execution context mid-probe; keep waiting.
      probe = await this.probe().catch(() => ({ origin: COPILOT_ORIGIN, anonymous: false, composer: false, userStatus: null, tier: null }));
      result = copilotLoginState(probe);
      if (result !== 'pending' || Date.now() >= deadline) break;
      // The account tier normally arrives with the app; do not hold every request 30 s for it.
      composerSince = probe.composer ? composerSince || Date.now() : 0;
      if (composerSince && Date.now() - composerSince > 8000) break;
      await delay(500);
    }
    this.checkedAt = new Date().toISOString();
    this.m365App = result === 'authenticated' && probe.m365 === true;
    if (result === 'pending') {
      // A composer without an anonymous block but no observed tier: the frontend did
      // not query the account. Keep the last known state for a single status probe.
      if (waitMs === 0 && this.authenticated) return;
      if (!probe.composer) { this.state = 'unavailable'; throw new UpstreamError('Copilot page did not finish loading; verify the browser.', 503); }
      result = 'authenticated';
    }
    this.authenticated = result === 'authenticated';
    if (!this.authenticated) {
      this.state = 'login_required';
      throw new UpstreamError('Copilot login is required; sign in with a Microsoft account in the browser.', 401);
    }
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Copilot login is required. Clique em Concluir login.', 401);
    await this.navigate();
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
        throw new UpstreamError('Copilot login is required. Entre com a conta Microsoft, aguarde o chat abrir e clique em Concluir login novamente.', 401);
      } finally { this.transitioning = false; }
    });
  }
  async status(): Promise<ProviderStatus> {
    if (this.manualLogin || this.transitioning) return { state: 'login_required', authenticated: false,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt, confirmationRequired: true };
    if (this.page && !this.guard.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15000)) {
      try { await this.validate(0); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; }
    }
    return { ...this.guard.status(), state: this.guard.status().block?.state ?? this.state, authenticated: this.authenticated,
      sessionSaved: await this.session.hasSavedSession(), checkedAt: this.checkedAt,
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Copilot atingido.' : null };
  }
  /** Mode menu items actually rendered for this account. `auto` keeps the site's default. */
  private async selectableModels(): Promise<ProviderModel[]> {
    const page = this.page!;
    const automatic = { id: 'copilot/auto', contextLength: 0 };
    const trigger = page.locator(MODE_TRIGGER).first();
    if (!await trigger.isVisible().catch(() => false)) return [automatic];
    // A sticky non-default mode renders a reset button instead of the menu trigger.
    if (await trigger.getAttribute('aria-haspopup') !== 'menu') await trigger.click({ timeout: 5000 });
    if (await trigger.getAttribute('aria-haspopup') !== 'menu') return [automatic];
    await trigger.click({ timeout: 5000 });
    try {
      const menu = page.locator(COPILOT_SELECTORS.modeMenu);
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const found: ProviderModel[] = [];
      for (const mode of COPILOT_MODES)
        if (await menu.locator(`[role="menuitem"]${modeButton(mode)}`).isVisible().catch(() => false)) found.push({ id: `copilot/${mode}`, contextLength: 0 });
      return [automatic, ...found];
    } finally { await page.keyboard.press('Escape'); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Copilot login is required.', 401);
    // Do not operate menus while a generation owns the page.
    if (this.guard.status().busy) return this.availableModels;
    return this.pageMutex.withLock(async () => {
      if (this.guard.status().busy) return this.availableModels;
      await this.validate();
      this.availableModels = await this.selectableModels();
      return this.availableModels;
    });
  }
  /** The trigger shows the current mode. A non-default selection turns it into a reset
   * button (no aria-haspopup); reset first, then open the menu and pick the mode. */
  private async selectMode(mode: string): Promise<void> {
    const page = this.page!;
    const trigger = () => page.locator(MODE_TRIGGER).first();
    if (mode === 'auto') {
      // `auto` is the site's default mode: undo a sticky selection from an earlier request.
      const current = trigger();
      if (await current.isVisible().catch(() => false) && await current.getAttribute('aria-haspopup') !== 'menu') await current.click({ timeout: 5000 });
      return;
    }
    if (!isCopilotMode(mode)) throw new UpstreamError('Unknown Copilot model.', 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = trigger();
      if (!await current.isVisible().catch(() => false)) break;
      if (await current.getAttribute('data-testid') === `composer-chat-mode-${mode}-button`) return;
      if (await current.getAttribute('aria-haspopup') !== 'menu') { await current.click({ timeout: 5000 }); continue; }
      await current.click({ timeout: 5000 });
      const option = page.locator(`${COPILOT_SELECTORS.modeMenu} [role="menuitem"]${modeButton(mode)}`);
      if (!await option.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
        await page.keyboard.press('Escape'); break;
      }
      await option.click({ timeout: 5000 }); return;
    }
    throw new UpstreamError('Requested Copilot model is not selectable on this account.', 400);
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (/account is suspended/.test(error.message)) {
      this.state = 'suspended';
      this.guard.block({ state: 'suspended', authenticated: this.authenticated, suspendedUntil: error instanceof CopilotError ? error.until : null });
    }
    else if (error.status === 429) {
      this.state = 'rate_limited';
      this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? (error instanceof CopilotError ? error.retryAfter : null))), 'rate_limit');
    }
    else if (error.status >= 500) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!model.startsWith('copilot/') || this.manualLogin || this.transitioning)
      throw new UpstreamError('Copilot model unavailable or login is required.', this.manualLogin ? 401 : 400);
    const mode = model.slice('copilot/'.length);
    if (mode !== 'auto' && !isCopilotMode(mode)) throw new UpstreamError('Unknown Copilot model.', 400);
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
      const stop = page.locator(COPILOT_SELECTORS.stop).first();
      if (await stop.isVisible().catch(() => false)) await stop.click({ timeout: 2000 }).catch(() => {});
      await page.evaluate(() => { delete (globalThis as any).__proxyCopilot; }).catch(() => {});
    };
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try { await cancelCapture(); } finally { release?.(); }
    };
    controller.signal.addEventListener('abort', () => { if (setupDone) void cleanup(); else void cancelCapture(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      timer = setTimeout(() => controller.abort(new UpstreamError('Copilot generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted();
        interaction = 'opening chat'; await this.navigate();
        interaction = 'authentication'; await this.validate();
        // Sending through the Microsoft 365 Copilot app (SignalR Chathub on substrate.office.com) is not built yet.
        if (this.m365App) throw new UpstreamError('Copilot: o envio pelo app Microsoft 365 Copilot (copilot.com) ainda não está disponível no proxy.', 503);
        const editor = page!.locator(COPILOT_SELECTORS.editor).first();
        interaction = 'waiting for editor';
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        interaction = 'selecting model'; await this.selectMode(mode); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, mode }) => {
          (globalThis as any).__proxyCopilot = { prompt, mode, chunks: [], messages: [], bytes: 0, claimed: false, done: false };
        }, { prompt, mode });
        interaction = 'filling editor';
        await editor.click({ timeout: 10_000 });
        await editor.fill(prompt, { timeout: 10_000 });
        // The composer enforces a character limit; never send a silently truncated prompt.
        if ((await editor.inputValue()).length < prompt.length)
          throw new UpstreamError('Prompt exceeds the Copilot composer limit; reduce the context.', 413);
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /chats/<id> after submission; the capture owns completion.
        await page!.locator(COPILOT_SELECTORS.send).first().click({ timeout: 10_000, noWaitAfter: true });
        controller.signal.throwIfAborted();
      }));
      setupDone = true;
      controller.signal.throwIfAborted();
      const self = this;
      const claimDeadline = Date.now() + 30_000;
      const frames = (async function* () {
        while (true) {
          controller.signal.throwIfAborted();
          const part = await page!.evaluate(() => {
            const c = (globalThis as any).__proxyCopilot;
            if (!c) throw new Error('Copilot capture unavailable.');
            const chunks: string[] = c.chunks.splice(0); c.bytes = 0;
            return { chunks, claimed: !!c.claimed, done: !!c.done, error: c.error as string | undefined };
          });
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('Copilot did not send the message over its chat socket; verify the browser.', 502);
          // Service events (errors, limits, completion) are decoded first.
          for (const chunk of part.chunks) yield chunk;
          if (part.error === 'mode_mismatch') throw new UpstreamError('Copilot did not honor the requested model.', 400);
          if (part.error) throw new UpstreamError(`Copilot web stream interrupted (${part.error}); verify the browser before retrying.`, 502);
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseCopilotEvents(frames, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Copilot web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Copilot web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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

