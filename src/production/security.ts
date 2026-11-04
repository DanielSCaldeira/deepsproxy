import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';

export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const workerToken = (id: string, master: string) => createHmac('sha256', master).update(id).digest('base64url');
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw new HttpError(400, 'Use uma senha de 12 a 256 caracteres.');
  return value;
}
export const hashPassword = (value: string) => argon2.hash(value, { type: argon2.argon2id });
export const verifyPassword = (hash: string, value: string) => argon2.verify(hash, value);
export function email(value: unknown): string {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new HttpError(400, 'Email inválido.');
  return value.trim().toLowerCase();
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new HttpError(400, 'Identificador inválido.');
  return value;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'request_error') { super(message); }
}

/** Fixed windows, bounded memory. Never use client supplied forwarding headers. */
export class RateLimit {
  private entries = new Map<string, { count: number; until: number }>();
  take(key: string, limit: number, period = 900_000): void {
    const now = Date.now();
    if (this.entries.size > 10_000) for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 20_000) throw new HttpError(429, 'Tente novamente mais tarde.', 'rate_limited');
      this.entries.set(key, entry = { count: 0, until: now + period });
    }
    if (++entry.count > limit) throw new HttpError(429, 'Tente novamente mais tarde.', 'rate_limited');
  }
}
