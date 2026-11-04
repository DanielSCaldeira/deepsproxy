import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Database } from './production/database.ts';
import { createGateway } from './production/gateway.ts';
import { Workers } from './production/workers.ts';
import { UserQueue } from './production/queue.ts';
import { digest, HttpError, workerToken } from './production/security.ts';
import { classifySessionError } from './services/playwright.ts';
import type { ProductionConfig } from './production/config.ts';

const config: ProductionConfig = { origin:'https://proxy.test',database:'unused',bootstrap:'b'.repeat(64),provisioner:'http://internal',provisionerToken:'p'.repeat(64),workerMaster:'m'.repeat(64),maxWorkers:5 };
class FakeWorkers extends Workers {
  calls: Array<{id:string;path:string}> = [];
  accounts = new Map<string,string>();
  override async provision(action:string,id?:string) { return action==='list'?{workers:[]}:{host:`worker-${id}`}; }
  override async request(id:string,path:string,init:RequestInit={},start=true) {
    if(start) await this.ensure(id);
    this.calls.push({id,path});
    if(path==='/api/status') return Response.json({deepseek:{state:this.accounts.get(id)||'authenticated',checkedAt:new Date().toISOString(),sessionSaved:true}});
    if(path==='/v1/chat/completions') {
      const body=JSON.parse(String(init.body));
      return body.stream ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}) : Response.json({choices:[{message:{content:'ok'}}]});
    }
    if(path==='/v1/models') return Response.json({object:'list',data:[{id:'deepseek-v4-flash'}]});
    return Response.json({ok:true});
  }
}

test('production: PostgreSQL auth, account isolation, API keys and lifecycle', async t => {
  const pg=await PGlite.create();
  t.after(()=>pg.close());
  const db: Database = { async query(sql,values) {
    const result = values ? await pg.query(sql,values) : (await pg.exec(sql)).at(-1)!;
    return {rows:result.rows as any[],rowCount:result.affectedRows || 0};
  } };
  await migrate(db); await migrate(db);
  const workers=new FakeWorkers(config,db); await workers.initialize();
  const gateway=createGateway(db,workers,config), app=gateway.app;
  type Client={cookie?:string;csrf?:string};
  const request=(path:string,method='GET',body?:unknown,client:Client={},extra:Record<string,string>={})=>app.request(path,{method,headers:{Origin:config.origin,'Content-Type':'application/json',...(client.cookie?{Cookie:client.cookie}:{}),...(client.csrf?{'X-CSRF-Token':client.csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const credential=async(response:Response):Promise<Client>=>({cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:(await response.json()).csrf});
  let admin:Client={}, alice:Client={}, bob:Client={}, aliceId='',bobId='',aliceKey='',bobKey='';

  await t.test('setup is atomic, password hashed, origin and CSRF enforced',async()=> {
    assert.equal((await request('/api/auth/setup','POST',{token:config.bootstrap,email:'admin@test.com',password:'administrator-password'},{},{Origin:'https://evil.test'})).status,403);
    const setup=await request('/api/auth/setup','POST',{token:config.bootstrap,email:'admin@test.com',password:'administrator-password'});
    assert.equal(setup.status,200); assert.match(setup.headers.get('set-cookie')!,/HttpOnly/); assert.match(setup.headers.get('set-cookie')!,/Secure/);
    admin=await credential(setup);
    assert.equal((await request('/api/auth/setup','POST',{token:config.bootstrap,email:'other@test.com',password:'another-password'})).status,409);
    const hash=(await db.query('SELECT password_hash FROM users')).rows[0].password_hash;
    assert.match(hash,/^\$argon2id\$/); assert.ok(!hash.includes('administrator-password'));
    assert.equal((await request('/api/admin/invite','POST',{email:'alice@test.com'},{cookie:admin.cookie})).status,403);
    assert.equal((await request('/api/admin/users')).status,401);
    assert.equal((await request('/api/auth/login','POST',{email:'admin@test.com',password:'wrong-password'})).status,401);
  });
  async function invite(address:string) {
    const response=await request('/api/admin/invite','POST',{email:address},admin); assert.equal(response.status,200);
    const token=new URLSearchParams(new URL((await response.json()).url).hash.slice(1)).get('token')!;
    const accepted=await request('/api/auth/redeem','POST',{token,password:'a-long-user-password'}); assert.equal(accepted.status,200);
    const client=await credential(accepted);
    assert.equal((await request('/api/auth/redeem','POST',{token,password:'a-long-user-password'})).status,400);
    return {client,id:(await (await request('/api/me','GET',undefined,client)).json()).id};
  }
  await t.test('invite-only registration and user permissions',async()=> {
    const a=await invite('alice@test.com'),b=await invite('bob@test.com'); alice=a.client; aliceId=a.id; bob=b.client; bobId=b.id;
    assert.equal((await request('/api/admin/users','GET',undefined,alice)).status,403);
    assert.equal((await request('/api/auth/register','POST',{})).status,401);
    const response=await request('/api/me/keys','POST',{name:'Before login'},alice); assert.equal(response.status,409);
    await workers.ensure(aliceId); await workers.ensure(bobId);
  });
  await t.test('each account status is scoped to authenticated user and survives idle suspension',async()=> {
    workers.accounts.set(aliceId,'authenticated'); workers.accounts.set(bobId,'suspended');
    const a=await (await request('/api/me/status','GET',undefined,alice)).json();
    const b=await (await request('/api/me/status?userId='+aliceId,'GET',undefined,bob)).json();
    assert.equal(a.accountState,'authenticated'); assert.equal(b.accountState,'suspended');
    assert.equal(a.sessionSaved,true); assert.ok(a.checkedAt);
    await workers.stopUser(bobId);
    const sleeping=await (await request('/api/me/status','GET',undefined,bob)).json();
    assert.equal(sleeping.runtimeState,'sleeping'); assert.equal(sleeping.accountState,'suspended');
    const restored=new FakeWorkers(config,db); await restored.initialize();
    const saved=await restored.status(bobId);
    assert.equal(saved.accountState,'suspended'); assert.equal(saved.sessionSaved,true); assert.ok(saved.checkedAt);
    await workers.ensure(bobId); workers.accounts.set(bobId,'authenticated');
  });
  await t.test('generated keys are one-time secrets, scoped and revocable',async()=> {
    aliceKey=(await (await request('/api/me/keys','POST',{name:'Zed'},alice)).json()).key;
    bobKey=(await (await request('/api/me/keys','POST',{name:'Continue'},bob)).json()).key;
    assert.match(aliceKey,/^dsp_[\w-]{43}$/); assert.notEqual(aliceKey,bobKey);
    const list=await (await request('/api/me/keys','GET',undefined,alice)).json();
    assert.equal(list.keys.length,1); assert.ok(!JSON.stringify(list).includes(aliceKey));
    assert.equal((await request('/api/me/keys/'+list.keys[0].id,'DELETE',undefined,bob)).status,404);
    assert.equal((await db.query('SELECT hash FROM api_keys WHERE user_id=$1',[aliceId])).rows[0].hash,digest(aliceKey));
    assert.equal((await request('/v1/models','GET',undefined,alice)).status,401);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer local'})).status,401);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer '+config.bootstrap})).status,401);
    for (const [key,id] of [[aliceKey,aliceId],[bobKey,bobId]]) {
      const response=await request('/v1/models','GET',undefined,{},{'X-API-Key':key}); assert.equal(response.status,200); await response.text();
      assert.equal(workers.calls.at(-1)!.id,id);
    }
  });
  await t.test('streaming holds queue ownership until response is consumed',async()=> {
    const response=await request('/v1/chat/completions','POST',{model:'deepseek-v4-flash',messages:[],stream:true},{},{Authorization:'Bearer '+aliceKey});
    assert.equal(response.status,200); assert.equal(workers.queue(aliceId).active,true);
    assert.match(await response.text(),/data: \[DONE\]/); assert.equal(workers.queue(aliceId).active,false);
    assert.equal(workers.calls.at(-1)!.id,aliceId);
  });
  await t.test('remote viewer requires owner session, origin, single-use ticket; API login exclusion',async()=> {
    const aliceIdentity=await gateway.identity(new Headers({Cookie:alice.cookie!}));
    await workers.connect(aliceId,aliceIdentity!.session);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer '+aliceKey})).status,409);
    assert.equal((await request('/api/me/remote-ticket','POST',{},bob)).status,403);
    const ticket=(await (await request('/api/me/remote-ticket','POST',{},alice)).json()).ticket;
    await assert.rejects(()=>gateway.authorizeRemote(new Headers({Cookie:bob.cookie!}),ticket,config.origin));
    const ticket2=(await (await request('/api/me/remote-ticket','POST',{},alice)).json()).ticket;
    const allowed=await gateway.authorizeRemote(new Headers({Cookie:alice.cookie!}),ticket2,config.origin); assert.equal(allowed.id,aliceId);
    await assert.rejects(()=>gateway.authorizeRemote(new Headers({Cookie:alice.cookie!}),ticket2,config.origin));
    const ticket3=(await (await request('/api/me/remote-ticket','POST',{},alice)).json()).ticket;
    await assert.rejects(()=>gateway.authorizeRemote(new Headers({Cookie:alice.cookie!}),ticket3,'https://evil.test'));
    await request('/api/me/connection/cancel','POST',{},alice); assert.equal(workers.queue(aliceId).active,false);
  });
  await t.test('revocation and blocking stop access immediately',async()=> {
    const id=(await (await request('/api/me/keys','GET',undefined,alice)).json()).keys[0].id;
    assert.equal((await request('/api/me/keys/'+id,'DELETE',undefined,alice)).status,200);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer '+aliceKey})).status,401);
    assert.equal((await request('/api/admin/users/'+bobId+'/block','POST',{blocked:true},admin)).status,200);
    assert.equal((await request('/api/me/status','GET',undefined,bob)).status,401);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer '+bobKey})).status,401);
    assert.equal((await request('/api/admin/users/'+bobId+'/block','POST',{blocked:false},admin)).status,200);
    assert.equal((await request('/api/me','GET',undefined,bob)).status,401);
  });
  await t.test('reset revokes prior session and keys, expired links fail',async()=> {
    const reset=await (await request('/api/admin/users/'+bobId+'/reset','POST',{},admin)).json();
    const token=new URLSearchParams(new URL(reset.url).hash.slice(1)).get('token');
    const response=await request('/api/auth/redeem','POST',{token,password:'new-long-password'}); assert.equal(response.status,200);
    assert.equal((await request('/v1/models','GET',undefined,{},{Authorization:'Bearer '+bobKey})).status,401);
    const again=await (await request('/api/admin/users/'+bobId+'/reset','POST',{},admin)).json();
    const expired=new URLSearchParams(new URL(again.url).hash.slice(1)).get('token')!;
    await db.query("UPDATE links SET expires_at=now()-interval '1 second' WHERE hash=$1",[digest(expired)]);
    assert.equal((await request('/api/auth/redeem','POST',{token:expired,password:'new-long-password'})).status,400);
  });
  await t.test('operation IDs belong only to their initiating user',async()=> {
    const response=await request('/api/me/connection/recover','POST',{},alice); assert.equal(response.status,202);
    const {operationId}=await response.json();
    assert.equal((await request('/api/me/operations/'+operationId,'GET',undefined,admin)).status,404);
    let result:any;
    for(let i=0;i<50;i++) { result=await (await request('/api/me/operations/'+operationId,'GET',undefined,alice)).json(); if(result.status!=='running') break; await new Promise(r=>setTimeout(r,10)); }
    assert.equal(result.status,'done');
  });
});

test('bounded user queues: cancellation, timeout, fairness and idempotent release',async()=> {
  const queue=new UserQueue(), first=await queue.acquire(), controller=new AbortController();
  const cancelled=queue.acquire(controller.signal); const rejection=assert.rejects(cancelled,/cancelada/);
  controller.abort(); await rejection; assert.equal(queue.depth,0);
  const timeout=queue.acquire(undefined,5); await assert.rejects(timeout,/espera/);
  const second=queue.acquire(),third=queue.acquire(),fourth=queue.acquire();
  await assert.rejects(queue.acquire(),/Fila cheia/);
  first(); first(); const release2=await second; assert.equal(queue.active,true); release2(); (await third)(); (await fourth)(); assert.equal(queue.active,false);
});

test('worker identities, account errors and capacity are explicit',async()=> {
  assert.notEqual(workerToken(randomUUID(),config.workerMaster),workerToken(randomUUID(),config.workerMaster));
  assert.equal(classifySessionError('DeepSeek account is suspended; chat input is unavailable.'),'suspended');
  assert.equal(classifySessionError('DeepSeek login is required'),'login_required');
  assert.equal(classifySessionError('network timeout'),'unavailable');
  const workers=new FakeWorkers({...config,maxWorkers:1});
  await workers.ensure(randomUUID()); await assert.rejects(workers.ensure(randomUUID()),(error:unknown)=>error instanceof HttpError && error.status===503);
});

test('idle browsers sleep with saved account status; expired login leases release the queue',async t=> {
  let now=Date.now(); t.mock.method(Date,'now',()=>now);
  const workers=new FakeWorkers(config), id=randomUUID();
  await workers.ensure(id); await workers.status(id);
  now+=900_001; await workers.tick(async()=>true);
  const idle=await workers.status(id); assert.equal(idle.runtimeState,'sleeping'); assert.equal(idle.accountState,'authenticated');
  await workers.connect(id,'session-hash'); assert.equal(workers.queue(id).active,true);
  await workers.connect(id,'session-hash'); assert.equal(workers.isLoggingIn(id),true);
  await assert.rejects(workers.connect(id,'different-session'),/login em andamento/);
  await workers.tick(async()=>false); assert.equal(workers.isLoggingIn(id),false); assert.equal(workers.queue(id).active,false);
  await workers.connect(id,'another-session');
  now+=1800_001; await workers.tick(async()=>true); assert.equal(workers.isLoggingIn(id),false); assert.equal(workers.queue(id).active,false);
});
