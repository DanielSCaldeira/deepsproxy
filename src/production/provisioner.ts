import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { containerLogs, docker, DockerError } from './docker.ts';
import { removeWorkerNetwork } from './network-cleanup.ts';
import { equal, uuid, workerToken } from './security.ts';
import { required } from './config.ts';
import { Mutex } from '../utils/mutex.ts';

const token=required('PROVISIONER_TOKEN'), master=required('WORKER_MASTER_SECRET');
if(token.length<32 || master.length<32) throw new Error('Provisioner secrets too short');
const image=required('WORKER_IMAGE'), gateway=required('GATEWAY_CONTAINER'), egress=required('EGRESS_CONTAINER');
const prefix=process.env.RESOURCE_PREFIX || 'dsp';
if(!/^[a-z][a-z0-9_-]{0,30}$/.test(prefix)) throw new Error('Invalid RESOURCE_PREFIX');
const maximum=Number(process.env.MAX_ACTIVE_BROWSERS || 5);
if (!Number.isInteger(maximum) || maximum<1 || maximum>20) throw new Error('Invalid capacity');
const seccomp=await readFile(new URL('../../deploy/seccomp.json',import.meta.url),'utf8');
const label=`${prefix}.managed`;
const app=new Hono(), mutex=new Mutex();
app.use('*',async (c,next)=> { if(!equal(c.req.header('Authorization') || '',`Bearer ${token}`)) return c.json({error:'Unauthorized'},401); await next(); });
/** A failure with the provisioning stage it happened in; `detail` is safe to return (no secrets). */
class StageError extends Error {
  override name='StageError';
  constructor(public stage:string,public detail:string) { super(`${stage}: ${detail}`); }
}
async function stage<T>(name:string,work:()=>Promise<T>):Promise<T> {
  try { return await work(); }
  catch(error) {
    if(error instanceof StageError) throw error;
    throw new StageError(name,error instanceof DockerError ? `Docker ${error.status}${error.detail ? ': '+error.detail : ''}` : error instanceof Error ? error.message : String(error));
  }
}
/** Captures why a worker died before its container (and logs) are removed. */
async function workerDiagnostics(container:string) {
  try {
    const info=await docker('GET',`/containers/${container}/json`);
    const health=info.State?.Health?.Log?.at?.(-1);
    const logs=await containerLogs(container,40).catch(()=> '');
    console.error('[provisioner] worker diagnostics',{container,exitCode:info.State?.ExitCode,error:info.State?.Error || undefined,oomKilled:info.State?.OOMKilled || undefined,
      health:health ? {exitCode:health.ExitCode,output:String(health.Output || '').trim().slice(0,300)} : undefined});
    if(logs) console.error(`[provisioner] worker logs (${container}):\n${logs}`);
    const last=logs.split('\n').map(l=>l.trim()).filter(Boolean).at(-1);
    return `exit=${info.State?.ExitCode}${info.State?.OOMKilled ? ' (sem memória)' : ''}${last ? ' — '+last.slice(0,200) : ''}`;
  } catch(error) { return `diagnóstico indisponível (${error instanceof Error ? error.message : 'erro'})`; }
}
app.onError((error,c)=> {
  const code=error instanceof StageError ? error.stage : 'internal';
  const detail=error instanceof StageError ? error.detail : error instanceof DockerError ? `Docker ${error.status}: ${error.detail}` : error.message;
  console.error('[provisioner] operation failed',{name:error.name,stage:code,detail});
  return c.json({error:'Provisioning failed',code,detail:detail.slice(0,500)},502);
});
const contract='2';
// Worker startup paces provider actions (10–15s each) and retries once; 75s was too tight.
const STARTUP_SECONDS=150;
const names=(id:string)=>({container:`${prefix}_worker_${id}`,network:`${prefix}_net_${id}`,volume:`${prefix}_profile_${id}`});
async function list() {
  return docker('GET','/containers/json?all=true&filters='+encodeURIComponent(JSON.stringify({label:[`${label}=worker`]}))) as Promise<any[]>;
}
async function ignored404(method:string,path:string,body?:unknown) { try { return await docker(method,path,body); } catch(error) { if (!(error instanceof DockerError && error.status===404)) throw error; } }
async function stop(id:string,purge=false) {
  const n=names(id);
  const found=(await list()).find(w=>(w.Labels?.[`${prefix}.account`] || w.Labels?.[`${prefix}.owner`])===id);
  if(found) {
    const info=await docker('GET',`/containers/${found.Id}/json`);
    if(info.State.Running) { try { await docker('POST',`/containers/${found.Id}/stop?t=25`); } catch(error) { if(!(error instanceof DockerError && error.status===304)) throw error; } }
    await docker('DELETE',`/containers/${found.Id}?force=true`);
  }
  await removeWorkerNetwork(n.network, [gateway, egress]);
  if(purge) await ignored404('DELETE',`/volumes/${n.volume}`);
}
async function describe(id:string) {
  const n=names(id), info=await docker('GET',`/containers/${n.container}/json`);
  if(!info.State.Running) throw new Error('Worker stopped');
  return {id,host:info.NetworkSettings.Networks[n.network].IPAddress,owner:info.Config.Labels[`${prefix}.owner`],provider:info.Config.Labels[`${prefix}.provider`] || 'deepseek',contract:info.Config.Labels[`${prefix}.contract`],compatible:info.Config.Labels[`${prefix}.image`]===image && info.Config.Image===image && info.Config.Labels[`${prefix}.contract`]===contract};
}
async function attach(network:string,container:string,alias:string) {
  const info=await docker('GET',`/containers/${container}/json`);
  if(!info.NetworkSettings.Networks[network]) await docker('POST',`/networks/${network}/connect`,{Container:container,EndpointConfig:{Aliases:[alias]}});
}
app.post('/list',async c=>mutex.withLock(async()=> {
  const workers=[];
  for(const item of (await list()).filter(w=>w.State==='running')) {
    const id=uuid(item.Labels[`${prefix}.account`] || item.Labels[`${prefix}.owner`]), n=names(id);
    await attach(n.network,gateway,'gateway'); await attach(n.network,egress,'egress');
    workers.push(await describe(id));
  }
  return c.json({workers});
}));
app.post('/:action/:id',async c=>mutex.withLock(async()=> {
  const action=c.req.param('action'); if(!['start','stop','purge'].includes(action)) return c.notFound();
  let id:string; try { id=uuid(c.req.param('id')); } catch { return c.json({error:'Invalid id'},400); }
  const body = await c.req.json().catch(()=>null);
  let owner: string;
  try { owner=uuid(body?.user_id); } catch { return c.json({error:'Invalid owner'},400); }
  const provider=body?.provider;
  if (!['deepseek','qwen','chatgpt','kimi'].includes(provider) || body?.id!==id || (provider==='deepseek' && owner!==id) || (provider!=='deepseek' && owner===id)) return c.json({error:'Invalid account'},400);
  const current=(await list()).find(w => (w.Labels?.[`${prefix}.account`] || w.Labels?.[`${prefix}.owner`])===id);
  if(current && (current.Labels[`${prefix}.owner`]!==owner || (current.Labels[`${prefix}.provider`] || 'deepseek')!==provider)) return c.json({error:'Account ownership mismatch'},409);
  if(action!=='start') { await stop(id,action==='purge'); return c.json({ok:true}); }
  const entries=await list();
  if(current?.State==='running') {
    const running=await describe(id);
    if(running.compatible) return c.json(running);
    await stop(id);
  }
  if(entries.filter(w=>w.State==='running' && w.Id!==current?.Id).length>=maximum) return c.json({error:'Capacity full',code:'capacity_full',detail:`Limite de ${maximum} navegadores ativos atingido.`},429);
  // Clean up incomplete resources from a failed or interrupted start.
  await stage('cleanup',()=>stop(id));
  const n=names(id), labels={ [label]:'worker',[`${prefix}.owner`]:owner,[`${prefix}.account`]:id,[`${prefix}.provider`]:provider,[`${prefix}.contract`]:contract,[`${prefix}.image`]:image };
  try {
    await stage('volume',()=>docker('POST','/volumes/create',{Name:n.volume,Labels:labels}));
    await stage('network',()=>docker('POST','/networks/create',{Name:n.network,Internal:true,Labels:labels}));
    for(const [container,alias] of [[gateway,'gateway'],[egress,'egress']]) await stage('network_attach',()=>docker('POST',`/networks/${n.network}/connect`,{Container:container,EndpointConfig:{Aliases:[alias]}}));
    await stage('create',()=>docker('POST','/containers/create?name='+n.container,{
      Image:image,Hostname:n.container,Labels:labels,
      Env:['APP_MODE=worker','PORT=3000','BIND_HOST=0.0.0.0','PLAYWRIGHT_HEADLESS=false','DISPLAY=:99',`PROVIDER=${provider}`,'PROVIDER_PROFILE_DIR=/profile','QWEN_PROFILE_DIR=/profile','DEEPSEEK_PROFILE_DIR=/profile',`API_KEY=${workerToken(id,master)}`],
      HostConfig:{NetworkMode:n.network,ReadonlyRootfs:true,Init:true,ShmSize:512*1024*1024,Memory:1536*1024*1024,NanoCpus:1_000_000_000,PidsLimit:256,
        CapDrop:['ALL'],CapAdd:['CHOWN','SETUID','SETGID','DAC_OVERRIDE'],SecurityOpt:['no-new-privileges',`seccomp=${seccomp}`],
        Mounts:[{Type:'volume',Source:n.volume,Target:'/profile'}],Tmpfs:{'/tmp':'rw,nosuid,nodev,size=268435456','/home/node':'rw,nosuid,nodev,size=67108864'},
        LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'2'}}},
    }));
    await stage('start',()=>docker('POST',`/containers/${n.container}/start`));
    const result=await stage('start',()=>describe(id));
    for(let attempt=0;attempt<STARTUP_SECONDS;attempt++) {
      const info=await stage('health',()=>docker('GET',`/containers/${n.container}/json`));
      if(info.State.Health?.Status==='healthy') return c.json(result);
      if(!info.State.Running) throw new StageError('exited',`O navegador encerrou ao iniciar (${await workerDiagnostics(n.container)}).`);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new StageError('health_timeout',`O navegador não ficou pronto em ${STARTUP_SECONDS}s (${await workerDiagnostics(n.container)}).`);
  } catch(error) { await stop(id).catch(()=>{}); throw error; }
}));
serve({fetch:app.fetch,hostname:'0.0.0.0',port:3001});
