import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { swaggerUI } from '@hono/swagger-ui';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { chatCompletions } from './routes/chat.ts';
import { initPlaywright, closePlaywright, saveAuthenticatedSession, getSessionStatus, getActivePage, openDeepSeekChat } from './services/playwright.ts';
import { getContextLength } from './services/telemetry.ts';
import { createLogger } from './utils/logger.ts';
import { openApiSpec } from './openapi.ts';
import { statusPage } from './routes/status.ts';

dotenv.config();

const log = createLogger('server');

export const app = new Hono();

function modelEntry(id: string) {
  const dynamicLimit = getContextLength(id);
  return {
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'deepseek',
    permission: [],
    root: id,
    parent: null,
    context_length: dynamicLimit,
    max_context_tokens: dynamicLimit,
    max_input_tokens: dynamicLimit,
    max_output_tokens: 8_000,
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

app.get('/health', (c) => c.json({ status: 'ok' }));

app.get('/api/status', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    deepseek: await getSessionStatus(),
  });
});

app.post('/v1/chat/completions', chatCompletions);

app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      modelEntry('deepseek-v4-flash'),
      modelEntry('deepseek-v4-flash-thinking'),
      modelEntry('deepseek-v4-pro'),
      modelEntry('deepseek-v4-pro-thinking'),
    ],
  });
});

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
  const bind = resolveBindDecision();

  const server = serve({ fetch: app.fetch, port: bind.port, hostname: bind.host });
  log.info('Server starting', { host: bind.host, port: bind.port });
  let initializing = false;
  let stopping = false;
  const ensureBrowser = async () => {
    if (initializing || stopping || getActivePage()) return;
    initializing = true;
    try {
      await initPlaywright(headless);
      if (!headless) {
        const page = getActivePage();
        if (page) await openDeepSeekChat(page);
      }
      log.info('Playwright initialized');
    } catch (err: any) {
      log.error('Failed to initialize playwright', { error: err?.message || String(err) });
    } finally {
      initializing = false;
    }
  };
  void ensureBrowser();
  const recovery = setInterval(() => void ensureBrowser(), 15_000);
  recovery.unref();
  const shutdown = async () => {
    stopping = true;
    clearInterval(recovery);
    server.close();
    await saveAuthenticatedSession().catch(() => undefined);
    await closePlaywright();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startProxyServer();
}
