import 'dotenv/config';
import { initPlaywright, getActivePage, saveAuthenticatedSession, waitForAuthenticatedChat, openDeepSeekChat } from './services/playwright.ts';
import { createLogger } from './utils/logger.ts';
import { startProxyServer } from './index.ts';

const log = createLogger('login');

async function main(): Promise<void> {
  log.info('Opening DeepSeek to allow login');
  await initPlaywright(false);

  const page = getActivePage();
  if (!page) {
    log.error('Failed to obtain active page');
    process.exit(1);
  }

  // Keep the API and interactive login in the same browser context. Closing it
  // and reopening a second browser here can lose session-only authentication.
  startProxyServer(false);

  await openDeepSeekChat(page);
  log.info('Faça login nesta janela do DeepSeek. O navegador permanecerá aberto e será usado pela API.');
  await waitForAuthenticatedChat(page);
  log.info('Login confirmado. Salvando a sessão do navegador.');
  await saveAuthenticatedSession();
  log.info('Sessão salva. O proxy está usando este mesmo navegador. Não é necessário executar npm start.');
}

main().catch((error: unknown) => {
  log.error('Login não confirmado. Execute npm run login novamente e aguarde a confirmação.', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
