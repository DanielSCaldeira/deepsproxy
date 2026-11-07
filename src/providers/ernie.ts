import type { BrowserContext, Locator, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { BROWSER_LOCALE, nativeChromium, createBrowserPage, getBrowserChannel } from '../services/browser.ts';
import { createSessionStore, getProfileDirectory } from '../services/session-store.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { Mutex } from '../utils/mutex.ts';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { installErnieCapture } from './ernie-browser.ts';
import { ERNIE_DEFAULT_MODEL, ERNIE_INPUT_LIMIT, ernieError, ernieModels, parseErnieStream } from './ernie-protocol.ts';

// yiyan.baidu.com redirects (302) to this assistant; ernie.baidu.com is the model's product site.
const ORIGIN = 'https://wenxin.baidu.com';
// Observed 2026-11-06. The composer has no aria-labels; its IDs and test IDs are the stable hooks.
const EDITOR = '#chat-textarea:visible, #ci-main textarea.ci-textarea:visible';
const SEND = '#ci-main .ci-submit-button:has(#ci-submit-button-ai):visible';
const STOP = '#ci-main .ci-submit-button:has(img.ci-submit-pause)';
const MODE_BUTTON = '[data-testid="chat-mode-selector"]';
const CHAT_MODE = '[role="menuitemradio"][data-chat-mode="fast"]';
const MODEL_ROW = '[data-testid="chat-mode-model-row"]';
const MODEL_MENU = '[role="menu"][aria-label="选择模型"], .ci-input-mode-cascade-panel';
const MODEL_ITEM = '[role="menuitemradio"][data-model-name]';
const CAPTCHA_HOST = /^(wappass|passport)\.baidu\.com$/;
// The remote login opens Baidu passport directly (QR code, username or SMS); `u` returns to the chat.
export const ERNIE_LOGIN_URL = 'https://passport.baidu.com/v2/?login&u=' + encodeURIComponent('https://wenxin.baidu.com/');

/** One account per worker. The website prepares and sends its own requests. */
export class ErnieProvider implements ProviderAdapter {
  readonly id = 'ernie' as const;
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
  private notice: string | null = null;
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
      await context.addInitScript(installErnieCapture);
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
    if (!this.page) throw new UpstreamError('Ernie browser unavailable.', 503);
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
        // Baidu passport handles QR/username/SMS/captcha and then redirects to the chat page.
        this.interactive ??= new InteractiveBrowser(this.directory, ERNIE_LOGIN_URL);
        await this.interactive.start(); this.manualLogin = true;
      } finally { this.transitioning = false; }
    });
  }
  private securityCheck(): void {
    if (this.page && CAPTCHA_HOST.test(new URL(this.page.url()).hostname)) {
      this.state = 'unavailable'; this.notice = 'Verificação de segurança do Baidu (百度安全验证) pendente.';
      throw ernieError(503, 'security_verification');
    }
  }
  private async validate(): Promise<void> {
    if (!this.page) throw new UpstreamError('Ernie login is required.', 401);
    this.securityCheck();
    if (new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Ernie login is required.', 401);
    // The server-rendered page states whether the Baidu session is signed in.
    // Only the boolean leaves the browser; no token or identity crosses into Node.
    const result = await this.page.evaluate(async () => {
      const response = await fetch('/', { credentials: 'include', cache: 'no-store' });
      const html = response.ok ? await response.text() : '';
      const match = /<script[^>]*name=["']aiTabFrameBaseData["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
      let login: boolean | null = null;
      try { const flag = match ? JSON.parse(match[1])?.userInfo?.isUserLogin : undefined;
        login = flag === undefined || flag === null ? null : flag === true || Number(flag) === 1; } catch { login = null; }
      return { status: response.status, captcha: /^(wappass|passport)\.baidu\.com$/.test(new URL(response.url).hostname), login };
    });
    this.checkedAt = new Date().toISOString();
    if (result.captcha) { this.state = 'unavailable'; throw ernieError(503, 'security_verification'); }
    if (result.status !== 200 || result.login === null) { this.state = 'unavailable'; throw ernieError(result.status === 200 ? 502 : result.status); }
    // The chat also works as a visitor (`isUserLogin: 0`): signing in only syncs
    // history. A Baidu login is optional, so a visitor session is usable.
    this.authenticated = result.login;
    // A login_required block from older versions is stale once the chat is reachable.
    if (this.guard.status().block?.state === 'login_required') this.guard.confirmInteractiveLogin();
    this.notice = null;
    this.state = (this.guard.status().block?.state === 'suspended' ? 'suspended' : undefined) ??
      (this.guard.status().rateLimitUntil ? 'rate_limited' : 'authenticated');
  }
  async confirmLogin(interactive = false): Promise<void> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Ernie login is required. Clique em Concluir login.', 401);
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
        throw new UpstreamError('Ernie login is required. Conclua o acesso ao chat e clique em Concluir login novamente.', 401);
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
      originalMessage: this.state === 'rate_limited' ? 'Limite de uso do Ernie atingido.' : this.notice };
  }
  /** Opens the composer's mode panel and its model cascade; caller closes it. */
  private async openModelMenu(page: Page): Promise<boolean> {
    const button = page.locator(MODE_BUTTON).first();
    if (!await button.isVisible().catch(() => false)) return false;
    await button.click({ timeout: 5000 });
    const chat = page.locator(CHAT_MODE).first();
    // Only the "对话" (chat) mode is supported; "工作任务" starts long-running agent tasks.
    if (await chat.isVisible().catch(() => false) && await chat.getAttribute('aria-checked') !== 'true') {
      await chat.click({ timeout: 5000 });
      if (!await page.locator(MODEL_ROW).first().isVisible().catch(() => false)) await button.click({ timeout: 5000 });
    }
    const menu = page.locator(MODEL_MENU).first();
    const shown = (locator: Locator, timeout: number) => locator.waitFor({ state: 'visible', timeout }).then(() => true, () => false);
    // Observed 2026-11-07: the mode panel animates in and re-renders the model row,
    // so a click can hit a detached or moving element. Retry with a fresh locator.
    for (let attempt = 0; attempt < 3 && !await shown(menu, attempt ? 1500 : 300); attempt++) {
      const row = page.locator(MODEL_ROW).first();
      if (!await shown(row, 3000)) return false;
      await row.click({ timeout: 3000 }).catch(() => {});
    }
    return shown(menu, 1500);
  }
  private async selectableModels(): Promise<ProviderModel[]> {
    const page = this.page;
    const automatic = { id: `ernie/${ERNIE_DEFAULT_MODEL}`, label: '自动', contextLength: 0 };
    if (!page) return [];
    try {
      if (!await this.openModelMenu(page)) { this.catalog = [automatic]; return [{ id: automatic.id, contextLength: 0 }]; }
      const items = await page.locator(MODEL_MENU).first().locator(MODEL_ITEM).evaluateAll(nodes => nodes.map(node => ({
        name: node.getAttribute('data-model-name'), label: (node as HTMLElement).innerText })));
      this.catalog = ernieModels(items);
      if (!this.catalog.length) this.catalog = [automatic];
      return this.catalog.map(({ id, contextLength }) => ({ id, contextLength }));
    } finally { await page.keyboard.press('Escape').catch(() => {}); }
  }
  async models(): Promise<ProviderModel[]> {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('Ernie login is required.', 401);
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
    const name = model.slice('ernie/'.length);
    if (!await this.openModelMenu(page)) {
      await page.keyboard.press('Escape').catch(() => {});
      if (name !== ERNIE_DEFAULT_MODEL) throw new UpstreamError('Ernie model selection unavailable.', 400);
      return;
    }
    try {
      // `name` is validated by generate() as [\w.-]+.
      const option = page.locator(MODEL_MENU).first().locator(`[role="menuitemradio"][data-model-name="${name}"]`).first();
      if (!await option.isVisible().catch(() => false)) throw new UpstreamError('Requested Ernie model is not selectable on this account.', 400);
      if (await option.getAttribute('aria-checked') !== 'true') await option.click({ timeout: 5000 });
    } finally { await page.keyboard.press('Escape').catch(() => {}); }
  }
  private rememberError(error: unknown, retryAfter?: string | null): void {
    if (!(error instanceof UpstreamError)) return;
    if (error.status === 401) { this.authenticated = false; this.state = 'login_required'; this.guard.block({ state: 'login_required' }); }
    else if (error.status === 429) { this.state = 'rate_limited'; this.guard.defer(Math.max(60_000, retryAfterMilliseconds(retryAfter ?? null)), 'rate_limit'); }
    else if (error.status === 503) { this.state = 'unavailable'; this.notice = 'Verificação de segurança do Baidu (百度安全验证) pendente.'; }
    else if (error.status !== 400 && error.status !== 413) this.state = 'unavailable';
  }
  async generate(prompt: string, model: string, _thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    if (!/^ernie\/[\w.-]+$/.test(model) || this.manualLogin || this.transitioning)
      throw new UpstreamError('Ernie model unavailable or login is required.', this.manualLogin ? 401 : 400);
    // The website's editor truncates longer input (maxlength); never send a partial prompt.
    if (prompt.length > ERNIE_INPUT_LIMIT)
      throw new UpstreamError(`Ernie web input is limited to ${ERNIE_INPUT_LIMIT} characters; reduce the conversation or tools.`, 413);
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
        scope.__proxyErnie?.controller?.abort(); delete scope.__proxyErnie;
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
      timer = setTimeout(() => controller.abort(new UpstreamError('Ernie generation timed out.', 504)), 180_000);
      await this.pageMutex.withLock(() => withGenerationSignal(controller.signal, async () => {
        controller.signal.throwIfAborted(); interaction = 'authentication'; await this.validate();
        interaction = 'opening chat'; await this.navigate(); this.securityCheck();
        const editor = page!.locator(EDITOR).first();
        interaction = 'waiting for editor';
        await editor.waitFor({ state: 'visible', timeout: 30_000 });
        if (new URL(page!.url()).pathname !== '/') throw new UpstreamError('Ernie did not open a new conversation.', 502);
        interaction = 'selecting model'; await this.selectModel(model); controller.signal.throwIfAborted();
        await pauseBeforeProviderAction('send-message');
        await page!.evaluate(({ prompt, model }) => {
          (globalThis as any).__proxyErnie = { prompt, model, chunks: [], bytes: 0, claimed: false, done: false };
        }, { prompt, model: model.slice('ernie/'.length) });
        interaction = 'filling editor';
        await editor.click({ timeout: 10_000 });
        await editor.fill(prompt, { timeout: 10_000 });
        controller.signal.throwIfAborted();
        interaction = 'clicking send';
        // The site navigates to /search/<id> after submission. Capture owns completion;
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
            const c = (globalThis as any).__proxyErnie;
            const chunks: string[] = c ? c.chunks.splice(0) : [];
            if (c) c.bytes = 0;
            return { missing: !c, chunks, claimed: !!c?.claimed, done: !!c?.done, error: c?.error as string | undefined,
              status: c?.status as number | undefined, retryAfter: (c?.retryAfter ?? null) as string | null, host: location.hostname };
          }).catch(() => ({ missing: true, chunks: [] as string[], claimed: false, done: false, error: undefined, status: undefined, retryAfter: null, host: '' }));
          // A risk-control redirect replaces the page (and the capture) with a human verification.
          if (CAPTCHA_HOST.test(part.host)) throw ernieError(503, 'security_verification');
          if (part.missing) throw new UpstreamError('Ernie capture unavailable; verify the browser before retrying.', 502);
          if (!part.claimed && Date.now() > claimDeadline)
            throw new UpstreamError('Ernie did not send a supported conversation request; verify the browser.', 502);
          for (const chunk of part.chunks) yield chunk;
          if (part.error) {
            const error = part.error === 'model_mismatch' ? new UpstreamError('Ernie did not honor the requested model.', 400) : ernieError(part.status ?? 502);
            self.rememberError(error, part.retryAfter); throw error;
          }
          if (part.done) return;
          await delay(100, undefined, { signal: controller.signal });
        }
      })();
      return (async function* () {
        try { yield* parseErnieStream(chunks, controller.signal); }
        catch (error) {
          self.rememberError(error);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof UpstreamError) throw error;
          throw new UpstreamError('Ernie web stream unavailable; verify the browser before retrying.', 502);
        }
        finally { await cleanup(); }
      })();
    } catch (error) {
      this.rememberError(error); await cleanup();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`Ernie web interaction failed during ${interaction}; verify the browser before retrying.`, 502);
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
