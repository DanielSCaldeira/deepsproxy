import { initPlaywright, closePlaywright, getActivePage } from './services/playwright.ts';
import { createLogger } from './utils/logger.ts';

const log = createLogger('login');

async function main(): Promise<void> {
  log.info('Opening DeepSeek to allow login');
  await initPlaywright(false);

  const page = getActivePage();
  if (!page) {
    log.error('Failed to obtain active page');
    process.exit(1);
  }

  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' });
  log.info('Browser opened — log in to chat.deepseek.com');
  log.info('Once logged in, press Ctrl+C here or close the browser.');

  process.on('SIGINT', async () => {
    log.info('Closing browser');
    await closePlaywright();
    process.exit(0);
  });
}

main();
