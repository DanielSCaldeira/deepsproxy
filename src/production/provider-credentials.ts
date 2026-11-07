import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from './database.ts';
import { HttpError } from './security.ts';

export const apiProviders = ['openrouter', 'nvidia'] as const;
export type ApiProvider = typeof apiProviders[number];
export function apiProvider(value: string): ApiProvider {
  if (!(apiProviders as readonly string[]).includes(value)) throw new HttpError(404, 'Provedor API não disponível.');
  return value as ApiProvider;
}
export class ProviderCredentials {
  constructor(private db: Database, private master?: string) {}
  get enabled() { return !!this.master; }
  private key() {
    if (!this.master) throw new HttpError(503, 'O administrador precisa configurar PROVIDER_CREDENTIALS_KEY.', 'credentials_unavailable');
    const key = Buffer.from(this.master, 'base64');
    if (key.length !== 32) throw new HttpError(503, 'Configuração de cifragem inválida.', 'credentials_unavailable');
    return key;
  }
  async list(user: string) {
    return (await this.db.query('SELECT id,provider,masked_suffix,validated_at,created_at,updated_at FROM provider_credentials WHERE user_id=$1 ORDER BY provider', [user])).rows;
  }
  async save(user: string, provider: ApiProvider, value: unknown) {
    if (typeof value !== 'string' || value.length < 16 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value) ||
      !(provider === 'nvidia' ? value.startsWith('nvapi-') : value.startsWith('sk-or-'))) throw new HttpError(400, 'Informe uma chave válida do provedor.');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([user, provider, 1])));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    await this.db.query(`INSERT INTO provider_credentials(id,user_id,provider,ciphertext,nonce,auth_tag,masked_suffix)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,provider) DO UPDATE SET
      ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,
      masked_suffix=EXCLUDED.masked_suffix,key_version=1,validated_at=NULL,updated_at=now()`,
      [randomUUID(),user,provider,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64'),value.slice(-4)]);
  }
  async load(user: string, provider: ApiProvider) {
    const key = this.key();
    const row = (await this.db.query('SELECT * FROM provider_credentials WHERE user_id=$1 AND provider=$2', [user,provider])).rows[0];
    if (!row) throw new HttpError(409, 'Cadastre a chave API pelo painel.', 'credentials_missing');
    try {
      if (row.key_version !== 1) throw new Error('version');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'base64'));
      decipher.setAAD(Buffer.from(JSON.stringify([user, provider, row.key_version])));
      decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
      return { id: row.id as string, revision: row.ciphertext as string, apiKey: Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')),decipher.final()]).toString('utf8') };
    } catch { throw new HttpError(503, 'Não foi possível abrir a credencial. Verifique a chave de cifragem.', 'credentials_unavailable'); }
  }
  async remove(user: string, provider: ApiProvider) { await this.db.query('DELETE FROM provider_credentials WHERE user_id=$1 AND provider=$2', [user,provider]); }
  async validated(user: string, provider: ApiProvider, revision: string) {
    await this.db.query('UPDATE provider_credentials SET validated_at=now() WHERE user_id=$1 AND provider=$2 AND ciphertext=$3', [user,provider,revision]);
  }
}
