import { Mutex } from '../utils/mutex.ts';
import { UserQueue } from './queue.ts';
import { HttpError, workerToken } from './security.ts';
import type { ProductionConfig } from './config.ts';
import type { Database } from './database.ts';

type Worker = { id: string; host: string; lastUsed: number; failures: number };
type Login = { session: string; until: number; release: () => void; close: () => void };
export class Workers {
  readonly queues = new Map<string, UserQueue>();
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
    const response = await fetch(`${this.config.provisioner}/${action}${id ? '/' + id : ''}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.config.provisionerToken}` }, signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new HttpError(response.status === 429 ? 503 : 502, 'Não foi possível preparar o navegador.', 'browser_unavailable');
    return response.json();
  }
  async initialize() {
    if (this.db) for (const row of (await this.db.query('SELECT * FROM account_status')).rows) this.snapshots.set(row.user_id, {
      state: row.state, sessionSaved: row.session_saved, checkedAt: row.checked_at, suspendedUntil: row.suspended_until,
    });
    const { workers } = await this.provision('list');
    for (const w of workers) this.workers.set(w.id, { ...w, lastUsed: Date.now(), failures: 0 });
  }
  async ensure(id: string): Promise<Worker> {
    return this.mutex.withLock(async () => {
      const existing = this.workers.get(id);
      if (existing) { existing.lastUsed = Date.now(); return existing; }
      if (this.workers.size >= this.config.maxWorkers) throw new HttpError(503, 'Capacidade ocupada. Tente novamente em instantes.', 'capacity_full');
      const worker = await this.provision('start', id);
      const item = { id, host: worker.host, lastUsed: Date.now(), failures: 0 };
      this.workers.set(id, item);
      return item;
    });
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
  async status(id: string) {
    let snapshot = this.snapshots.get(id) || { state: 'not_initialized', sessionSaved: false, checkedAt: null };
    let runtimeState = this.workers.has(id) ? 'running' : 'sleeping';
    if (runtimeState === 'running' && (!this.queue(id).active || this.logins.has(id))) {
      try {
        const response = await this.request(id, '/api/status', {}, false);
        if (!response?.ok) throw new Error('status');
        const raw = (await response.json()).deepseek;
        snapshot = { state: raw.state, sessionSaved: !!raw.sessionSaved, checkedAt: raw.checkedAt, suspendedUntil: raw.suspendedUntil || null };
        await this.remember(id, snapshot);
      } catch { runtimeState = 'unavailable'; }
    }
    return { ...snapshot, accountState: snapshot.state, state: runtimeState === 'running' ? snapshot.state : runtimeState,
      runtimeState, busy: this.queue(id).active, loginActive: this.logins.has(id), queueDepth: this.queue(id).depth };
  }
  private async remember(id: string, snapshot: any) {
    this.snapshots.set(id, snapshot);
    if (this.db) await this.db.query(`INSERT INTO account_status(user_id,state,session_saved,checked_at,suspended_until) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET state=$2,session_saved=$3,checked_at=$4,suspended_until=$5`,
      [id,snapshot.state,snapshot.sessionSaved,snapshot.checkedAt,snapshot.suspendedUntil || null]);
  }
  async connect(id: string, session: string) {
    const existing=this.logins.get(id);
    if(existing && existing.until<Date.now()) this.cancel(id);
    else if(existing?.session===session) return;
    else if(existing) throw new HttpError(409, 'Já existe um login em andamento. Use Recuperar navegador para encerrá-lo.');
    const release = await this.queue(id).acquire(undefined, 120_000);
    try {
      const response = await this.request(id, '/internal/connect', { method: 'POST' });
      if (!response?.ok) throw new Error('connect');
      this.logins.set(id, { session, until: Date.now() + 30 * 60_000, release, close: () => {} });
    } catch (error) { release(); throw error; }
  }
  remote(id: string, session: string) {
    const login = this.logins.get(id);
    if (!login || login.session !== session || login.until < Date.now()) throw new HttpError(403, 'Abra uma nova conexão pelo painel.');
    return { login, worker: this.workers.get(id)! };
  }
  cancel(id: string, session?: string) {
    const login = this.logins.get(id);
    if (login && (!session || session === login.session)) {
      this.logins.delete(id); login.close(); login.release();
    }
  }
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
      else await this.remember(id, { state: 'login_required', sessionSaved: false, checkedAt: new Date().toISOString(), suspendedUntil: null });
      this.recoveryFailures.delete(id);
    } finally { release(); }
  }
  async stopUser(id: string) { this.cancel(id); await this.mutex.withLock(async () => { await this.provision('stop', id); this.workers.delete(id); }); }
  async tick(validSession: (hash: string) => Promise<boolean>) {
    for (const [id, login] of this.logins) {
      try {
        if (login.until < Date.now() || !await validSession(login.session)) { this.cancel(id); continue; }
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
        if (status.runtimeState==='unavailable' || ['unavailable','not_initialized'].includes(status.accountState)) throw new Error('browser');
        this.recoveryFailures.delete(id); this.recoveryAfter.delete(id);
      } catch {
        const failures = (this.recoveryFailures.get(id) || 0) + 1;
        this.recoveryFailures.set(id, failures);
        if (failures <= 3) {
          this.recoveryAfter.set(id,Date.now()+5000*2**(failures-1));
          let stopped=false;
          await this.mutex.withLock(async () => {
            if(this.queue(id).active) return;
            await this.provision('stop',id); this.workers.delete(id); stopped=true;
          });
          if(stopped) await this.ensure(id).catch(() => undefined);
        }
      }
    }
  }
}
