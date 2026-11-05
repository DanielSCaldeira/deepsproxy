import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseQwenStream, qwenModels, qwenPayload } from './providers/qwen-protocol.ts';
import { parseProviderStreamToOpenAI } from './routes/stream.ts';
import { createSessionStore } from './services/session-store.ts';

async function* pieces(text: string, size = 1) { for (let i = 0; i < text.length; i += size) yield text.slice(i,i+size); }
const sse = (delta: unknown) => `data: ${JSON.stringify({choices:[{delta}]})}\r\n\r\n`;

test('Qwen SSE preserves fragmented text, reasoning, usage, tools and repeated deltas', async () => {
  const wire = sse({phase:'think',content:'Pensando'}) + sse({phase:'answer',content:'Olá '}) + sse({phase:'answer',content:'ha'}) + sse({phase:'answer',content:'ha'}) + 'data: {"usage":{"completion_tokens":9}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const result = await parseProviderStreamToOpenAI(parseQwenStream(pieces(wire)), 'test','qwen/test',10);
  assert.equal(result.content,'Olá haha'); assert.equal(result.reasoningContent,'Pensando'); assert.equal(result.usage.completion_tokens,9);
  const tool = sse({phase:'answer',content:'<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>'}) + 'data: [DONE]\n\n';
  const parsed = await parseProviderStreamToOpenAI(parseQwenStream(pieces(tool,3)),'tool','qwen/test',5,[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}}]);
  assert.equal(parsed.finishReason,'tool_calls'); assert.equal(parsed.toolCalls[0].function.name,'read_file');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments),{path:'a.ts'});
});

test('Qwen protocol rejects incomplete, invalid and quota responses; abort closes the source', async () => {
  for (const wire of [sse({content:'incomplete'}),'data: broken\n\n',sse({extra:{update_member:true}}),'data: {"success":false}\n\n']) {
    await assert.rejects(async()=>{ for await (const _ of parseQwenStream(pieces(wire))) {} });
  }
  const controller=new AbortController(); let closed=false;
  async function* source() { try { yield sse({content:'start'}); controller.abort(); yield sse({content:'later'}); } finally { closed=true; } }
  await assert.rejects(async()=>{ for await (const _ of parseQwenStream(source(),controller.signal)) {} });
  assert.equal(closed,true);
  assert.deepEqual(qwenModels({data:[{id:'account-model',info:{meta:{max_context_length:32000}}}]}),[{id:'qwen/account-model',contextLength:32000}]);
  assert.throws(()=>qwenModels({invalid:true}));
  assert.equal(qwenPayload('prompt','test',false,'chat','fid').messages[0].feature_config.thinking_enabled,false);
});

test('Qwen browser adapter persists manual login and exposes models and cancellable generation', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'proxy-ia-qwen-'));
  const env = {PROVIDER:'qwen',PROVIDER_PROFILE_DIR:directory,DEEPSPROXY_DISABLE_TELEMETRY_PERSIST:'1',DEEPSPROXY_REQUEST_DELAY_MIN_MS:'0',DEEPSPROXY_REQUEST_DELAY_MAX_MS:'0',DEEPSPROXY_ACTION_DELAY_MIN_MS:'0',DEEPSPROXY_ACTION_DELAY_MAX_MS:'0'};
  const previous = Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  Object.assign(process.env,env);
  t.after(()=>{for(const [key,value] of Object.entries(previous)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }});
  const browser=await chromium.launch(); const context=await browser.newContext();
  t.mock.method(chromium,'launchPersistentContext',async()=>context);
  const payloads: any[]=[];
  await context.route('https://chat.qwen.ai/**',async route=>{
    const url=new URL(route.request().url());
    const json=(body:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:'<script>fetch("/api/v2/users/status",{headers:{authorization:"Bearer fixture"}})</script>'});
    if(url.pathname==='/api/v2/users/status') return json({success:true,data:{is_login:true}});
    if(url.pathname==='/api/models') return json({data:[{id:'fixture-model',info:{meta:{max_context_length:16000}}}]});
    if(url.pathname==='/api/v2/chats/new') return json({data:{id:'fixture-chat'}});
    if(url.pathname==='/api/v2/chat/completions') {
      payloads.push(route.request().postDataJSON());
      return route.fulfill({contentType:'text/event-stream',body:sse({phase:'answer',content:'fixture answer'})+'data: [DONE]\n\n'});
    }
    return route.fulfill({status:404,body:'missing'});
  });
  const { getProvider }=await import('./providers/registry.ts'); const provider=getProvider();
  try {
    await provider.initialize(true); await context.pages()[0].waitForLoadState('networkidle');
    await provider.confirmLogin(true);
    assert.equal((await provider.status()).state,'authenticated');
    assert.equal(await createSessionStore(directory).hasSavedSession(),true);
    assert.equal((await provider.models())[0].id,'qwen/fixture-model');
    const { app }=await import('./index.ts');
    const request=(body:unknown)=>app.request('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',...(process.env.API_KEY?{authorization:`Bearer ${process.env.API_KEY}`}:{})},body:JSON.stringify(body)});
    assert.equal((await request({model:'missing',messages:[]})).status,400);
    assert.equal(payloads.length,0);
    for(const stream of [false,true]) {
      const response=await request({model:'qwen/fixture-model',messages:[{role:'user',content:'hello'}],reasoning_effort:'high',stream});
      assert.equal(response.status,200); assert.match(await response.text(),/fixture answer/);
      assert.equal(payloads.at(-1).messages[0].feature_config.thinking_enabled,true);
    }
    const events=await provider.generate('full conversation','qwen/fixture-model',false);
    const parsed=await parseProviderStreamToOpenAI(events,'fixture','qwen/fixture-model',5);
    assert.equal(parsed.content,'fixture answer'); assert.equal(payloads.at(-1).messages[0].content,'full conversation');
    const cancel=new AbortController(); const unread=await provider.generate('cancel','qwen/fixture-model',true,cancel.signal);
    cancel.abort(); await assert.rejects(async()=>{for await(const _ of unread) {}});
    assert.equal((await provider.status()).busy,false);
  } finally { await provider.close(); await browser.close(); await rm(directory,{recursive:true,force:true,maxRetries:3}); }
});
