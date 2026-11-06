import type { ProviderEvent, ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** Page evidence collected in the browser. It carries no cookie, token or identity value. */
export interface MetaPageSnapshot {
  url: string;
  /** `[data-testid="user-menu-button"]`, rendered only for a signed-in viewer. */
  userMenu: boolean;
  /** Visible `[data-testid="login-button"]`, rendered on the logged-out landing page. */
  loginButton: boolean;
  /** `[data-testid="composer-input"]` or the logged-out landing input. Visitors also have one. */
  composer: boolean;
  /** Visible dialogs, alerts and errored assistant messages, bounded. */
  notices: string;
  /** Matched regional-availability line from the page body, if any. */
  regionNotice: string | null;
}

export type MetaPageState =
  | { state: 'authenticated' }
  | { state: 'login_required'; message: string | null }
  | { state: 'unavailable'; reason: 'region' | 'unknown'; message: string | null }
  | { state: 'rate_limited'; message: string };

// Strings observed in the public frontend bundles (English source strings) and Portuguese variants.
export const META_LIMIT = /You've reached the message limit|You're sending too many requests|You reached your limit|atingiu o limite|muitas solicitações|limite de mensagens/i;
export const META_LOGIN = /Log in or sign up to (?:keep chatting|ask Meta AI)|Log in or create an account to send it|Welcome to Meta AI\s*\n\s*Providing your birthday|Faça login ou cadastre-se|Entre ou cadastre-se/i;
export const META_REGION = /Meta AI isn't available yet in your country|Meta AI ainda não está disponível no seu país/i;

const line = (text: string, pattern: RegExp) => text.split('\n').find(l => pattern.test(l))?.trim().slice(0, 4096) ?? text.match(pattern)?.[0] ?? null;

/** Composer presence alone never proves authentication: the landing page offers it to visitors. */
export function classifyMetaPage(snapshot: MetaPageSnapshot): MetaPageState | null {
  const notices = snapshot.notices || '';
  if (snapshot.regionNotice || META_REGION.test(notices))
    return { state: 'unavailable', reason: 'region', message: snapshot.regionNotice ?? line(notices, META_REGION) };
  let origin: string;
  try { origin = new URL(snapshot.url).origin; } catch { origin = ''; }
  if (origin !== 'https://www.meta.ai') return { state: 'login_required', message: null };
  if (snapshot.loginButton || META_LOGIN.test(notices)) return { state: 'login_required', message: line(notices, META_LOGIN) };
  if (snapshot.userMenu) return META_LIMIT.test(notices) ? { state: 'rate_limited', message: line(notices, META_LIMIT)! } : { state: 'authenticated' };
  // Still hydrating or an unknown layout: neither a login nor a logout signal yet.
  return null;
}

export function metaError(kind: 'login' | 'limit' | 'region' | 'stopped' | 'empty' | 'failed', detail?: string | null): UpstreamError {
  switch (kind) {
    case 'login': return new UpstreamError('Meta AI login is required; complete login in the browser.', 401, false, detail ?? null);
    case 'limit': return new UpstreamError('Meta AI usage limit reached.', 429, false, detail ?? null);
    case 'region': return new UpstreamError('Meta AI is not available in this region for the account.', 503, false, detail ?? null);
    case 'stopped': return new UpstreamError('Meta AI stopped the response before completion.', 502);
    case 'empty': return new UpstreamError('Meta AI returned no final text.', 502);
    default: return new UpstreamError('Meta AI reported an error for this response.', 502, false, detail ?? null);
  }
}

export interface MetaModeOption { testId: string | null; label: string; disabled: boolean }
/** Only text conversation modes observed in the frontend are exposed (`think_fast`, `think_hard`, ...).
 * Media, canvas and agent modes are not advertised until validated with a real account. */
export function metaModels(options: MetaModeOption[]): Array<ProviderModel & { label: string }> {
  const seen = new Set<string>();
  const models: Array<ProviderModel & { label: string }> = [];
  for (const option of options) {
    const id = option.testId?.match(/^composer-mode-option-(think_[a-z0-9_]{1,40})$/)?.[1];
    if (!id || option.disabled || seen.has(id)) continue;
    seen.add(id);
    models.push({ id: `meta/${id}`, label: option.label.trim().slice(0, 80), contextLength: 0 });
  }
  return models;
}

/** Turn snapshot read from the DOM after the proxy's own message was sent. */
export interface MetaTurnSnapshot {
  userFound: boolean;
  assistantId: string | null;
  /** `data-streaming-state` of `[data-testid="assistant-message"]`: INIT, STREAMING, DONE, ERROR or STOPPED. */
  state: string | null;
  complete: boolean;
  text: string;
  notices: string;
  loginButton: boolean;
}
export type MetaTurnProgress = { kind: 'waiting' } | { kind: 'done'; text: string } | { kind: 'error'; error: UpstreamError };

/** Decide the state of a turn. A page-level login or limit notice wins over a partial answer. */
export function metaTurnProgress(turn: MetaTurnSnapshot): MetaTurnProgress {
  const notices = turn.notices || '';
  if (META_LIMIT.test(notices)) return { kind: 'error', error: metaError('limit', line(notices, META_LIMIT)) };
  if (turn.loginButton || META_LOGIN.test(notices)) return { kind: 'error', error: metaError('login', line(notices, META_LOGIN)) };
  if (META_REGION.test(notices)) return { kind: 'error', error: metaError('region', line(notices, META_REGION)) };
  const state = (turn.state || '').toUpperCase();
  if (state === 'ERROR') {
    const text = turn.text || '';
    if (META_LIMIT.test(text)) return { kind: 'error', error: metaError('limit', line(text, META_LIMIT)) };
    if (META_LOGIN.test(text)) return { kind: 'error', error: metaError('login', line(text, META_LOGIN)) };
    return { kind: 'error', error: metaError('failed', text.slice(0, 500) || null) };
  }
  if (state === 'STOPPED') return { kind: 'error', error: metaError('stopped') };
  if (state === 'DONE' || (turn.complete && state !== 'INIT' && state !== 'STREAMING')) {
    if (!turn.text.trim()) return { kind: 'error', error: metaError('empty') };
    return { kind: 'done', text: turn.text };
  }
  return { kind: 'waiting' };
}

/** The final answer is delivered once, after the site marks the message as complete. */
export function* metaEvents(text: string): Generator<ProviderEvent> {
  if (!text.trim()) throw metaError('empty');
  yield { type: 'content', text };
  yield { type: 'finish' };
}
