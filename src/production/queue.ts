import { HttpError } from './security.ts';

/** Owns the whole upstream response lifetime, rather than only header capture. */
export class UserQueue {
  private busy = false;
  private waiting: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup: () => void }> = [];
  get active() { return this.busy; }
  get depth() { return this.waiting.length; }
  acquire(signal?: AbortSignal, timeout = 120_000): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new HttpError(499, 'Chamada cancelada.'));
    if (!this.busy) { this.busy = true; return Promise.resolve(this.lease()); }
    if (this.waiting.length >= 3) return Promise.reject(new HttpError(429, 'Fila cheia.', 'queue_full'));
    return new Promise((resolve, reject) => {
      const remove = (error: Error) => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) this.waiting.splice(index, 1);
        item.cleanup(); reject(error);
      };
      const abort = () => remove(new HttpError(499, 'Chamada cancelada.'));
      const timer = setTimeout(() => remove(new HttpError(429, 'Tempo de espera excedido.', 'queue_timeout')), timeout);
      const item = { resolve, reject, timer, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      this.waiting.push(item);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private release = () => {
    const next = this.waiting.shift();
    if (next) { next.cleanup(); next.resolve(this.lease()); }
    else this.busy = false;
  };
  private lease() { let released=false; return () => { if(!released) { released=true; this.release(); } }; }
}
