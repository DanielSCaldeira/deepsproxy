import { Hono, type Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { audit, ensureAccounts, providers, type Database } from './database.ts';
import { digest, email, equal, hashPassword, HttpError, password, RateLimit, secret, uuid, verifyPassword } from './security.ts';
import type { ProductionConfig } from './config.ts';
import { Workers } from './workers.ts';
import { panelPage } from './panel.ts';

const providerNames: Record<string, string> = { deepseek: 'DeepSeek', qwen: 'Qwen', chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', copilot: 'Copilot', mistral: 'Mistral', grok: 'Grok', meta: 'Meta AI', cohere: 'Cohere', perplexity: 'Perplexity', kimi: 'Kimi', quillbot: 'QuillBot', ernie: 'Ernie' };
// Providers whose login is confirmed by the user in the panel ('Concluir login').
const manualLoginProviders = new Set<string>(['deepseek', 'chatgpt', 'claude', 'perplexity']);

type Identity = { id: string; email: string; role: string; session: string; csrf: string };
type Env = { Variables: { identity: Identity } };
export function createGateway(db: Database, workers: Workers, config: ProductionConfig) {
  const app = new Hono<Env>();
  const limits = new RateLimit();
  let passwordChecks = 0;
  async function passwordCheck<T>(run:()=>Promise<T>):Promise<T> {
    if(passwordChecks>=4) throw new HttpError(429,'Tente novamente em instantes.','rate_limited');
    passwordChecks++;
    try { return await run(); } finally { passwordChecks--; }
  }
  const tickets = new Map<string, { user: string; account: string; session: string; until: number }>();
  const active = new Map<string, Set<AbortController>>();
  const accountActive = new Map<string, Set<AbortController>>();
  let draining = false;
  const cancelAccountRequests = (id: string) => { for (const controller of accountActive.get(id) || []) controller.abort(); };
  const cookie = '__Host-dsp';
  const cancelRequests = (id: string) => { for (const controller of active.get(id) || []) controller.abort(); };
  async function identity(headers: Headers): Promise<Identity | null> {
    const raw = headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(cookie + '='))?.slice(cookie.length + 1);
    if (!raw || raw.length > 128) return null;
    const hash = digest(raw);
    const { rows } = await db.query(`SELECT u.id,u.email,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.hash=$1 AND s.expires_at>now() AND NOT u.blocked`, [hash]);
    return rows[0] ? { ...rows[0], session: hash } : null;
  }
  async function session(c: Context, user: string) {
    const token = secret(), csrf = secret();
    await db.query("INSERT INTO sessions(hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')", [digest(token), user, csrf]);
    setCookie(c, cookie, token, { secure: true, httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 43200 });
    return csrf;
  }
  app.use('*', bodyLimit({ maxSize: 16 * 1024 * 1024 }));
  app.use('/api/auth/*',bodyLimit({maxSize:8192}));
  app.use('*', async (c, next) => {
    if (draining && c.req.path !== '/health') throw new HttpError(503,'Serviço em atualização. Tente novamente em instantes.','maintenance');
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer'); c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (c.req.path.startsWith('/api/') && !['GET','HEAD'].includes(c.req.method) && c.req.header('Origin') !== config.origin) throw new HttpError(403, 'Origem inválida.');
    await next();
  });
  app.onError((err, c) => {
    const known = err instanceof HttpError;
    if (!known) console.error('[gateway] request failed', { name: err.name });
    if (known && [429,503].includes(err.status)) c.header('Retry-After', '15');
    return c.json({ error: { message: known ? err.message : 'Não foi possível concluir a operação.', type: known ? err.code : 'internal_error', code: known ? err.code : 'internal_error' } }, (known ? err.status : 500) as any);
  });
  app.get('/', c => c.html(panelPage));
  app.get('/health', async c => { await db.query('SELECT 1'); return c.json({ status: draining ? 'draining' : 'ok' }, draining ? 503 : 200); });
  app.get('/api/auth/state', async c => c.json({ setupRequired: !(await db.query('SELECT id FROM setup WHERE id=1')).rows.length }));
  app.post('/api/auth/setup', async c => {
    limits.take('setup', 10);
    const body = await c.req.json();
    if (typeof body.token !== 'string' || body.token.length>128 || !equal(body.token, config.bootstrap)) throw new HttpError(403, 'Token inválido.');
    const address = email(body.email), hash = await passwordCheck(()=>hashPassword(password(body.password))), id = randomUUID();
    const result = await db.query(`WITH claimed AS (INSERT INTO setup(id) VALUES(1) ON CONFLICT DO NOTHING RETURNING id)
      INSERT INTO users(id,email,password_hash,role) SELECT $1,$2,$3,'admin' FROM claimed RETURNING id`, [id, address, hash]);
    if (!result.rows.length) throw new HttpError(409, 'A configuração inicial já foi concluída.');
    await ensureAccounts(db,id);
    await audit(db, id, 'setup'); return c.json({ csrf: await session(c, id) });
  });
  app.post('/api/auth/login', async c => {
    limits.take('logins', 100, 60_000);
    const body = await c.req.json(), address = email(body.email);
    limits.take('login:' + address, 10);
    const value = password(body.password);
    const user = (await db.query('SELECT * FROM users WHERE email=$1', [address])).rows[0];
    // Perform a password hash even for unknown accounts to reduce timing differences.
    const valid = await passwordCheck(async()=>user?.password_hash ? verifyPassword(user.password_hash, value) : (await hashPassword(value), false));
    if (!valid || user.blocked) throw new HttpError(401, 'Email ou senha inválidos.');
    await audit(db, user.id, 'login'); return c.json({ csrf: await session(c, user.id) });
  });
  app.post('/api/auth/redeem', async c => {
    limits.take('redeem', 30);
    const body = await c.req.json();
    if (typeof body.token !== 'string' || body.token.length > 128) throw new HttpError(400, 'Link inválido.');
    const hash = await passwordCheck(()=>hashPassword(password(body.password)));
    const result = await db.query(`WITH claimed AS (UPDATE links SET used_at=now() WHERE hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id)
      UPDATE users SET password_hash=$2 WHERE id IN (SELECT user_id FROM claimed) AND NOT blocked RETURNING id`, [digest(body.token), hash]);
    if (!result.rows.length) throw new HttpError(400, 'Link inválido, expirado ou já utilizado.');
    const id = result.rows[0].id;
    await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await db.query('UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    cancelRequests(id); await workers.stopUser(id);
    await audit(db, id, 'password_changed'); return c.json({ csrf: await session(c, id) });
  });
  app.use('/api/*', async (c, next) => {
    const who = await identity(c.req.raw.headers);
    if (!who) throw new HttpError(401, 'Entre no painel.');
    if (!['GET','HEAD'].includes(c.req.method) && !equal(c.req.header('X-CSRF-Token') || '', who.csrf)) throw new HttpError(403, 'Atualize a página e tente novamente.');
    c.set('identity', who); await next();
  });
  app.post('/api/auth/logout', async c => {
    const who = c.get('identity');
    await db.query('DELETE FROM sessions WHERE hash=$1', [who.session]); workers.cancelSession(who.session);
    deleteCookie(c, cookie, { path: '/', secure: true }); return c.json({ ok: true });
  });
  app.get('/api/me', c => { const { id, email, role, csrf } = c.get('identity'); return c.json({ id, email, role, csrf }); });
  async function accountFor(c: Context<Env>) {
    const provider = c.req.param('provider') || 'deepseek';
    if (!providers.includes(provider as any)) throw new HttpError(404,'Provedor não encontrado.');
    const user = c.get('identity').id;
    await ensureAccounts(db,user);
    return (await db.query('SELECT id,user_id,provider FROM provider_accounts WHERE user_id=$1 AND provider=$2',[user,provider])).rows[0];
  }
  app.get('/api/me/accounts', async c => {
    await ensureAccounts(db,c.get('identity').id);
    const rows = (await db.query('SELECT id,provider FROM provider_accounts WHERE user_id=$1 ORDER BY provider',[c.get('identity').id])).rows;
    return c.json({accounts:await Promise.all(rows.map(async a => ({...a,name:providerNames[a.provider]??a.provider,...await workers.status(a.id),models:await workers.models(a.id),manualLoginConfirmation:manualLoginProviders.has(a.provider)})))});
  });
  app.get('/api/me/accounts/:provider/status', async c => c.json({...await workers.status((await accountFor(c)).id),models:await workers.models((await accountFor(c)).id)}));
  app.get('/api/me/status', async c => c.json(await workers.status(c.get('identity').id)));
  app.get('/api/me/keys', async c => c.json({ keys: (await db.query('SELECT id,name,prefix,created_at,revoked_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC', [c.get('identity').id])).rows }));
  app.post('/api/me/keys', async c => {
    const who = c.get('identity'); limits.take('keys:' + who.id, 20);
    await ensureAccounts(db,who.id);
    const accounts = (await db.query('SELECT id FROM provider_accounts WHERE user_id=$1',[who.id])).rows;
    const connected = await Promise.all(accounts.map(async a => !workers.isLoggingIn(a.id) && (await workers.status(a.id)).accountState === 'authenticated'));
    if (!connected.some(Boolean)) throw new HttpError(409, 'Conecte uma conta antes de gerar uma chave.');
    const body = await c.req.json();
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new HttpError(400, 'Informe um nome de até 80 caracteres.');
    const key = 'dsp_' + secret(), id = randomUUID();
    await db.query('INSERT INTO api_keys(id,user_id,hash,name,prefix) VALUES($1,$2,$3,$4,$5)', [id, who.id, digest(key), body.name.trim(), key.slice(0,12)]);
    await audit(db, who.id, 'key_created', id); return c.json({ id, key }, 201);
  });
  app.delete('/api/me/keys/:id', async c => {
    const who = c.get('identity');
    const result = await db.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING id', [uuid(c.req.param('id')), who.id]);
    if (!result.rows.length) throw new HttpError(404, 'Chave não encontrada.');
    cancelRequests(who.id); await audit(db, who.id, 'key_revoked', result.rows[0].id); return c.json({ ok: true });
  });
  app.on('POST', ['/api/me/connection/:action','/api/me/accounts/:provider/connection/:action'], async c => {
    const action = c.req.param('action') || '', who = c.get('identity'), account = await accountFor(c);
    if (!['connect','cancel','recover','disconnect','finish'].includes(action)) throw new HttpError(404, 'Ação inválida.');
    limits.take('operation:' + who.id, 15, 60_000);
    if (action === 'cancel') { workers.cancel(account.id, who.session); return c.json({ ok: true }); }
    if (action === 'finish') workers.remote(account.id, who.session);
    const running = await db.query("SELECT id FROM operations WHERE account_id=$1 AND status='running'", [account.id]);
    if (running.rows.length) throw new HttpError(409, 'Aguarde a operação atual.');
    const id = randomUUID();
    try { await db.query("INSERT INTO operations(id,user_id,action,status,account_id) VALUES($1,$2,$3,'running',$4)", [id,who.id,action,account.id]); }
    catch (error: any) { if(error.code==='23505') throw new HttpError(409,'Aguarde a operação atual.'); throw error; }
    void (async () => {
      try {
        const current = await identity(c.req.raw.headers);
        if (!current) throw new HttpError(401, 'Sessão encerrada.');
        if (action === 'connect') await workers.connect(account.id, who.session);
        else if (action === 'finish') await workers.finishLogin(account.id, who.session);
        else { cancelAccountRequests(account.id); await workers.action(account.id, action as 'recover' | 'disconnect'); }
        if (!await identity(c.req.raw.headers)) { workers.cancel(account.id,who.session); await workers.stopAccount(account.id); throw new HttpError(401,'Sessão encerrada.'); }
        await audit(db, who.id, action);
        await db.query("UPDATE operations SET status='done',updated_at=now() WHERE id=$1", [id]);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error('[gateway] operation failed', { action, account: account.id, error: err instanceof Error ? err.message : String(err) });
        const message = err instanceof HttpError ? err.message
          : `Não foi possível concluir "${action}": ${err instanceof Error ? err.message.slice(0, 200) : 'erro inesperado'}. Clique em "Recuperar navegador" e tente novamente.`;
        await db.query("UPDATE operations SET status='failed',error=$2,updated_at=now() WHERE id=$1", [id, message]);
      }
    })().catch(() => console.error('[gateway] operation persistence failed'));
    return c.json({ operationId: id }, 202);
  });
  app.get('/api/me/operations/:id', async c => {
    const op = (await db.query('SELECT id,action,status,error FROM operations WHERE id=$1 AND user_id=$2', [uuid(c.req.param('id')),c.get('identity').id])).rows[0];
    if (!op) throw new HttpError(404, 'Operação não encontrada.'); return c.json(op);
  });
  app.on('POST', ['/api/me/remote-ticket','/api/me/accounts/:provider/remote-ticket'], async c => {
    const who = c.get('identity'), account = await accountFor(c); workers.remote(account.id, who.session);
    for (const [key, value] of tickets) if (value.until < Date.now() || value.session === who.session) tickets.delete(key);
    const token = secret(); tickets.set(digest(token), { user: who.id, account:account.id, session: who.session, until: Date.now()+60_000 });
    return c.json({ ticket: token });
  });
  app.use('/api/admin/*', async (c, next) => { if (c.get('identity').role !== 'admin') throw new HttpError(403, 'Acesso administrativo necessário.'); await next(); });
  app.get('/api/admin/users', async c => c.json({ users: (await db.query('SELECT id,email,role,blocked,created_at FROM users ORDER BY created_at DESC')).rows }));
  app.get('/api/admin/status', async c => { await db.query('SELECT 1'); return c.json({database:'available',...workers.metrics()}); });
  app.get('/api/admin/audit', async c => c.json({ events: (await db.query('SELECT actor_id,action,subject_id,created_at FROM audit ORDER BY id DESC LIMIT 100')).rows }));
  app.post('/api/admin/invite', async c => {
    const address = email((await c.req.json()).email), id = randomUUID();
    const existing = (await db.query('SELECT id,password_hash FROM users WHERE email=$1', [address])).rows[0];
    if (existing?.password_hash) throw new HttpError(409, 'Usuário já cadastrado.');
    if (!existing) await db.query("INSERT INTO users(id,email,role) VALUES($1,$2,'user')", [id,address]);
    await ensureAccounts(db,existing?.id || id);
    return createLink(c, existing?.id || id, 'invite');
  });
  async function createLink(c: Context<Env>, id: string, kind: string) {
    const token = secret();
    await db.query('UPDATE links SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [id]);
    await db.query("INSERT INTO links(hash,user_id,kind,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [digest(token),id,kind]);
    await audit(db,c.get('identity').id,kind,id);
    return c.json({ url: config.origin + '/#token=' + token, expiresInHours: 24 });
  }
  app.post('/api/admin/users/:id/reset', async c => {
    const id = uuid(c.req.param('id'));
    if (!(await db.query('SELECT id FROM users WHERE id=$1 AND NOT blocked',[id])).rows.length) throw new HttpError(404,'Usuário indisponível.');
    await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await db.query('UPDATE api_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[id]);
    cancelRequests(id); await workers.stopUser(id);
    return createLink(c,id,'reset');
  });
  app.post('/api/admin/users/:id/block', async c => {
    const id = uuid(c.req.param('id')), who = c.get('identity');
    if (id === who.id) throw new HttpError(409, 'Você não pode bloquear sua própria conta.');
    const blocked = (await c.req.json()).blocked;
    if (typeof blocked !== 'boolean') throw new HttpError(400, 'Estado inválido.');
    if (!(await db.query('UPDATE users SET blocked=$2 WHERE id=$1 RETURNING id', [id,blocked])).rows.length) throw new HttpError(404, 'Usuário não encontrado.');
    if (blocked) {
      await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      cancelRequests(id); await workers.stopUser(id);
    }
    await audit(db,who.id,blocked?'user_blocked':'user_unblocked',id); return c.json({ ok: true });
  });
  async function apiIdentity(c: Context) {
    const auth = c.req.header('Authorization'), key = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('X-API-Key');
    if (!key || !/^dsp_[\w-]{43}$/.test(key)) throw new HttpError(401, 'Chave inválida.', 'invalid_api_key');
    const user = (await db.query('SELECT u.id,k.id AS key_id FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.hash=$1 AND k.revoked_at IS NULL AND NOT u.blocked', [digest(key)])).rows[0];
    if (!user) throw new HttpError(401, 'Chave inválida.', 'invalid_api_key');
    return user;
  }
  app.on(['GET','POST'], ['/v1/models','/v1/chat/completions'], async c => {
    if ((c.req.path.endsWith('models') && c.req.method !== 'GET') || (c.req.path.endsWith('completions') && c.req.method !== 'POST')) throw new HttpError(405, 'Método inválido.');
    const user = await apiIdentity(c);
    limits.take('api:' + user.id, 60, 60_000);
    await ensureAccounts(db,user.id);
    const accounts = (await db.query('SELECT id,provider FROM provider_accounts WHERE user_id=$1 ORDER BY provider',[user.id])).rows;
    const catalogs = await Promise.all(accounts.map(async a => ({...a,models:await workers.models(a.id),manualLoginConfirmation:manualLoginProviders.has(a.provider)})));
    if (c.req.path.endsWith('models')) return c.json({object:'list',data:catalogs.flatMap(a => a.models.map((id: string) => ({id,object:'model',created:0,owned_by:a.provider})))});
    let body: any;
    try { body = await c.req.json(); } catch { throw new HttpError(400,'JSON inválido.','invalid_request_error'); }
    const account = catalogs.find(a => a.models.includes(body?.model));
    if (!account) throw new HttpError(400,'Modelo desconhecido ou indisponível.','invalid_model');
    if (workers.isLoggingIn(account.id)) throw new HttpError(409, 'Conclua o login pelo painel.', account.provider + '_login_in_progress');
    const controller = new AbortController(), requestSet = active.get(user.id) || new Set<AbortController>();
    requestSet.add(controller); active.set(user.id,requestSet);
    const accountSet = accountActive.get(account.id) || new Set<AbortController>();
    accountSet.add(controller); accountActive.set(account.id,accountSet);
    const abort = () => controller.abort(); c.req.raw.signal.addEventListener('abort',abort,{once:true});
    if (c.req.raw.signal.aborted) abort();
    let release: (() => void) | undefined;
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; release?.(); requestSet.delete(controller); if (!requestSet.size) active.delete(user.id); accountSet.delete(controller); if (!accountSet.size) accountActive.delete(account.id); c.req.raw.signal.removeEventListener('abort',abort); };
    try {
      release = await workers.queue(account.id).acquire(controller.signal);
      await apiIdentity(c); // A queued request may have been revoked while waiting.
      if (workers.isLoggingIn(account.id)) throw new HttpError(409,'Conclua o login pelo painel.');
      const response = await workers.request(account.id,c.req.path,{ method:c.req.method, body:JSON.stringify(body), signal:controller.signal });
      if (!response?.body) throw new HttpError(502,'Navegador indisponível.');
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) { try { const item = await reader.read(); if (item.done) { cleanup(); out.close(); } else out.enqueue(item.value); } catch(error) { cleanup(); out.error(error); } },
        async cancel() { controller.abort(); await reader.cancel().catch(()=>{}); cleanup(); },
      });
      return new Response(stream,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type') || 'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
    } catch(err) { cleanup(); throw err; }
  });
  async function authorizeRemote(headers: Headers, token: string, origin: string) {
    if (origin !== config.origin) throw new HttpError(403,'Origem inválida.');
    const ticket = tickets.get(digest(token)); tickets.delete(digest(token));
    const who = await identity(headers);
    if (!who || !ticket || ticket.until < Date.now() || ticket.user !== who.id || ticket.session !== who.session) throw new HttpError(403,'Conexão expirada.');
    const account = (await db.query('SELECT id FROM provider_accounts WHERE id=$1 AND user_id=$2',[ticket.account,who.id])).rows[0];
    if (!account) throw new HttpError(403,'Conta indisponível.');
    return { id: account.id, session: who.session, ...workers.remote(account.id,who.session) };
  }
  return { app, identity, authorizeRemote, beginDrain: () => { draining = true; }, abortActive: () => { for (const id of active.keys()) cancelRequests(id); }, tick: () => workers.tick(async hash => !!(await db.query('SELECT s.hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=$1 AND s.expires_at>now() AND NOT u.blocked',[hash])).rows.length) };
}
