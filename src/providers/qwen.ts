import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter, ProviderEvent, ProviderModel, ProviderStatus } from './types.ts';
import { GenerationGuard, getGenerationGuard, retryAfterMilliseconds, UpstreamError, withGenerationSignal } from '../services/generation-guard.ts';
import { pauseBeforeProviderAction } from '../services/action-pacing.ts';
import { createSessionStore } from '../services/session-store.ts';
import { qwenBrowserFetch, qwenResponseJson, type QwenResponse } from './qwen-browser.ts';
import { parseQwenStream, qwenModels, qwenPayload } from './qwen-protocol.ts';

const ORIGIN = 'https://chat.qwen.ai';

/** One persistent profile/account per isolated process; login is exclusively manual. */
export class QwenProvider implements ProviderAdapter {
  readonly id = 'qwen' as const;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialization?: Promise<void>;
  private token: string | null = null;
  private version: string | null = null;
  private checkedAt: string | null = null;
  private state: ProviderStatus['state'] = 'not_initialized';
  private unlock?: () => Promise<void>;
  private active = new Set<AbortController>();
  private directory = path.resolve(fileURLToPath(new URL('../../', import.meta.url)),
    process.env.PROVIDER_PROFILE_DIR || process.env.QWEN_PROFILE_DIR || (process.env.APP_MODE === 'worker' ? '/profile' : 'qwen_profile'));
  private session = createSessionStore(this.directory);
  private guard?: GenerationGuard;
  private catalog?: { models: ProviderModel[]; checkedAt: number };

  initialize(headless = true): Promise<void> {
    return this.initialization ??= this.launch(headless).catch(error => { this.initialization = undefined; throw error; });
  }
  private async launch(headless: boolean): Promise<void> {
    this.unlock = await this.session.lockProfile();
    try {
      this.guard = getGenerationGuard();
      const worker = process.env.APP_MODE === 'worker';
      await pauseBeforeProviderAction('open-browser');
      this.context = await chromium.launchPersistentContext(this.directory, {
        channel: 'chromium', headless,
        args: ['--disable-dev-shm-usage', ...(worker ? ['--disable-quic', '--proxy-bypass-list=<-loopback>'] : [])],
        ...(worker ? { chromiumSandbox: true, acceptDownloads: false, proxy: { server: 'http://egress:3128', bypass: '<-loopback>' } } : {}),
      });
      await this.session.restoreSession(this.context);
      this.context.on('request', request => {
        if (new URL(request.url()).hostname !== 'chat.qwen.ai') return;
        const headers = request.headers();
        if (/^Bearer /i.test(headers.authorization || '')) this.token = headers.authorization;
        if (headers.version) this.version = headers.version;
      });
      this.context.on('response', async response => {
        if (response.url().split('?')[0] !== 'https://auth.qwen.ai/api/v2/auths/refresh') return;
        try {
          const body = await response.json();
          if (typeof body?.data?.access_token === 'string') this.token = `Bearer ${body.data.access_token}`;
        } catch { /* Frontend will expose login status on the next validation. */ }
      });
      this.context.on('close', () => {
        this.context = null; this.page = null; this.token = null; this.state = 'not_initialized';
        this.initialization = undefined;
        const unlock = this.unlock; this.unlock = undefined; void unlock?.();
        for (const controller of this.active) controller.abort();
      });
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.connect();
    } catch (error) { await this.close(); throw error; }
  }
  getActivePage(): Page | null { return this.page; }
  async connect(): Promise<void> {
    if (!this.page) throw new Error('Qwen browser is not initialized.');
    await pauseBeforeProviderAction('open-chat');
    await this.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    this.state = 'login_required';
  }
  private headers(): Record<string, string> {
    return { accept: 'application/json', 'content-type': 'application/json', source: 'web',
      ...(this.token ? { authorization: this.token } : {}), ...(this.version ? { version: this.version } : {}),
      'x-request-id': randomUUID() };
  }
  private async request(route: string, body?: unknown, signal?: AbortSignal): Promise<QwenResponse> {
    if (!this.page || new URL(this.page.url()).origin !== ORIGIN) throw new UpstreamError('Qwen login is required.', 401);
    const response = await qwenBrowserFetch(this.page, `${ORIGIN}${route}`, this.headers(), body, signal);
    if (response.status >= 400) {
      await response.cancel();
      if (response.status === 401) { this.state = 'login_required'; this.guard?.block({ state: 'login_required' }); }
      if (response.status === 429) this.guard?.defer(Math.max(60_000, retryAfterMilliseconds(response.retryAfter)));
      throw new UpstreamError(`Qwen upstream returned HTTP ${response.status}; validate the session in the browser if required.`, response.status, response.status === 429);
    }
    return response;
  }
  private async validate(signal?: AbortSignal): Promise<void> {
    if (!this.token) throw new UpstreamError('Qwen login is required; complete login in the browser.', 401);
    const result = await qwenResponseJson(await this.request('/api/v2/users/status', undefined, signal));
    if (result?.success === false || result?.data?.is_login === false) throw new UpstreamError('Qwen login is required.', 401);
    this.state = 'authenticated'; this.checkedAt = new Date().toISOString();
  }
  async confirmLogin(interactive = false): Promise<void> {
    await this.validate();
    if (!this.context) throw new Error('Qwen browser is not initialized.');
    await this.session.saveSession(this.context);
    if (interactive) this.guard?.confirmInteractiveLogin();
  }
  async status(): Promise<ProviderStatus> {
    if (this.page && !this.guard?.status().block && !this.guard?.status().busy && (!this.checkedAt || Date.now() - Date.parse(this.checkedAt) > 15_000)) {
      try { await this.validate(); }
      catch (error) { this.state = error instanceof UpstreamError && error.status === 401 ? 'login_required' : 'unavailable'; this.checkedAt = new Date().toISOString(); }
    }
    return { state: this.guard?.status().block?.state ?? this.state, checkedAt: this.checkedAt, sessionSaved: await this.session.hasSavedSession(),
      ...(this.guard?.status() ?? {}), profileInUse: !this.page && await this.session.isProfileInUse() };
  }
  async models(): Promise<ProviderModel[]> {
    this.guard?.assertAllowed();
    if (this.state === 'authenticated' && this.catalog && Date.now() - this.catalog.checkedAt < 300_000) return this.catalog.models;
    await this.validate();
    const models = qwenModels(await qwenResponseJson(await this.request('/api/models')));
    this.catalog = { models, checkedAt: Date.now() };
    return models;
  }
  async generate(prompt: string, model: string, thinking: boolean, signal?: AbortSignal): Promise<AsyncIterable<ProviderEvent>> {
    signal?.throwIfAborted();
    if (!model.startsWith('qwen/') || !model.slice(5)) throw new UpstreamError('Invalid Qwen model ID.', 400);
    if (!this.guard) throw new Error('Qwen browser is not initialized.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    let release: (() => void) | undefined;
    let response: QwenResponse | undefined;
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return; cleaned = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.active.delete(controller);
      try { await response?.cancel(); } finally { release?.(); }
    };
    const timeout = setTimeout(() => controller.abort(new Error('Qwen generation timed out.')), 180_000);
    controller.signal.addEventListener('abort', () => { void cleanup(); }, { once: true });
    try {
      release = await this.guard.acquire(controller.signal);
      await this.validate(controller.signal);
      await withGenerationSignal(controller.signal, () => pauseBeforeProviderAction('send-message'));
      const upstream = model.slice(5);
      const created = await qwenResponseJson(await this.request('/api/v2/chats/new', {
        title: 'API conversation', models: [upstream], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '',
      }, controller.signal));
      const chatId = created?.chat_id ?? created?.id ?? created?.data?.chat_id ?? created?.data?.id;
      if (typeof chatId !== 'string' || !chatId) throw new Error('Qwen did not return a chat ID.');
      response = await this.request(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
        qwenPayload(prompt, upstream, thinking, chatId, randomUUID()), controller.signal);
      if (!response.contentType.includes('text/event-stream')) throw new Error('Qwen returned a non-SSE response; validate the browser session manually.');
      const stream = response;
      return (async function* () {
        try { yield* parseQwenStream(stream.chunks, controller.signal); }
        finally { await cleanup(); }
      })();
    } catch (error) { await cleanup(); throw error; }
  }
  async close(): Promise<void> {
    for (const controller of this.active) controller.abort();
    const context = this.context; this.context = null; this.page = null; this.token = null; this.catalog = undefined;
    try { await context?.close(); }
    finally { const unlock = this.unlock; this.unlock = undefined; await unlock?.(); this.initialization = undefined; this.state = 'not_initialized'; }
  }
}
