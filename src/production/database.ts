import { Pool, type QueryResultRow } from 'pg';

export interface Database {
  query<T extends QueryResultRow = any>(sql: string, values?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
}
export function connectDatabase(url: string) { return new Pool({ connectionString: url, max: 10 }); }

export async function migrate(db: Database) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text,
      role text NOT NULL CHECK (role IN ('admin','user')), blocked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS setup (id integer PRIMARY KEY CHECK(id=1), completed_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (
      hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), csrf text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS links (
      hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('invite','reset')),
      expires_at timestamptz NOT NULL, used_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), hash text NOT NULL UNIQUE,
      name text NOT NULL, prefix text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS operations (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), action text NOT NULL,
      status text NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit (
      id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
      subject_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS account_status (
      user_id uuid PRIMARY KEY REFERENCES users(id), state text NOT NULL,
      session_saved boolean NOT NULL DEFAULT false, checked_at timestamptz,
      suspended_until text
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS operations_user ON operations(user_id, created_at);
    INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
  `);
  await db.query(`BEGIN;
    CREATE TABLE IF NOT EXISTS provider_accounts (
      id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
      provider text NOT NULL CHECK(provider IN ('deepseek','qwen')),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,provider)
    );
    INSERT INTO provider_accounts(id,user_id,provider) SELECT id,id,'deepseek' FROM users ON CONFLICT DO NOTHING;
    INSERT INTO provider_accounts(id,user_id,provider) SELECT gen_random_uuid(),id,'qwen' FROM users ON CONFLICT(user_id,provider) DO NOTHING;
    ALTER TABLE account_status ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES provider_accounts(id);
    ALTER TABLE account_status ADD COLUMN IF NOT EXISTS models jsonb;
    UPDATE account_status SET account_id=user_id WHERE account_id IS NULL;
    ALTER TABLE account_status DROP CONSTRAINT IF EXISTS account_status_pkey;
    ALTER TABLE account_status ALTER COLUMN account_id SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS account_status_account ON account_status(account_id);
    ALTER TABLE operations ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES provider_accounts(id);
    UPDATE operations SET account_id=user_id WHERE account_id IS NULL;
    ALTER TABLE operations ALTER COLUMN account_id SET NOT NULL;
    DROP INDEX IF EXISTS one_running_operation;
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_operation_account ON operations(account_id) WHERE status='running';
    INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
    COMMIT;`);
  await db.query(`BEGIN;
    ALTER TABLE provider_accounts DROP CONSTRAINT IF EXISTS provider_accounts_provider_check;
    ALTER TABLE provider_accounts ADD CONSTRAINT provider_accounts_provider_check CHECK(provider IN ('deepseek','qwen','chatgpt','ernie'));
    INSERT INTO provider_accounts(id,user_id,provider) SELECT gen_random_uuid(),id,'chatgpt' FROM users ON CONFLICT(user_id,provider) DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
    COMMIT;`);
  // Migrations rerun at every start: the provider constraint above must list every provider.
  await db.query(`BEGIN;
    INSERT INTO provider_accounts(id,user_id,provider) SELECT gen_random_uuid(),id,'ernie' FROM users ON CONFLICT(user_id,provider) DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
    COMMIT;`);
  // Interrupted operations must not remain in progress after gateway replacement.
  await db.query(`
    ALTER TABLE account_status ADD COLUMN IF NOT EXISTS authenticated boolean NOT NULL DEFAULT false;
    ALTER TABLE account_status ADD COLUMN IF NOT EXISTS provider_message text;
    UPDATE account_status SET authenticated=true WHERE state='authenticated' AND NOT authenticated;
    INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
  `);
  await db.query("UPDATE operations SET status='failed', error='Serviço reiniciado. Tente novamente.', updated_at=now() WHERE status='running'");
}

export async function audit(db: Database, actor: string | null, action: string, subject: string | null = null) {
  await db.query('INSERT INTO audit(actor_id,action,subject_id) VALUES($1,$2,$3)', [actor, action, subject]);
}

export const providers = ['deepseek', 'qwen', 'chatgpt', 'ernie'] as const;
export type Provider = typeof providers[number];
export type ProviderAccount = { id: string; user_id: string; provider: Provider };
export async function ensureAccounts(db: Database, user: string) {
  await db.query("INSERT INTO provider_accounts(id,user_id,provider) VALUES(gen_random_uuid(),$1,'chatgpt') ON CONFLICT(user_id,provider) DO NOTHING", [user]);
  await db.query("INSERT INTO provider_accounts(id,user_id,provider) VALUES($1,$1,'deepseek') ON CONFLICT(user_id,provider) DO NOTHING", [user]);
  await db.query("INSERT INTO provider_accounts(id,user_id,provider) VALUES(gen_random_uuid(),$1,'qwen') ON CONFLICT(user_id,provider) DO NOTHING", [user]);
  await db.query("INSERT INTO provider_accounts(id,user_id,provider) VALUES(gen_random_uuid(),$1,'ernie') ON CONFLICT(user_id,provider) DO NOTHING", [user]);
}
