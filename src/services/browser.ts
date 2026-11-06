import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';
import { observeBrowser } from './browser-logging.ts';

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

export async function createBrowserPage(context: BrowserContext): Promise<Page> {
  observeBrowser(context);
  // The initial persistent-context tab predates playwright-extra's page hooks.
  const initialBlankPages = context.pages().filter(page => page.url() === 'about:blank');
  const page = await context.newPage();
  await Promise.all(initialBlankPages.map(page => page.close()));
  return page;
}
