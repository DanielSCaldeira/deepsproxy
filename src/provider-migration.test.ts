import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Database } from './production/database.ts';

test('legacy DeepSeek account, snapshot, operations and keys survive repeated migration',async()=>{
  const pg=await PGlite.create();
  const user='11111111-1111-1111-1111-111111111111';
  const db:Database={async query(sql,values){const result=values?await pg.query(sql,values):(await pg.exec(sql)).at(-1)!;return {rows:result.rows as any[],rowCount:result.affectedRows||0};}};
  try {
    await pg.exec(`CREATE TABLE users(id uuid PRIMARY KEY,email text UNIQUE,password_hash text,role text,blocked boolean DEFAULT false,created_at timestamptz DEFAULT now());
      CREATE TABLE account_status(user_id uuid PRIMARY KEY REFERENCES users(id),state text,session_saved boolean,checked_at timestamptz,suspended_until text);
      CREATE TABLE operations(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),action text,status text,error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX one_running_operation ON operations(user_id) WHERE status='running';
      INSERT INTO users(id,email,role) VALUES('${user}','legacy@example.test','user');
      INSERT INTO account_status VALUES('${user}','authenticated',true,now(),NULL);
      INSERT INTO operations(id,user_id,action,status) VALUES(gen_random_uuid(),'${user}','connect','done');`);
    await migrate(db);
    await db.query("INSERT INTO api_keys(id,user_id,hash,name,prefix) VALUES(gen_random_uuid(),$1,'original-hash','Zed','dsp_legacy')",[user]);
    const first=(await db.query('SELECT id,provider FROM provider_accounts ORDER BY provider')).rows;
    await migrate(db);
    assert.deepEqual((await db.query('SELECT id,provider FROM provider_accounts ORDER BY provider')).rows,first);
    assert.equal(first.length,4); assert.equal(first.find(a=>a.provider==='deepseek')!.id,user);
    assert.ok(first.filter(a=>a.provider!=='deepseek').every(a=>a.id!==user));
    const snapshot=(await db.query('SELECT * FROM account_status WHERE account_id=$1',[user])).rows[0];
    assert.equal(snapshot.state,'authenticated'); assert.equal(snapshot.session_saved,true);
    assert.equal(snapshot.authenticated,true); assert.equal(snapshot.provider_message,null);
    assert.equal((await db.query('SELECT account_id FROM operations')).rows[0].account_id,user);
    assert.equal((await db.query('SELECT hash FROM api_keys')).rows[0].hash,'original-hash');
    // Independent operations are allowed for the same user on different providers.
    for(const account of first) await db.query("INSERT INTO operations(id,user_id,account_id,action,status) VALUES(gen_random_uuid(),$1,$2,'connect','running')",[user,account.id]);
    await migrate(db);
    assert.equal((await db.query("SELECT id FROM operations WHERE status='running'")).rows.length,0);
  } finally {await pg.close();}
});
