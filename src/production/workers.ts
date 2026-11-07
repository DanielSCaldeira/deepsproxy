import { Mutex } from '../utils/mutex.ts';
import { UserQueue } from './queue.ts';
import { HttpError, workerToken } from './security.ts';
import type { ProductionConfig } from './config.ts';
import type { Database, ProviderAccount } from './database.ts';
import { DEEPSEEK_MODEL_IDS } from '../providers/catalog.ts';

const PROVISION_HINTS: Record<string, string> = {
  capacity_full: 'Todos os navegadores estão ocupados. Aguarde alguns minutos ou desconecte outra conta.',
  exited: 'O navegador encerrou ao iniciar. Clique em "Recuperar navegador"; se persistir, verifique os logs do provisioner (docker logs do serviço provisioner).',
  health_timeout: 'O navegador demorou demais para iniciar. Clique em "Recuperar navegador" em instantes.',
  create: 'O Docker recusou criar o navegador. Verifique se a imagem do worker foi construída (docker compose build worker-image).',
  start: 'O Docker não conseguiu iniciar o navegador. Verifique os logs do provisioner.',
};
/** Real cause from the provisioner plus what the user should do next. */
export function provisionMessage(status: number, body: any): string {
  const code = typeof body?.code === 'string' ? body.code : status === 429 ? 'capacity_full' : '';
  const detail = typeof body?.detail === 'string' ? body.detail : typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  const hint = PROVISION_HINTS[code] || 'Clique em "Recuperar navegador" e tente novamente; se persistir, verifique os logs do provisioner.';
  return `Não foi possível preparar o navegador${code ? ` (etapa: ${code})` : ''}: ${detail}. ${hint}`;
}
type Worker = { id: string; host: string; lastUsed: number; failures: number };
type Login = { session: string; until: number; release: () => void; close: () => void; finishing?: boolean };
export class Workers {
  readonly queues = new Map<string, UserQueue>();
  private accountRefs = new Map<string, ProviderAccount>();
  private workers = new Map<string, Worker>();
  private logins = new Map<string, Login>();
  private mutex = new Mutex();
  private snapshots = new Map<string, any>();
  private recoveryFailures = new Map<string, number>();
  private recoveryAfter = new Map<string, number>();
  constructor(private config: ProductionConfig, private db?: Database) {}
  metrics() { return { activeBrowsers:this.workers.size, capacity:this.config.maxWorkers, remoteLogins:this.logins.size }; }
  queue(id: string) {
    let queue = this.queues.get(id);
    if (!queue) this.queues.set(id, queue = new UserQueue());
    return queue;
  }
  async provision(action: string, id?: string): Promise<any> {
    const body = id ? JSON.stringify(await this.account(id)) : undefined;
    let response: Response;
    try {
      response = await fetch(`${this.config.provisioner}/${action}${id ? '/' + id : ''}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.config.provisionerToken}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'o provisioner não respondeu em 180s' : `o provisioner está inacessível (${error instanceof Error ? error.message : 'erro de rede'})`;
      console.error('[workers] provisioner unreachable', { action, reason });
      throw new HttpError(502, `Não foi possível preparar o navegador: ${reason}. Verifique se o serviço provisioner está em execução e tente novamente.`, 'browser_unavailable');
    }
    if (!response.ok) {
      const body: any = await response.json().catch(() => ({}));
      console.error('[workers] provisioner failed', { action, status: response.status, code: body?.code, detail: body?.detail || body?.error });
      throw new HttpError(response.status === 429 ? 503 : 502, provisionMessage(response.status, body), 'browser_unavailable');
    }
    return response.json();
  }
  private async account(id: string): Promise<ProviderAccount> {
    if (this.db) {
      const row = (await this.db.query('SELECT id,user_id,provider FROM provider_accounts WHERE id=$1',[id])).rows[0];
      if (!row) throw new HttpError(404,'Conta não encontrada.');
      this.accountRefs.set(id,row as ProviderAccount); return row as ProviderAccount;
    }
    return {id,user_id:id,provider:'deepseek'};
  }
  async models(id: string): Promise<string[]> {
    const account = await this.account(id);
    return this.snapshots.get(id)?.models || (account.provider === 'deepseek' ? [...DEEPSEEK_MODEL_IDS] : []);
  }
  async initialize() {
    if (this.db) for (const row of (await this.db.query('SELECT * FROM account_status')).rows) this.snapshots.set(row.account_id, {
      models: row.models, state: row.state, sessionSaved: row.session_saved, checkedAt: row.checked_at, suspendedUntil: row.suspended_until,
      authenticated: row.authenticated, originalMessage: row.provider_message,
    });
    const { workers } = await this.provision('list');
    for (const w of workers) {
      try {
        const account = await this.account(w.id);
        if (w.provider !== account.provider || w.owner !== account.user_id || w.contract !== '2' || !w.compatible) { await this.provision('stop',w.id); continue; }
        this.workers.set(w.id, { ...w, lastUsed: Date.now(), failures: 0 });
      } catch { /* Unknown resources are rejected; the provisioner validates ownership before removal. */ }
    }
  }
  async ensure(id: string): Promise<Worker> {
    return this.mutex.withLock(() => this.start(id));
  }
  private async start(id: string): Promise<Worker> {
      const existing = this.workers.get(id);
      if (existing) { existing.lastUsed = Date.now(); return existing; }
      if (this.workers.size >= this.config.maxWorkers) throw new HttpError(503, 'Capacidade ocupada. Tente novamente em instantes.', 'capacity_full');
      const worker = await this.provision('start', id);
      const item = { id, host: worker.host, lastUsed: Date.now(), failures: 0 };
      this.workers.set(id, item);
      return item;
  }
  async request(id: string, path: string, init: RequestInit = {}, start = true) {
    const worker = start ? await this.ensure(id) : this.workers.get(id);
    if (!worker) return null;
    try {
      return await fetch(`http://${worker.host}:3000${path}`, {
        ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken(id, this.config.workerMaster)}` },
        signal: init.signal || AbortSignal.timeout(30_000),
      });
    } catch(error) {
      if(init.signal?.aborted) throw error;
      throw new HttpError(502,'Navegador indisponível. Tente recuperar a conexão pelo painel.','browser_unavailable');
    }
  }
  async status(id: string): Promise<any> {
    const observedWorker = this.workers.get(id);
    let snapshot = this.snapshots.get(id) || { state: 'not_initialized', sessionSaved: false, checkedAt: null };
    let runtimeState = this.workers.has(id) ? 'running' : 'sleeping';
    if (runtimeState === 'running' && (!this.queue(id).active || this.logins.has(id))) {
      try {
        const response = await this.request(id, '/api/status', {}, false);
        if (!response?.ok) throw new Error('status');
        const status = await response.json();
        const raw = status.account || status.deepseek;
        if (!raw) throw new Error('Invalid account status');
        snapshot = { state: raw.state, sessionSaved: !!raw.sessionSaved, checkedAt: raw.checkedAt, suspendedUntil: raw.suspendedUntil || null,
          authenticated: raw.authenticated === true || raw.state === 'authenticated',
          originalMessage: typeof raw.originalMessage === 'string' ? raw.originalMessage.slice(0, 4096) : null,
          confirmationRequired: raw.confirmationRequired === true, nextAllowedAt: raw.nextAllowedAt || null };
        snapshot.models = this.snapshots.get(id)?.models;
        if (raw.state === 'authenticated') {
          const catalog = await this.request(id,'/v1/models',{},false);
          if (catalog?.ok) {
            const data = (await catalog.json()).data;
            const account = await this.account(id);
            if (Array.isArray(data)) snapshot.models = data.map((m: any) => m.id).filter((m: unknown) => typeof m === 'string' && (account.provider === 'deepseek' ? m.startsWith('deepseek-') : m.startsWith(account.provider + '/')));
          }
        }
        if (this.workers.get(id) !== observedWorker) return this.status(id);
        await this.remember(id, snapshot);
      } catch {
        if (this.workers.get(id) !== observedWorker) return this.status(id);
        runtimeState = 'unavailable';
      }
    }
    return { ...snapshot, accountState: snapshot.state, state: runtimeState === 'running' ? snapshot.state : runtimeState,
      runtimeState, busy: this.queue(id).active, loginActive: this.logins.has(id), queueDepth: this.queue(id).depth };
  }
  private async remember(id: string, snapshot: any) {
    this.snapshots.set(id, snapshot);
    if (this.db) {
      const account = await this.account(id);
      await this.db.query(`INSERT INTO account_status(user_id,account_id,state,session_saved,checked_at,suspended_until,models,authenticated,provider_message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(account_id) DO UPDATE SET state=$3,session_saved=$4,checked_at=$5,suspended_until=$6,models=COALESCE($7,account_status.models),authenticated=$8,provider_message=$9`,
      [account.user_id,id,snapshot.state,snapshot.sessionSaved,snapshot.checkedAt,snapshot.suspendedUntil || null,snapshot.models ? JSON.stringify(snapshot.models) : null,snapshot.authenticated === true,snapshot.originalMessage || null]);
    }
  }
  async connect(id: string, session: string) {
    const existing=this.logins.get(id);
    if(existing && existing.until<Date.now()) this.cancel(id);
    else if(existing?.session===session) return;
    else if(existing) throw new HttpError(409, 'Já existe um login em andamento. Use Recuperar navegador para encerrá-lo.');
    const release = await this.queue(id).acquire(undefined, 120_000);
    try {
      const response = await this.request(id, '/internal/connect', { method: 'POST' });
      if (!response?.ok) {
        const detail = response ? ((await response.text().catch(() => '')).slice(0, 300) || `HTTP ${response.status}`) : 'navegador não iniciado';
        console.error('[workers] remote login failed', { id, status: response?.status, detail });
        throw new HttpError(502, `O navegador iniciou, mas não abriu a tela de login: ${detail}. Clique em "Recuperar navegador" e conecte novamente.`, 'browser_unavailable');
      }
      this.logins.set(id, { session, until: Date.now() + 30 * 60_000, release, close: () => {} });
    } catch (error) { release(); throw error; }
  }
  remote(id: string, session: string) {
    const login = this.logins.get(id);
    if (!login || login.session !== session || login.until < Date.now()) throw new HttpError(403, 'Abra uma nova conexão pelo painel.');
    return { login, worker: this.workers.get(id)! };
  }
  async finishLogin(id: string, session: string) {
    const { login } = this.remote(id, session);
    if (login.finishing) throw new HttpError(409, 'A confirmação do login está em andamento.');
    login.finishing = true;
    try {
      const response = await this.request(id, '/internal/finish-login', {
        method: 'POST', signal: AbortSignal.timeout(120_000),
      }, false);
      if (!response?.ok) throw new HttpError(response?.status === 409 ? 409 : 502,
        'O login ainda não foi confirmado. Conclua o acesso ao chat e clique em Concluir login novamente.', 'login_required');
      if (this.logins.get(id) !== login) throw new HttpError(409, 'A conexão de login foi encerrada. Conecte novamente pelo painel.');
      const status = await this.status(id);
      const confirmed = status.accountState === 'authenticated' || (['suspended','rate_limited'].includes(status.accountState) && status.authenticated === true);
      if (!confirmed || !status.sessionSaved) throw new HttpError(409,
        'A sessão ainda não foi validada. Mantenha a tela aberta e tente concluir o login novamente.', 'login_required');
      this.cancel(id, session);
    } finally { login.finishing = false; }
  }
  cancel(id: string, session?: string) {
    const login = this.logins.get(id);
    if (login && (!session || session === login.session)) {
      this.logins.delete(id); login.close(); login.release();
    }
  }
  cancelAllLogins() { for (const id of this.logins.keys()) this.cancel(id); }
  cancelSession(session: string) { for (const [id, login] of this.logins) if (login.session === session) this.cancel(id); }
  isLoggingIn(id: string) { return this.logins.has(id); }
  async action(id: string, action: 'recover' | 'disconnect') {
    this.cancel(id);
    const release = await this.queue(id).acquire();
    try {
      await this.mutex.withLock(async () => {
        await this.provision(action === 'disconnect' ? 'purge' : 'stop', id);
        this.workers.delete(id);
      });
      if (action === 'recover') await this.ensure(id);
      else await this.remember(id, { state: 'login_required', sessionSaved: false, checkedAt: new Date().toISOString(), suspendedUntil: null, models: [] });
      this.recoveryFailures.delete(id);
    } finally { release(); }
  }
  async stopAccount(id: string) { this.cancel(id); await this.mutex.withLock(async () => { await this.provision('stop', id); this.workers.delete(id); }); }
  // Frees an idle browser early, like the idle sweep: the saved session stays in the profile volume
  // and the next request starts the browser again. Logins and queued calls keep their browser.
  async release(id: string) {
    return this.mutex.withLock(async () => {
      if (!this.workers.has(id) || this.logins.has(id) || this.queue(id).active) return false;
      await this.provision('stop', id); this.workers.delete(id);
      return true;
    });
  }
  async stopUser(id: string) {
    const ids = this.db ? (await this.db.query('SELECT id FROM provider_accounts WHERE user_id=$1',[id])).rows.map(r => r.id) : [id];
    await Promise.all(ids.map(account => this.stopAccount(account)));
  }
  async tick(validSession: (hash: string) => Promise<boolean>) {
    for (const [id, login] of this.logins) {
      try {
        if (login.until < Date.now() || !await validSession(login.session)) { this.cancel(id); continue; }
        if (login.finishing) continue;
        const response = await this.request(id, '/internal/confirm', { method: 'POST' }, false);
        if (response?.ok) this.cancel(id);
      } catch { /* A temporary browser failure is recovered below. */ }
    }
    for (const [id, worker] of this.workers) {
      if (this.queue(id).active) continue;
      if (Date.now() - worker.lastUsed > 900_000) {
        await this.mutex.withLock(async () => {
          if (this.queue(id).active || Date.now() - worker.lastUsed <= 900_000) return;
          await this.provision('stop',id); this.workers.delete(id);
        });
        continue;
      }
      if ((this.recoveryAfter.get(id) || 0)>Date.now()) continue;
      try {
        const response = await this.request(id, '/health', {}, false);
        if (!response?.ok) throw new Error('health');
        const status=await this.status(id);
        if (this.workers.get(id) !== worker) continue;
        if (status.confirmationRequired) continue;
        if (status.runtimeState==='unavailable' || ['unavailable','not_initialized'].includes(status.accountState)) throw new Error('browser');
        this.recoveryFailures.delete(id); this.recoveryAfter.delete(id);
      } catch {
        if (this.workers.get(id) !== worker) continue;
        const failures = (this.recoveryFailures.get(id) || 0) + 1;
        this.recoveryFailures.set(id, failures);
        if (failures <= 3) {
          this.recoveryAfter.set(id,Date.now()+5000*2**(failures-1));
          await this.mutex.withLock(async () => {
            if(this.workers.get(id)!==worker || this.queue(id).active || this.logins.has(id)) return;
            await this.provision('stop',id); this.workers.delete(id);
            await this.start(id).catch(() => undefined);
          });
        }
      }
    }
  }
}
