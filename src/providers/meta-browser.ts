// Functions in this file run inside Chromium (addInitScript / page.evaluate).
// Keep them self-contained: no imports, closures or named inner helpers.
import type { MetaModeOption, MetaPageSnapshot, MetaTurnSnapshot } from './meta-protocol.ts';

/** Installed before frontend scripts. While the proxy owns a turn, the text written by the
 * site's own "Copy response" action is kept in the page instead of the system clipboard.
 * Outside that window the original clipboard behaviour is untouched. */
export function installMetaCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyMetaInstalled) return;
  scope.__proxyMetaInstalled = true;
  const clipboard = (globalThis as any).navigator?.clipboard;
  if (!clipboard) return;
  const originalWriteText = clipboard.writeText?.bind(clipboard);
  const originalWrite = clipboard.write?.bind(clipboard);
  clipboard.writeText = async function(text: string) {
    const capture = scope.__proxyMeta;
    if (capture?.copying) { capture.copied = String(text); return; }
    return originalWriteText(text);
  };
  clipboard.write = async function(items: any[]) {
    const capture = scope.__proxyMeta;
    if (!capture?.copying) return originalWrite(items);
    for (const item of items ?? []) {
      if (Array.isArray(item?.types) && item.types.includes('text/plain')) {
        capture.copied = await (await item.getType('text/plain')).text();
        return;
      }
    }
  };
}

/** Boolean/textual login evidence only. HttpOnly session cookies are never read. */
export function inspectMetaPage(): MetaPageSnapshot {
  const visible = Array.from(document.querySelectorAll('[data-testid="login-button"], [data-testid="composer-input"], input[aria-label="Ask Meta AI"], input[aria-label="Pergunte à Meta AI"]'))
    .filter(element => (element as HTMLElement).getClientRects().length > 0)
    .map(element => element.getAttribute('data-testid') || 'landing-input');
  const notices = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [aria-modal="true"], [data-testid="assistant-message"][data-streaming-state="ERROR"]'))
    .filter(element => (element as HTMLElement).getClientRects().length > 0)
    .map(element => ((element as HTMLElement).innerText || '').slice(0, 2000)).join('\n').slice(0, 4096);
  const body = (document.body?.innerText || '').slice(0, 20000);
  const region = body.match(/Meta AI isn't available yet in your country[^\n]*|Meta AI ainda não está disponível no seu país[^\n]*/i);
  return {
    url: location.href,
    // The account menu may live in a collapsed sidebar; presence is the signal.
    userMenu: !!document.querySelector('[data-testid="user-menu-button"]'),
    loginButton: visible.includes('login-button'),
    composer: visible.includes('composer-input') || visible.includes('landing-input'),
    notices,
    regionNotice: region ? region[0].slice(0, 500) : null,
  };
}

/** Message ids already rendered before the proxy sends its prompt. */
export function metaMessageIds(): string[] {
  return Array.from(document.querySelectorAll('[data-message-item]')).map(row => row.getAttribute('data-message-id') || '').filter(Boolean);
}

/** Read the first user row created after `before`, and the assistant row that follows it. */
export function readMetaTurn(before: string[]): MetaTurnSnapshot {
  const rows = Array.from(document.querySelectorAll('[data-message-item]'));
  let userIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = row.getAttribute('data-message-id') || '';
    const user = row.getAttribute('data-message-role') === 'user' || row.hasAttribute('data-user-message');
    if (user && !before.includes(id)) { userIndex = i; break; }
  }
  const notices = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [aria-modal="true"]'))
    .filter(element => (element as HTMLElement).getClientRects().length > 0)
    .map(element => ((element as HTMLElement).innerText || '').slice(0, 2000)).join('\n').slice(0, 4096);
  const loginButton = Array.from(document.querySelectorAll('[data-testid="login-button"]')).some(element => (element as HTMLElement).getClientRects().length > 0);
  const result: MetaTurnSnapshot = { userFound: userIndex >= 0, assistantId: null, state: null, complete: false, text: '', notices, loginButton };
  if (userIndex < 0) return result;
  for (let i = userIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.getAttribute('data-message-role') === 'user' || row.hasAttribute('data-user-message')) break;
    const message = row.querySelector('[data-testid="assistant-message"]') as HTMLElement | null;
    if (!message) continue;
    result.assistantId = row.getAttribute('data-message-id');
    result.state = message.getAttribute('data-streaming-state');
    result.complete = message.getAttribute('data-streaming-complete') === 'true';
    // Prefer the rendered answer body over reasoning toggles and action labels.
    const body = (message.querySelector('[class*="prose"]') as HTMLElement | null) ?? message;
    result.text = (body.innerText || '').slice(0, 4 * 1024 * 1024);
    break;
  }
  return result;
}

/** Read the composer mode menu that is currently open. */
export function readMetaModeOptions(): MetaModeOption[] {
  return Array.from(document.querySelectorAll('[data-testid^="composer-mode-option-"]')).map(option => ({
    testId: option.getAttribute('data-testid'),
    label: ((option as HTMLElement).innerText || '').split('\n')[0] || '',
    disabled: option.hasAttribute('data-disabled') || option.getAttribute('aria-disabled') === 'true',
  }));
}
