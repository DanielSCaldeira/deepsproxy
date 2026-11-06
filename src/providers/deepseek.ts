import type { ProviderAdapter, ProviderEvent } from './types.ts';
import { createDeepSeekStream, updateSessionParent } from '../services/deepseek.ts';
import { initPlaywright, closePlaywright, getActivePage, openDeepSeekChat, saveAuthenticatedSession, getSessionStatus, waitForAuthenticatedChat } from '../services/playwright.ts';
import { getContextLength } from '../services/telemetry.ts';
import { withGenerationSignal } from '../services/generation-guard.ts';
import { diagnostic } from '../utils/diagnostics.ts';
import { DEEPSEEK_MODEL_IDS } from './catalog.ts';
import { InteractiveBrowser } from '../services/interactive-browser.ts';
import { getProfileDirectory, hasSavedSession } from '../services/session-store.ts';
import { Mutex } from '../utils/mutex.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** Decode the provider protocol; always cancel unread data to release the generation lease. */
export async function* decodeDeepSeekStream(stream: ReadableStream, uiSessionId: string): AsyncGenerator<ProviderEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentAppendPath = '';
  let currentFragmentType = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;
        try {
          const chunk = JSON.parse(dataStr);
          // Only numeric protocol codes; text fields may contain conversation data.
          if (typeof chunk.code === 'number' && chunk.code !== 0) diagnostic('stream.code', { code: chunk.code });
          if (typeof chunk.biz_code === 'number' && chunk.biz_code !== 0) diagnostic('stream.code', { code: chunk.biz_code });
          let dsMessageId: any = null;
          if (chunk.response_message_id) {
            dsMessageId = chunk.response_message_id;
          } else if (chunk.v && typeof chunk.v === 'object') {
            if (chunk.v.response && chunk.v.response.message_id) {
              dsMessageId = chunk.v.response.message_id;
            } else if (chunk.v.message_id) {
              dsMessageId = chunk.v.message_id;
            }
          } else if (chunk.message_id) {
            dsMessageId = chunk.message_id;
          }

          if (dsMessageId) updateSessionParent(uiSessionId, dsMessageId);

          let vStr = '';
          let foundStr = false;
          let isThinkingChunk = false;

          if (typeof chunk.p === 'string') {
            currentAppendPath = chunk.p;
            if (chunk.p === 'response/accumulated_token_usage' && typeof chunk.v === 'number') {
              yield { type: 'usage', completionTokens: chunk.v };
            }
          }

          if (typeof chunk.v === 'string') {
            vStr = chunk.v;
            foundStr = true;
          } else if (chunk.v && typeof chunk.v === 'object') {
            if (chunk.v.response && chunk.v.response.fragments && chunk.v.response.fragments.length > 0) {
              const frag = chunk.v.response.fragments[0];
              if (typeof frag.content === 'string') {
                vStr = frag.content;
                foundStr = true;
                currentAppendPath = frag.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                currentFragmentType = frag.type || '';
              }
            } else if (Array.isArray(chunk.v) && chunk.v.length > 0) {
              const firstObj = chunk.v[0];
              if (typeof firstObj.content === 'string') {
                vStr = firstObj.content;
                foundStr = true;
                currentAppendPath = firstObj.type === 'THINK' ? 'response/thinking_content' : 'response/content';
                currentFragmentType = firstObj.type || '';
              }
            }
          }

          if (chunk.p === 'response/fragments' && Array.isArray(chunk.v)) {
            const lastFrag = chunk.v[chunk.v.length - 1];
            if (lastFrag && lastFrag.type) currentFragmentType = lastFrag.type;
          }

          if (
            currentAppendPath.includes('thinking_content') ||
            currentAppendPath.includes('THINK') ||
            (currentAppendPath.includes('fragments/-1/content') && currentFragmentType === 'THINK')
          ) {
            isThinkingChunk = true;
          }

          if (!foundStr || vStr === '' || vStr === 'FINISHED') continue;

          yield { type: isThinkingChunk ? 'reasoning' : 'content', text: vStr };
        } catch { /* Ignore malformed provider frames, preserving existing compatibility. */ }
      }
      if (done) break;
    }
    yield { type: 'finish' };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class DeepSeekProvider implements ProviderAdapter {
  readonly id = 'deepseek' as const;
  private interactive?: InteractiveBrowser;
  private manualLogin = false;
  private transitioning = false;
  private loginMutex = new Mutex();
  async models() { return DEEPSEEK_MODEL_IDS.map(id => ({ id, contextLength: getContextLength(id), maxOutputTokens: 8_000 })); }
  initialize(headless = true) {
    if (this.manualLogin || this.transitioning) return Promise.resolve();
    return initPlaywright(headless);
  }
  async connect(interactive = true) {
    if (process.env.APP_MODE === 'worker' && interactive) {
      return this.loginMutex.withLock(async () => {
        if (this.manualLogin && this.interactive?.running) return;
        this.transitioning = true;
        try {
          await closePlaywright();
          this.interactive ??= new InteractiveBrowser(getProfileDirectory());
          await this.interactive.start();
          this.manualLogin = true;
        } finally { this.transitioning = false; }
      });
    }
    await this.initialize(false);
    const page = getActivePage();
    if (!page) throw new Error('browser_unavailable');
    await openDeepSeekChat(page, 20_000);
  }
  async confirmLogin(interactive = false) {
    if (this.manualLogin || this.transitioning) throw new Error('Conclua o login no navegador e clique em Concluir login.');
    if (interactive) {
      const page = getActivePage();
      if (!page) throw new Error('browser_unavailable');
      await waitForAuthenticatedChat(page, { allowSuspended: true, timeoutMs: 20_000 });
    }
    return saveAuthenticatedSession(interactive, { allowSuspended: interactive });
  }
  async finishLogin() {
    return this.loginMutex.withLock(async () => {
      if (!this.manualLogin) return this.confirmLogin(true);
      this.transitioning = true;
      try {
        await this.interactive!.close();
        // The profile now contains the human's latest login. An older snapshot
        // must not overwrite it before we validate and save the new session.
        await initPlaywright(false, { restoreSavedSession: false });
        const page = getActivePage();
        if (!page) throw new Error('browser_unavailable');
        await openDeepSeekChat(page, 20_000);
        await waitForAuthenticatedChat(page, { allowSuspended: true, timeoutMs: 20_000 });
        await saveAuthenticatedSession(true, { allowSuspended: true });
        this.manualLogin = false;
      } catch (error) {
        // An early click must return the user to the human login browser.
        if (!this.interactive!.running) {
          await closePlaywright();
          await this.interactive!.start();
        }
        throw new Error('O login ainda não foi confirmado. Conclua o acesso ao chat e clique em Concluir login novamente.', { cause: error });
      } finally { this.transitioning = false; }
    });
  }
  isReady() { return this.transitioning || (this.manualLogin ? !!this.interactive?.running : !!getActivePage()); }
  async status() {
    if (this.manualLogin || this.transitioning) return {
      state: 'login_required' as const, sessionSaved: await hasSavedSession(),
      checkedAt: new Date().toISOString(), confirmationRequired: true,
    };
    return getSessionStatus();
  }
  async close() {
    return this.loginMutex.withLock(async () => {
      await this.interactive?.close();
      this.manualLogin = false;
      await closePlaywright();
    });
  }
  getActivePage() { return getActivePage(); }
  async generate(prompt: string, model: string, thinking: boolean, signal?: AbortSignal) {
    if (this.manualLogin || this.transitioning) throw new UpstreamError('DeepSeek login is required. Conclua o login pelo painel.', 401);
    const dispatch = () => createDeepSeekStream(prompt, thinking, model.includes('-pro'), null);
    const result = await (signal ? withGenerationSignal(signal, dispatch) : dispatch());
    return decodeDeepSeekStream(result.stream, result.uiSessionId);
  }
}
