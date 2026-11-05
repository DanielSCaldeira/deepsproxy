import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { BrowserContext, Page } from 'playwright';

chromium.use(StealthPlugin());

export { chromium };

export function getBrowserChannel(): 'chromium' | 'chrome' {
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chromium';
  if (channel !== 'chromium' && channel !== 'chrome') {
    throw new Error('PLAYWRIGHT_CHANNEL must be chromium or chrome.');
  }
  return channel;
}

/** Keep explicit user agents consistent with the stealth plugin's CDP override. */
export function configureBrowserUserAgent(userAgent?: string): void {
  const name = 'stealth/evasions/user-agent-override';
  chromium.plugins.setDependencyDefaults(name, { userAgent: userAgent || null });
  // Dependencies are resolved on the first launch and reused on subsequent launches.
  const plugin = chromium.plugins.list.find(plugin => plugin.name === name);
  if (plugin && 'opts' in plugin) {
    (plugin.opts as { userAgent: string | null }).userAgent = userAgent || null;
  }
}

export async function createBrowserPage(context: BrowserContext): Promise<Page> {
  // The initial persistent-context tab predates playwright-extra's page hooks.
  const initialBlankPages = context.pages().filter(page => page.url() === 'about:blank');
  const page = await context.newPage();
  await Promise.all(initialBlankPages.map(page => page.close()));
  return page;
}
