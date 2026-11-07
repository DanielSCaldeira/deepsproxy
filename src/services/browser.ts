import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page, Locator } from 'playwright';
import { observeBrowser } from './browser-logging.ts';
import { UpstreamError } from './generation-guard.ts';

chromium.use(StealthPlugin());

export { chromium };
export { chromium as nativeChromium } from 'playwright';
export const BROWSER_LOCALE = 'pt-BR';

export function getBrowserChannel(): 'chromium' | 'chrome' {
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') {
    throw new Error('PLAYWRIGHT_CHANNEL must be chromium or chrome.');
  }
  return channel;
}

/** Keep the context and plugin overrides consistent, including CAPTCHA language detection. */
export function configureBrowserUserAgent(userAgent?: string): void {
  const preferences = [
    { name: 'stealth/evasions/user-agent-override', options: { userAgent: userAgent || null, locale: `${BROWSER_LOCALE},pt` } },
    { name: 'stealth/evasions/navigator.languages', options: { languages: [BROWSER_LOCALE, 'pt'] } },
  ];
  for (const { name, options } of preferences) {
    chromium.plugins.setDependencyDefaults(name, options);
    // Dependencies are resolved on the first launch and reused on subsequent launches.
    const plugin = chromium.plugins.list.find(plugin => plugin.name === name);
    if (plugin && 'opts' in plugin) Object.assign(plugin.opts as object, options);
  }
}

export async function createBrowserPage(context: BrowserContext, options: { rejectCookies?: boolean } = {}): Promise<Page> {
  observeBrowser(context);
  // The initial persistent-context tab predates playwright-extra's page hooks.
  const initialBlankPages = context.pages().filter(page => page.url() === 'about:blank');
  const page = await context.newPage();
  // Dismiss only recognized cookie consent controls, choosing the opt-out.
  // Locator handlers also cover banners that appear after hydration/navigation.
  const reject = page.locator('[data-testid="consent-reject"]:visible, #onetrust-reject-all-handler:visible, [role="dialog"] button:text-is("Recusar opcionais"):visible, [role="dialog"] button:text-is("Reject optional cookies"):visible, [role="dialog"] button:text-is("Rejeitar todos os cookies"):visible').first();
  // Sites whose opt-out does not close the banner install their own handler.
  if (options.rejectCookies !== false) await page.addLocatorHandler(reject, async control => { await control.click({ timeout: 3000 }); });
  await Promise.all(initialBlankPages.map(page => page.close()));
  return page;
}

/** Focus can race server-rendered placeholders being replaced by hydration. */
export async function focusChatEditor(page: Page, selector: string, timeout = 30_000): Promise<Locator> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  do {
    const editor = page.locator(selector).first();
    try {
      await editor.waitFor({ state: 'visible', timeout: Math.min(1500, Math.max(1, deadline - Date.now())) });
      if (await editor.isEditable()) {
        await editor.click({ timeout: Math.min(1500, Math.max(1, deadline - Date.now())) });
        return page.locator(selector).first();
      }
    } catch (error) { lastError = error; }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline && !page.isClosed());
  if (await browserNeedsVerification(page)) throw new UpstreamError('O site exige verificação no navegador. Abra Conectar no painel, conclua a verificação na tela remota e clique em Concluir login.', 503);
  throw lastError instanceof Error ? lastError : new Error('Chat editor did not become editable.');
}

export async function browserNeedsVerification(page: Page): Promise<boolean> {
  return /^(Um momento|Just a moment|Attention Required)/i.test(await page.title().catch(() => ''));
}

/** Copy exposes original Markdown before typography/code rendering. Intercept
 * this one action without reading or changing the operating system clipboard. */
export async function readCopiedResponse(page: Page, button: Locator, rendered: string): Promise<string> {
  if (!await button.isVisible().catch(() => false)) return rendered;
  const installed = await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return false;
    const state = { text: null as string | null, writeText: Object.getOwnPropertyDescriptor(clipboard, 'writeText'),
      write: Object.getOwnPropertyDescriptor(clipboard, 'write') };
    (globalThis as any).__proxyReplyCopy = state;
    clipboard.writeText = async function(text) { state.text = String(text); };
    clipboard.write = async function(items) {
      for (const item of items) if (item.types.includes('text/plain')) { state.text = await (await item.getType('text/plain')).text(); break; }
    };
    return true;
  });
  if (!installed) throw new UpstreamError('Original response text is unavailable in the browser.', 502);
  try {
    await button.click({timeout:3000});
    for (let attempt = 0; attempt < 40; attempt++) {
      const text = await page.evaluate(() => (globalThis as any).__proxyReplyCopy?.text as string | null);
      if (typeof text === 'string') {
        if (!text.trim() || text.length > 4 * 1024 * 1024) throw new UpstreamError('Invalid original response text.', 502);
        return text;
      }
      await page.waitForTimeout(50);
    }
    throw new UpstreamError('The site did not expose the original response text.', 502);
  } finally {
    await page.evaluate(() => {
      const state = (globalThis as any).__proxyReplyCopy, clipboard = navigator.clipboard;
      if (!state || !clipboard) return;
      if (state.writeText) Object.defineProperty(clipboard, 'writeText', state.writeText); else delete (clipboard as any).writeText;
      if (state.write) Object.defineProperty(clipboard, 'write', state.write); else delete (clipboard as any).write;
      delete (globalThis as any).__proxyReplyCopy;
    }).catch(() => {});
  }
}
