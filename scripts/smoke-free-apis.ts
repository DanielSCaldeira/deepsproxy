// Local lab only. Credentials arrive on stdin and are never written to a plaintext file.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const origin = 'http://localhost:3440';
const load = async (path: string) => JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const admin = await load('.cache/proxy-ia-live-admin.json');
const login = await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:admin.email,password:admin.password})});
if (!login.ok) throw new Error('Local lab login failed: '+login.status);
const cookie = login.headers.get('set-cookie')!.split(';')[0], csrf = (await login.json()).csrf;
async function panel(path: string,method='GET',body?: unknown) {
  return fetch(origin+path,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(150_000)});
}
if (process.argv.includes('--register')) {
  const keys = JSON.parse(readFileSync(0,'utf8'));
  for (const provider of ['nvidia','openrouter']) {
    if (typeof keys[provider] !== 'string') continue;
    const saved = await panel('/api/me/provider-credentials/'+provider,'PUT',{apiKey:keys[provider]});
    console.log(JSON.stringify({provider,action:'save',status:saved.status}));
  }
}
const reports: any[] = [];
for (const provider of ['openrouter','nvidia']) {
  const response = await panel('/api/me/provider-credentials/'+provider+'/models','POST',{});
  const report: any = {provider,catalogStatus:response.status}; reports.push(report);
  if (!response.ok) continue;
  const {models} = await response.json(); report.freeModels = models.length;
  const requested = process.argv.find(arg => arg.startsWith('--'+provider+'-model='))?.split('=').slice(1).join('=');
  const model = requested ? models.find((m:any) => m.id === requested) : models.find((m:any) => m.supported_parameters.includes('tools') && m.supported_parameters.includes('tool_choice')) || models[0];
  if (!model) continue;
  report.model = model.id;
  const validate = await panel('/api/me/provider-credentials/'+provider+'/validate','POST',{model:model.id});
  report.validationStatus = validate.status;
}
if (!process.argv.includes('--smoke')) { console.log(JSON.stringify(reports,null,2)); process.exit(0); }
const created = await panel('/api/me/keys','POST',{name:'Temporary free API smoke'});
if (!created.ok) { console.log(JSON.stringify({reports,keyStatus:created.status},null,2)); process.exit(1); }
const temporary = await created.json();
try {
  const request = async (body:any) => fetch(origin+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+temporary.key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150_000)});
  for (const report of reports) {
    if (report.validationStatus !== 200) continue;
    const base = {model:report.model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:512};
    const text = await request(base); report.textStatus = text.status;
    if (text.ok) { const j = await text.json(); report.textConfirmed = !!j.choices?.[0]?.message?.content; }
    const stream = await request({...base,stream:true}); report.streamStatus = stream.status;
    if (stream.ok) report.streamDone = (await stream.text()).includes('data: [DONE]');
    const tools = [{type:'function',function:{name:'read_fixture',description:'Read a local test value.',parameters:{type:'object',properties:{},additionalProperties:false}}}];
    const messages = [{role:'user',content:'Call read_fixture and return its value.'}];
    const tool = await request({model:report.model,messages,tools,tool_choice:'required',max_tokens:1024});
    report.toolStatus = tool.status;
    if (!tool.ok) continue;
    const j = await tool.json(), assistant = j.choices?.[0]?.message;
    report.assistantFields = assistant ? Object.keys(assistant) : [];
    const calls = assistant?.tool_calls;
    report.toolConfirmed = !!calls?.length && calls.every((c:any) => c.function?.name === 'read_fixture');
    if (!report.toolConfirmed) continue;
    const fixture = 'free-api-fixture-'+crypto.randomUUID();
    const followup = await request({model:report.model,messages:[...messages,assistant,...calls.map((c:any) => ({role:'tool',tool_call_id:c.id,content:fixture}))],tools,tool_choice:'none',max_tokens:512});
    report.followupStatus = followup.status;
    if (!followup.ok) report.followupError = (await followup.json()).error?.code;
    if (followup.ok) report.toolCycleConfirmed = (await followup.json()).choices?.[0]?.message?.content?.includes(fixture) === true;
  }
  console.log(JSON.stringify(reports,null,2));
} finally { await panel('/api/me/keys/'+temporary.id,'DELETE'); }
