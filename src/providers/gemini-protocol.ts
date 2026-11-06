import type { ProviderModel } from './types.ts';
import { UpstreamError } from '../services/generation-guard.ts';

/** Signals derived from the site's own /app HTML. No token or identity leaves Chromium. */
export interface GeminiAuthProbe {
  status: number;
  /** The response left gemini.google.com, e.g. to accounts.google.com. */
  offOrigin: boolean;
  /** WIZ_global_data carries the per-session request token (`SNlM0e`) only for signed-in users. */
  token: boolean;
  /** Signed-out pages link the OneGoogle bar to accounts.google.com/ServiceLogin. Signed-in pages
   * also carry one ServiceLogin link (add/switch account), so it is only evidence without an account link. */
  signInLink: boolean;
  /** Signed-in pages link the OneGoogle bar account menu to SignOutOptions. */
  accountLink: boolean;
}

/** The account menu (SignOutOptions) proves a signed-in page; otherwise the token counts only without
 * a sign-in link. A visible composer alone is not authentication (anonymous chat exists).
 * Observed on 2026-11-06: a signed-in /app had SNlM0e, SignOutOptions and one ServiceLogin link. */
export function geminiAuthenticated(probe: GeminiAuthProbe): boolean {
  if (probe.status !== 200 || probe.offOrigin) return false;
  return probe.accountLink || (probe.token && !probe.signInLink);
}

export function geminiError(status: number, reason?: string): UpstreamError {
  if (status === 401) return new UpstreamError('Gemini login is required.', 401);
  if (status === 429 || reason === 'usage_limit') return new UpstreamError('Gemini usage limit reached.', 429);
  return new UpstreamError(`Gemini web request failed (HTTP ${status || 502}).`, status >= 400 ? status : 502);
}

/** Mode labels such as "3.5 Flash Lite" become stable, ASCII model IDs. */
export function geminiModelSlug(label: string): string {
  return label.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
}

export interface GeminiModeOption { label: string; disabled: boolean; checked: boolean }

/** Only selectable menu entries are advertised; locked modes (padlock, aria-disabled) are not. */
export function geminiModels(options: GeminiModeOption[]): Array<ProviderModel & { label: string }> {
  const seen = new Set<string>();
  const models: Array<ProviderModel & { label: string }> = [];
  for (const option of options) {
    const slug = geminiModelSlug(option.label);
    if (option.disabled || !slug || slug === 'auto' || seen.has(slug)) continue;
    seen.add(slug);
    // The web UI does not publish a context window; use the shared budget.
    models.push({ id: `gemini/${slug}`, label: option.label.trim(), contextLength: 0 });
  }
  return models;
}

/** Compare only for correlation; the submitted prompt is never rewritten. */
export function normalizeGeminiText(text: string): string {
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** The rendered user turn carries a screen-reader prefix ("Você disse") and paragraph breaks. */
export function geminiPromptMatches(renderedUserTurn: string, prompt: string): boolean {
  const expected = normalizeGeminiText(prompt).slice(0, 200);
  return !!expected && normalizeGeminiText(renderedUserTurn).includes(expected);
}

// Limit notices are only read outside the model's markdown, so an answer that
// merely discusses limits is never classified as a quota error.
const LIMIT_NOTICE = /(?:atingiu|alcançou) o limite|limite de (?:uso|mensagens|conversas)|reached (?:your|the) (?:usage |daily )?limit|usage limit|quota/i;
export function geminiLimitNotice(text: string | null | undefined): boolean {
  return !!text && LIMIT_NOTICE.test(text);
}
