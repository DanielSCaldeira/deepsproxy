/**
 * Browser-side helpers for gemini.google.com. They run inside Chromium, so they
 * must stay self-contained (no imports or named inner helpers).
 */

/** Selectors observed in the public frontend on 2026-11-06 (pt-BR), with English fallbacks. */
export const GEMINI_SELECTORS = {
  editor: 'rich-textarea [contenteditable="true"][role="textbox"]',
  send: 'button[aria-label="Enviar mensagem"], button[aria-label="Send message"], button.send-button',
  stop: 'button[aria-label="Parar resposta"], button[aria-label="Stop response"], button.send-button.stop',
  modeButton: '[data-test-id="bard-mode-menu-button"]',
  modeItem: 'gem-menu-item[role="menuitemradio"]',
  response: 'model-response',
  userTurn: 'user-query',
  markdown: 'message-content .markdown',
  copy: 'message-actions copy-button button, message-actions button[aria-label="Copiar"], message-actions button[aria-label="Copy"]',
  notice: '[role="alert"], mat-snack-bar-container, simple-snack-bar',
} as const;

/**
 * Installed before frontend scripts. While a capture is armed, the text that the
 * site's own "Copiar" button writes is kept in the page instead of the system
 * clipboard. That text is the raw Markdown of the answer (code fences included).
 */
export function installGeminiCopyCapture(): void {
  const scope = globalThis as any;
  if (scope.__proxyGeminiInstalled) return;
  scope.__proxyGeminiInstalled = true;
  const clipboard = navigator.clipboard as any;
  if (clipboard) {
    const originalWrite = clipboard.write?.bind(clipboard);
    const originalWriteText = clipboard.writeText?.bind(clipboard);
    clipboard.writeText = async (text: string) => {
      const capture = scope.__proxyGemini;
      if (!capture?.armed) return originalWriteText?.(text);
      capture.copied = String(text); capture.armed = false;
    };
    clipboard.write = async (items: any[]) => {
      const capture = scope.__proxyGemini;
      if (!capture?.armed) return originalWrite?.(items);
      for (const item of items ?? []) {
        if (!item?.types?.includes('text/plain')) continue;
        capture.copied = await (await item.getType('text/plain')).text(); capture.armed = false;
        return;
      }
      capture.error = 'copy_without_text';
    };
  }
  // Older copy paths use document.execCommand('copy') and fill clipboardData.
  addEventListener('copy', (event: any) => {
    const capture = scope.__proxyGemini;
    if (!capture?.armed) return;
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text === 'string' && text) { capture.copied = text; capture.armed = false; event.preventDefault(); }
  });
}

export interface GeminiDomState {
  url: string;
  responses: number;
  userTurn: string;
  hasMarkdown: boolean;
  busy: boolean;
  stop: boolean;
  copy: boolean;
  notice: string;
  copied: string | null;
  copyError: string | null;
}

/** Reads the last turn only; never returns cookies, tokens or page globals. */
export function readGeminiState(selectors: typeof GEMINI_SELECTORS): GeminiDomState {
  const responses = document.querySelectorAll(selectors.response);
  const last = responses[responses.length - 1];
  const users = document.querySelectorAll(selectors.userTurn);
  const user = users[users.length - 1] as HTMLElement | undefined;
  const markdown = last?.querySelector(selectors.markdown);
  const stop = [...document.querySelectorAll(selectors.stop)].some(e => !!(e as HTMLElement).offsetParent || (e as HTMLElement).getClientRects().length > 0);
  const copy = !!last && [...last.querySelectorAll(selectors.copy)].some(e => (e as HTMLElement).getClientRects().length > 0);
  const notices = [...document.querySelectorAll(selectors.notice)].map(e => (e as HTMLElement).innerText || e.textContent || '');
  if (last) for (const element of last.querySelectorAll('[class*="error"]')) if (!markdown?.contains(element)) notices.push((element as HTMLElement).innerText || '');
  const capture = (globalThis as any).__proxyGemini;
  return {
    url: location.href, responses: responses.length,
    userTurn: (user?.innerText || user?.textContent || '').slice(0, 100_000),
    hasMarkdown: !!markdown, busy: markdown?.getAttribute('aria-busy') === 'true', stop, copy,
    notice: notices.join('\n').slice(0, 2000),
    copied: typeof capture?.copied === 'string' ? capture.copied : null,
    copyError: typeof capture?.error === 'string' ? capture.error : null,
  };
}
