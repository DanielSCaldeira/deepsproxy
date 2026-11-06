import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { chatCompletions } from './routes/chat.ts';
import { getProvider } from './providers/registry.ts';
import type { ProviderModel } from './providers/types.ts';
import { createLogger } from './utils/logger.ts';
import { openApiSpec } from './openapi.ts';
import { statusPage } from './routes/status.ts';
import { diagnostic, flushDiagnostics } from './utils/diagnostics.ts';
import { flushBrowserLogs } from './services/browser-logging.ts';

dotenv.config();

const log = createLogger('server');

export const app = new Hono();
let workerReady = false;

function modelEntry(model: ProviderModel) {
  const id = model.id;
  const dynamicLimit = model.contextLength;
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: getProvider().id,
    permission: [],
    root: id,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    ...((getProvider().id === 'chatgpt' || getProvider().id === 'ernie') && model.maxOutputTokens === undefined ? {} : { max_output_tokens: model.maxOutputTokens ?? 8_000 }),
    context_limit_source: dynamicLimit > 0 ? 'configured_or_estimated' : 'unknown',
  };
}

app.use('*', cors());

app.get('/', (c) => c.html(statusPage));

app.get('/openapi.json', (c) => c.json(openApiSpec));
app.get('/docs', swaggerUI({ url: '/openapi.json' }));

app.use('*', async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey;
    if (!providedKey || providedKey !== apiKey) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  await next();
});

const browserReady = () => getProvider().isReady?.() ?? !!getProvider().getActivePage();
app.get('/health', (c) => process.env.APP_MODE === 'worker' && (!workerReady || !browserReady())
  ? c.json({ status: 'starting' }, 503) : c.json({ status: 'ok' }));

if (process.env.APP_MODE === 'worker') {
  if (!process.env.API_KEY || process.env.API_KEY.length < 32) throw new Error('Worker requires an internal API_KEY');
  app.post('/internal/connect', async c => {
    await getProvider().initialize(false);
    const page = getProvider().getActivePage();
    if (!page && !getProvider().isReady?.()) return c.json({ error: 'browser_unavailable' }, 503);
    await getProvider().connect();
    return c.json({ ok: true });
  });
  app.post('/internal/confirm', async c => {
    try { await getProvider().confirmLogin(true); }
    catch { return c.json({ state: (await getProvider().status()).state }, 409); }
    return c.json({ ok: true });
  });
  app.post('/internal/finish-login', async c => {
    try {
      const provider = getProvider();
      if (provider.finishLogin) await provider.finishLogin();
      else await provider.confirmLogin(true);
    } catch { return c.json({ error: 'Conclua o login no navegador e clique em Concluir login novamente.' }, 409); }
    return c.json({ ok: true });
  });
}

app.get('/api/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  const account = await getProvider().status();
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    provider: getProvider().id,
    account,
    ...(getProvider().id === 'deepseek' ? { deepseek: account } : {}),
  });
});

app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', async (c) => c.json({
  object: 'list', data: (await getProvider().models()).map(modelEntry),
}));

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

interface BindDecision {
  host: string;
  port: number;
}

function resolveBindDecision(): BindDecision {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const hasApiKey = !!process.env.API_KEY;
  const explicitHost = process.env.BIND_HOST;

  if (explicitHost) {
    if (!hasApiKey && !isLoopback(explicitHost)) {
      log.error(
        'Refusing to start: BIND_HOST is non-loopback and API_KEY is not set. ' +
          'Either set API_KEY or use BIND_HOST=127.0.0.1.',
        { bindHost: explicitHost }
      );
      process.exit(2);
    }
    if (!hasApiKey) {
      log.warn('API_KEY not set — proxy accessible without auth on loopback only', { bindHost: explicitHost });
    }
    return { host: explicitHost, port };
  }

  if (!hasApiKey) {
    log.warn(
      'API_KEY not set — defaulting to loopback (127.0.0.1). ' +
        'To expose externally, set API_KEY and BIND_HOST=0.0.0.0.'
    );
    return { host: '127.0.0.1', port };
  }

  return { host: '0.0.0.0', port };
}

export function startProxyServer(headless = process.env.PLAYWRIGHT_HEADLESS !== 'false') {
  diagnostic('process.started', { headless });
  const bind = resolveBindDecision();

  const server = serve({ fetch: app.fetch, port: bind.port, hostname: bind.host });
  log.info('Server starting', { host: bind.host, port: bind.port });
  let initializing = false;
  let stopping = false;
  let failures = 0;
  const ensureBrowser = async () => {
    if (initializing || stopping || browserReady()) return;
    if (process.env.APP_MODE === 'worker' && failures >= 3) return;
    initializing = true;
    diagnostic('browser.recovery', { attempt: failures + 1 });
    try {
      await getProvider().initialize(headless);
      if (!headless) {
        const page = getProvider().getActivePage();
        if (page) await getProvider().connect(false);
      }
      log.info('Playwright initialized');
      workerReady = true;
      failures = 0;
    } catch (err: any) {
      failures++;
      log.error('Failed to initialize playwright', { error: err?.message || String(err) });
    } finally {
      initializing = false;
    }
  };
  server.once('listening', () => {
    if (process.env.APP_MODE !== 'worker') {
      const host = ['0.0.0.0', '::'].includes(bind.host) ? 'localhost' : bind.host;
      log.info(`Proxy pronto — painel: http://${host}:${bind.port}/ | API OpenAI: http://${host}:${bind.port}/v1`);
    }
    void ensureBrowser();
  });
  const recovery = setInterval(() => void ensureBrowser(), 15_000);
  recovery.unref();
  const shutdown = async () => {
    stopping = true;
    diagnostic('process.stopping');
    clearInterval(recovery);
    server.close();
    try { await getProvider().confirmLogin(); } catch { /* A pending human login must still close and flush normally. */ }
    await getProvider().close();
    await flushBrowserLogs();
    await flushDiagnostics();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('error', (error: NodeJS.ErrnoException) => {
    stopping = true;
    clearInterval(recovery);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if (error.code === 'EADDRINUSE') log.error('Porta já ocupada. Encerre a outra instância do proxy ou configure PORT.', { host: bind.host, port: bind.port });
    else log.error('Não foi possível iniciar o servidor.', { code: error.code });
    void getProvider().close().finally(() => { process.exitCode = 1; });
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startProxyServer();
}
