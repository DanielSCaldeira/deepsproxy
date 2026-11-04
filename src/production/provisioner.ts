import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { docker, DockerError } from './docker.ts';
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
app.onError((error,c)=> { console.error('[provisioner] operation failed',{name:error.name}); return c.json({error:'Provisioning failed'},502); });
const names=(id:string)=>({container:`${prefix}_worker_${id}`,network:`${prefix}_net_${id}`,volume:`${prefix}_profile_${id}`});
async function list() {
  return docker('GET','/containers/json?all=true&filters='+encodeURIComponent(JSON.stringify({label:[`${label}=worker`]}))) as Promise<any[]>;
}
async function ignored404(method:string,path:string,body?:unknown) { try { return await docker(method,path,body); } catch(error) { if (!(error instanceof DockerError && error.status===404)) throw error; } }
async function stop(id:string,purge=false) {
  const n=names(id);
  const found=(await list()).find(w=>w.Labels?.[`${prefix}.owner`]===id);
  if(found) {
    const info=await docker('GET',`/containers/${found.Id}/json`);
    if(info.State.Running) { try { await docker('POST',`/containers/${found.Id}/stop?t=25`); } catch(error) { if(!(error instanceof DockerError && error.status===304)) throw error; } }
    await docker('DELETE',`/containers/${found.Id}?force=true`);
  }
  for(const container of [gateway,egress]) {
    try { await docker('POST',`/networks/${n.network}/disconnect`,{Container:container,Force:true}); }
    catch(error) { if(!(error instanceof DockerError && [404,403].includes(error.status))) throw error; }
  }
  await ignored404('DELETE',`/networks/${n.network}`);
  if(purge) await ignored404('DELETE',`/volumes/${n.volume}`);
}
async function describe(id:string) {
  const n=names(id), info=await docker('GET',`/containers/${n.container}/json`);
  if(!info.State.Running) throw new Error('Worker stopped');
  return {id,host:info.NetworkSettings.Networks[n.network].IPAddress};
}
async function attach(network:string,container:string,alias:string) {
  const info=await docker('GET',`/containers/${container}/json`);
  if(!info.NetworkSettings.Networks[network]) await docker('POST',`/networks/${network}/connect`,{Container:container,EndpointConfig:{Aliases:[alias]}});
}
app.post('/list',async c=>mutex.withLock(async()=> {
  const workers=[];
  for(const item of (await list()).filter(w=>w.State==='running')) {
    const id=uuid(item.Labels[`${prefix}.owner`]), n=names(id);
    await attach(n.network,gateway,'gateway'); await attach(n.network,egress,'egress');
    workers.push(await describe(id));
  }
  return c.json({workers});
}));
app.post('/:action/:id',async c=>mutex.withLock(async()=> {
  const action=c.req.param('action'); if(!['start','stop','purge'].includes(action)) return c.notFound();
  let id:string; try { id=uuid(c.req.param('id')); } catch { return c.json({error:'Invalid id'},400); }
  if(action!=='start') { await stop(id,action==='purge'); return c.json({ok:true}); }
  const entries=await list();
  if(entries.some(w=>w.Labels[`${prefix}.owner`]===id && w.State==='running')) return c.json(await describe(id));
  if(entries.filter(w=>w.State==='running').length>=maximum) return c.json({error:'Capacity full'},429);
  // Clean up incomplete resources from a failed or interrupted start.
  await stop(id);
  const n=names(id), labels={ [label]:'worker',[`${prefix}.owner`]:id };
  try {
    await docker('POST','/volumes/create',{Name:n.volume,Labels:labels});
    await docker('POST','/networks/create',{Name:n.network,Internal:true,Labels:labels});
    for(const [container,alias] of [[gateway,'gateway'],[egress,'egress']]) await docker('POST',`/networks/${n.network}/connect`,{Container:container,EndpointConfig:{Aliases:[alias]}});
    await docker('POST','/containers/create?name='+n.container,{
      Image:image,Hostname:n.container,Labels:labels,
      Env:['APP_MODE=worker','PORT=3000','BIND_HOST=0.0.0.0','PLAYWRIGHT_HEADLESS=false','DISPLAY=:99','DEEPSEEK_PROFILE_DIR=/profile',`API_KEY=${workerToken(id,master)}`],
      HostConfig:{NetworkMode:n.network,ReadonlyRootfs:true,Init:true,ShmSize:512*1024*1024,Memory:1536*1024*1024,NanoCpus:1_000_000_000,PidsLimit:256,
        CapDrop:['ALL'],CapAdd:['CHOWN','SETUID','SETGID','DAC_OVERRIDE'],SecurityOpt:['no-new-privileges',`seccomp=${seccomp}`],
        Mounts:[{Type:'volume',Source:n.volume,Target:'/profile'}],Tmpfs:{'/tmp':'rw,nosuid,nodev,size=268435456','/home/node':'rw,nosuid,nodev,size=67108864'},
        LogConfig:{Type:'json-file',Config:{'max-size':'10m','max-file':'2'}}},
    });
    await docker('POST',`/containers/${n.container}/start`);
    const result=await describe(id);
    for(let attempt=0;attempt<45;attempt++) {
      const info=await docker('GET',`/containers/${n.container}/json`);
      if(info.State.Health?.Status==='healthy') return c.json(result);
      if(!info.State.Running) throw new Error('Worker exited');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw new Error('Worker startup timeout');
  } catch(error) { await stop(id).catch(()=>{}); throw error; }
}));
serve({fetch:app.fetch,hostname:'0.0.0.0',port:3001});
