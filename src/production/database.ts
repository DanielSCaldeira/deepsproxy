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
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_operation ON operations(user_id) WHERE status='running';
    INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
    INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
  `);
  // Interrupted operations must not remain in progress after gateway replacement.
  await db.query("UPDATE operations SET status='failed', error='Serviço reiniciado. Tente novamente.', updated_at=now() WHERE status='running'");
}

export async function audit(db: Database, actor: string | null, action: string, subject: string | null = null) {
  await db.query('INSERT INTO audit(actor_id,action,subject_id) VALUES($1,$2,$3)', [actor, action, subject]);
}
