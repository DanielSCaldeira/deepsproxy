import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Database } from './production/database.ts';
import { ProviderCredentials } from './production/provider-credentials.ts';
import { FreeApis, freeOpenRouterModel, safeRequest, type FreeModel } from './api-providers/free-api.ts';
import { createGateway } from './production/gateway.ts';
import { Workers } from './production/workers.ts';
import type { ProductionConfig } from './production/config.ts';

const fixture = (id = 'fixture/text:free', price = '0') => ({ id, pricing: { prompt: price, completion: '0', request: '0' }, architecture: { output_modalities: ['text'] }, context_length: 32768, supported_parameters: ['tools','tool_choice','parallel_tool_calls'] });
const key = (prefix: string) => prefix + randomBytes(32).toString('hex');
async function database(t: any) {
  const pg = await PGlite.create(); t.after(() => pg.close());
  const db: Database = { async query(sql, values) { const r = values ? await pg.query(sql,values) : (await pg.exec(sql)).at(-1)!; return { rows: r.rows as any[], rowCount: r.affectedRows || 0 }; } };
  await migrate(db); await migrate(db);
  return db;
}
test('free APIs: price policy and structured requests reject paid escape routes', () => {
  assert.ok(freeOpenRouterModel(fixture()));
  for (const m of [fixture('paid/model'),fixture('fixture/text:free','0.1'),{ ...fixture(), pricing: { prompt: '0' } },{ ...fixture(), pricing: { prompt:'0',completion:'0',web_search:'1' } },{ ...fixture(), pricing: { prompt:'',completion:'0' } }]) assert.ok(!freeOpenRouterModel(m));
  const spec: FreeModel = { id: 'openrouter/fixture/text:free', context_length: 32768, supported_parameters: ['tools','tool_choice'], source: 'fixture',checked_at: '' };
  const body = { model:spec.id,messages:[{role:'assistant',content:null,reasoning_content:'Native reasoning metadata',tool_calls:[{id:'call-1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',content:'value',tool_call_id:'call-1'}],tools:[{type:'function',function:{name:'read',parameters:{type:'object'}}}],tool_choice:'none' };
  const result = safeRequest(body,spec,'openrouter');
  assert.deepEqual(result.messages,body.messages); assert.deepEqual(result.tools,body.tools); assert.equal(result.model,'fixture/text:free');
  assert.deepEqual(result.provider.max_price,{prompt:0,completion:0});
  const missingContent = structuredClone(body) as any;
  delete missingContent.messages[0].content;
  assert.equal(safeRequest(missingContent,spec,'openrouter').messages[0].content,null);
  for (const extra of [{plugins:[]},{models:['paid/model']},{provider:{}},{route:'fallback'},{tools:[{type:'web_search'}]},{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://test'}}]}]},{reasoning_effort:'high'},{max_tokens:-1}]) assert.throws(() => safeRequest({...body,...extra},spec,'openrouter'));
  assert.throws(() => safeRequest({...body,messages:[{role:'user',content:'x'.repeat(32768)}]},spec,'openrouter'),/Contexto/);
});

test('free APIs: encrypted persistence, ownership, tampering and cache fail closed', async t => {
  const db = await database(t), alice = randomUUID(), bob = randomUUID();
  await db.query("INSERT INTO users(id,email,role) VALUES($1,'a@test','user'),($2,'b@test','user')",[alice,bob]);
  const master = randomBytes(32).toString('base64'), creds = new ProviderCredentials(db,master), apiKey = key('sk-or-');
  await creds.save(alice,'openrouter',apiKey);
  assert.equal((await creds.load(alice,'openrouter')).apiKey,apiKey);
  assert.equal((await new ProviderCredentials(db,master).load(alice,'openrouter')).apiKey,apiKey);
  assert.ok(!JSON.stringify((await db.query('SELECT * FROM provider_credentials')).rows).includes(apiKey));
  assert.ok(!JSON.stringify(await creds.list(alice)).includes(apiKey));
  assert.deepEqual(await creds.list(bob),[]);
  await assert.rejects(creds.load(bob,'openrouter'));
  await assert.rejects(new ProviderCredentials(db,key('').slice(0,44)).load(alice,'openrouter'));
  await assert.rejects(new ProviderCredentials(db).save(alice,'openrouter',apiKey));
  let price = '0', fail = false, calls = 0;
  const mock: typeof fetch = async () => { calls++; if (fail) throw new Error('network'); return Response.json({data:[fixture('fixture/text:free',price),fixture('paid/text','2')]}); };
  const api = new FreeApis(creds,mock);
  assert.equal((await api.models(alice,'openrouter')).length,1);
  await api.models(alice,'openrouter'); assert.equal(calls,1);
  const future = Date.now() + 300_001;
  t.mock.method(Date,'now',() => future);
  await api.models(alice,'openrouter'); assert.equal(calls,2);
  t.mock.restoreAll();
  price = '1'; assert.deepEqual(await api.models(alice,'openrouter',true),[]);
  await assert.rejects(api.generate(alice,'openrouter',{model:'openrouter/fixture/text:free'},new AbortController().signal));
  price = '0'; await api.models(alice,'openrouter',true); fail = true;
  await assert.rejects(api.models(alice,'openrouter',true)); await assert.rejects(api.models(alice,'openrouter'));
  await db.query("UPDATE provider_credentials SET auth_tag=$1 WHERE user_id=$2",[randomBytes(16).toString('base64'),alice]);
  await assert.rejects(creds.load(alice,'openrouter'),/abrir/);
  await creds.save(alice,'openrouter',apiKey); await creds.remove(alice,'openrouter'); assert.deepEqual(await creds.list(alice),[]);
});

test('free APIs: NVIDIA verifies official free endpoint and upstream access; 429 cooldown has no retries',async t => {
  const db = await database(t), user = randomUUID();
  await db.query("INSERT INTO users(id,email,role) VALUES($1,'n@test','user')",[user]);
  const credentials = new ProviderCredentials(db,randomBytes(32).toString('base64'));
  await credentials.save(user,'nvidia',key('nvapi-'));
  let free = true, generations = 0;
  const fetcher: typeof fetch = async (url,init) => {
    assert.equal(init?.redirect,'error');
    if (String(url).startsWith('https://build.nvidia.com/')) return new Response(free ? 'Start building with a free API endpoint. https://integrate.api.nvidia.com/v1 tools tool_choice' : 'Deprecated');
    if (String(url).endsWith('/models')) return Response.json({data:[{id:'deepseek-ai/deepseek-v4.1-flash'},{id:'unverified/model'}]});
    generations++; return Response.json({error:'private upstream diagnostic'}, {status:429,headers:{'Retry-After':'120'}});
  };
  const api = new FreeApis(credentials,fetcher), model = 'nvidia/deepseek-ai/deepseek-v4.1-flash';
  assert.deepEqual((await api.models(user,'nvidia')).map(m => m.id),[model]);
  const body = {model,messages:[{role:'user',content:'test'}]};
  const r = await api.generate(user,'nvidia',body,new AbortController().signal);
  assert.equal(r.status,429); assert.equal(r.headers.get('Retry-After'),'120'); assert.ok(!(await r.text()).includes('private'));
  assert.equal((await api.generate(user,'nvidia',body,new AbortController().signal)).status,429); assert.equal(generations,1);
  free = false; assert.deepEqual(await api.models(user,'nvidia',true),[]);
});

test('free APIs: authenticated gateway, API-only dsp keys, SSE, revocation and no browsers', async t => {
  const db = await database(t);
  const config: ProductionConfig = {origin:'https://proxy.test',database:'unused',bootstrap:'b'.repeat(64),provisioner:'unused',provisionerToken:'p'.repeat(64),workerMaster:'m'.repeat(64),maxWorkers:1,credentialsKey:randomBytes(32).toString('base64')};
  let browserCalls = 0;
  class NoBrowsers extends Workers {
    override async models() { return []; }
    override async status(): Promise<any> { return {accountState:'not_initialized'}; }
    override async request(): Promise<any> { browserCalls++; throw new Error('browser must not start'); }
  }
  let signal: AbortSignal | undefined, upstreamBody: any, generations = 0, pending = false;
  const sse = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: {"usage":{"completion_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n';
  const fetcher: typeof fetch = async (url,init) => {
    if (String(url).endsWith('/models')) return Response.json({data:[fixture(),fixture('paid/text','1')]});
    if (String(url).endsWith('/key')) return Response.json({data:{free_model_daily_requests:{used:1,limit:50,remaining:49}}});
    generations++; upstreamBody = JSON.parse(String(init?.body)); signal = init?.signal as AbortSignal;
    if (upstreamBody.stream) return new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(sse.slice(0,17))); c.enqueue(new TextEncoder().encode(sse.slice(17))); if (!pending) c.close(); }}),{headers:{'Content-Type':'text/event-stream'}});
    return Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{completion_tokens:1}});
  };
  const workers = new NoBrowsers(config,db), app = createGateway(db,workers,config,fetcher).app;
  let cookie = '', csrf = '';
  const req = (path:string,method='GET',body?:unknown, headers:Record<string,string>={}) => app.request(path,{method,headers:{Origin:config.origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},body:body === undefined ? undefined : JSON.stringify(body)});
  const setup = await req('/api/auth/setup','POST',{token:config.bootstrap,email:'admin@test.com',password:'long-administrator-password'});
  assert.equal(setup.status,200);
  cookie = setup.headers.get('set-cookie')!.split(';')[0]; csrf = (await setup.json()).csrf;
  const secret = key('sk-or-');
  assert.equal((await req('/api/me/provider-credentials/openrouter','PUT',{apiKey:secret},{'X-CSRF-Token':''})).status,403);
  assert.equal((await req('/api/me/provider-credentials/deepseek-api','PUT',{apiKey:secret})).status,404);
  assert.equal((await req('/api/me/provider-credentials/openrouter','PUT',{apiKey:secret})).status,200);
  assert.ok(!(await (await req('/api/me/provider-credentials')).text()).includes(secret));
  assert.equal((await req('/api/me/keys','POST',{name:'IDE'})).status,409);
  const model = 'openrouter/fixture/text:free';
  assert.equal((await req('/api/me/provider-credentials/openrouter/validate','POST',{model:'openrouter/paid/text'})).status,400);
  assert.equal(generations,0);
  assert.equal((await req('/api/me/provider-credentials/openrouter/validate','POST',{model})).status,200);
  const apiKey = (await (await req('/api/me/keys','POST',{name:'IDE'})).json()).key;
  assert.match(apiKey,/^dsp_/);
  const headers = {Authorization:'Bearer '+apiKey};
  const bob = randomUUID(), bobSession = key(''), bobCsrf = key('');
  const { digest } = await import('./production/security.ts');
  await db.query("INSERT INTO users(id,email,role) VALUES($1,'bob@test.com','user')",[bob]);
  await db.query("INSERT INTO sessions(hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[digest(bobSession),bob,bobCsrf]);
  const bobHeaders = {Cookie:'__Host-dsp='+bobSession,'X-CSRF-Token':bobCsrf};
  assert.equal((await (await req('/api/me/provider-credentials/openrouter','GET',undefined,bobHeaders)).json()).credential,null);
  assert.equal((await req('/api/me/provider-credentials/openrouter','DELETE',undefined,bobHeaders)).status,200);
  assert.ok((await (await req('/api/me/provider-credentials/openrouter')).json()).credential);
  assert.deepEqual((await (await req('/v1/models','GET',undefined,headers)).json()).data.map((m:any) => m.id),[model]);
  assert.equal((await req('/v1/chat/completions','POST',{model:'openrouter/paid/text',messages:[]},headers)).status,400);
  assert.equal((await req('/v1/chat/completions','POST',{model,messages:[{role:'user',content:'hello'}],plugins:[{id:'web'}]},headers)).status,400);
  const messages = [{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',content:'fixture-value',tool_call_id:'call-1'}];
  const response = await req('/v1/chat/completions','POST',{model,messages,stream:true},headers);
  assert.equal(await response.text(),sse); assert.deepEqual(upstreamBody.messages,messages);
  assert.equal(upstreamBody.model,'fixture/text:free'); assert.equal(browserCalls,0);
  const restored = createGateway(db,workers,config,fetcher).app;
  const restartModels = await restored.request('/v1/models',{headers});
  assert.equal((await restartModels.json()).data[0].id,model);
  const daily = (await (await req('/api/me/provider-credentials/openrouter/limits')).json()).daily;
  assert.equal(daily.remaining,49);
  pending = true;
  const running = await req('/v1/chat/completions','POST',{model,messages,stream:true},headers);
  assert.equal(signal?.aborted,false);
  await req('/api/me/provider-credentials/openrouter','PUT',{apiKey:key('sk-or-')});
  assert.equal(signal?.aborted,true); await running.body?.cancel();
  const cancelled = await req('/v1/chat/completions','POST',{model,messages,stream:true},headers);
  await cancelled.body?.cancel(); assert.equal(signal?.aborted,true);
  const running2 = await req('/v1/chat/completions','POST',{model,messages,stream:true},headers);
  await req('/api/me/provider-credentials/openrouter','DELETE'); assert.equal(signal?.aborted,true); await running2.body?.cancel();
  assert.deepEqual((await (await req('/v1/models','GET',undefined,headers)).json()).data,[]);
});
