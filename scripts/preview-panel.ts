import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { panelPage } from '../src/production/panel.ts';

// Visual review only: no database, Docker, real keys, or provider calls.
const app = new Hono();
const states = new Map<string,string>();
const keys = new Map<string,any[]>();
const users = [
  {id:'admin-demo',email:'admin@example.com',role:'admin',blocked:false},
  {id:'user-demo',email:'usuario@example.com',role:'user',blocked:false},
  {id:'blocked-demo',email:'convidado@example.com',role:'user',blocked:true},
];
const views = ['user','admin','login','setup','invite'];
const view = (url:string) => { const name=new URL(url).searchParams.get('preview') || 'user'; return views.includes(name)?name:'user'; };
const banner = `<style>aside a{color:#b8e8ff;text-decoration:underline;text-underline-offset:3px}</style><aside style="padding:16px 24px;background:#293b37;border-bottom:1px solid #537565;color:#ddfff1;font:14px system-ui;line-height:1.8">
<strong>PRÉVIA LOCAL · Dados fictícios</strong> · Login, chaves e ações são simulados.<br>
<nav style="display:flex;gap:18px;flex-wrap:wrap"><a href="/?preview=user">Usuário</a><a href="/?preview=admin#administration">Administração</a><a href="/?preview=login">Login</a><a href="/?preview=setup">Primeiro acesso</a><a href="/?preview=invite#token=convite-ficticio">Convite / nova senha</a></nav>
<label style="display:inline-flex;align-items:center;gap:12px;margin:8px 0 0">Status da conta:
<select id="preview-state" style="padding:7px;border-radius:7px;background:#14232a;color:white"><option value="authenticated">Conectada</option><option value="login_required">Login necessário</option><option value="suspended">Suspensa pelo DeepSeek</option><option value="not_initialized">Ainda não conectada</option><option value="unavailable">Indisponível</option><option value="sleeping">Navegador em espera</option></select></label></aside>`;
app.use('*',async(c,next)=> { c.header('Cache-Control','no-store'); await next(); });
app.get('/',c=>c.html(panelPage.replace('<body>','<body>'+banner)));
app.get('/assets/panel.js',async c=> {
  const source=await readFile(new URL('../public/panel.js',import.meta.url),'utf8');
  const prefix=`const previewView = new URLSearchParams(location.search).get('preview') || 'user';
function previewUrl(path) { return path + (path.includes('?')?'&':'?') + 'preview=' + encodeURIComponent(previewView); }
document.getElementById('preview-state').addEventListener('change',async event=> { await fetch(previewUrl('/__preview/state'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:event.target.value})}); document.getElementById('refresh').click(); });
`;
  return c.body(prefix+source.replace('fetch(path,','fetch(previewUrl(path),'),200,{'Content-Type':'text/javascript; charset=utf-8'});
});
app.post('/__preview/state',async c=> { states.set(view(c.req.url),(await c.req.json()).state); return c.json({ok:true}); });
app.get('/novnc/core/rfb.js',c=>c.body(`export default class Preview {
  constructor(target) {
    target.innerHTML='<div style="padding:36px;text-align:center;color:#daeaf5;font-family:system-ui"><h2>Tela do navegador remoto</h2><p>Em produção, o DeepSeek da VPS aparece aqui para concluir o login.</p><p>Esta prévia não solicita senha nem acessa sua conta.</p><button id="simulate-login" style="padding:12px;border-radius:8px;cursor:pointer">Simular login concluído</button></div>';
    target.querySelector('button').onclick=async()=> { const name=new URLSearchParams(location.search).get('preview') || 'user'; await fetch('/__preview/state?preview='+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:'authenticated'})}); document.getElementById('refresh').click(); };
  }
  addEventListener() {} disconnect() {}
}`,200,{'Content-Type':'text/javascript'}));
app.all('/api/*',async c=> {
  const name=view(c.req.url), path=c.req.path;
  const signed=c.req.header('Cookie')?.includes('preview_signed=yes');
  const authenticated=['user','admin'].includes(name)||signed;
  if(path==='/api/auth/state') return c.json({setupRequired:name==='setup'&&!signed});
  if(['/api/auth/login','/api/auth/setup','/api/auth/redeem'].includes(path)) { c.header('Set-Cookie','preview_signed=yes; Path=/; HttpOnly; SameSite=Strict'); return c.json({csrf:'demo'}); }
  if(path==='/api/auth/logout') { c.header('Set-Cookie','preview_signed=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'); return c.json({ok:true}); }
  if(!authenticated) return c.json({error:{message:'Entre no painel de demonstração.'}},401);
  if(path==='/api/me') return c.json({...users[name==='admin'?0:1],csrf:'demo'});
  if(path==='/api/me/status') { const state=states.get(name)||'authenticated'; return c.json({state,accountState:state==='sleeping'?'authenticated':state==='connecting'?'login_required':state,runtimeState:state==='sleeping'?'sleeping':state==='unavailable'?'unavailable':'running',sessionSaved:!['login_required','not_initialized'].includes(state),checkedAt:new Date().toISOString(),busy:false,loginActive:state==='connecting',queueDepth:0}); }
  if(path==='/api/me/keys') {
    if(!keys.has(name)) keys.set(name,[{id:'key-example',name:'Zed pessoal',prefix:'dsp_EXEMPLO',revoked_at:null}]);
    if(c.req.method==='POST') { const id=randomUUID(); keys.get(name)!.push({id,name:(await c.req.json()).name,prefix:'dsp_EXEMPLO',revoked_at:null}); return c.json({id,key:'dsp_EXEMPLO_SEM_VALIDADE_EM_PRODUCAO'}); }
    return c.json({keys:keys.get(name)});
  }
  if(path.startsWith('/api/me/keys/')) { const key=keys.get(name)?.find(k=>k.id===path.split('/').at(-1)); if(key) key.revoked_at=new Date().toISOString(); return c.json({ok:true}); }
  if(path.startsWith('/api/me/connection/')) { const action=path.split('/').at(-1); states.set(name,action==='connect'?'connecting':action==='disconnect'?'login_required':action==='cancel'?'login_required':'authenticated'); return c.json({operationId:'demo'}); }
  if(path.startsWith('/api/me/operations/')) return c.json({status:'done'});
  if(path==='/api/me/remote-ticket') return c.json({ticket:'demo'});
  if(path==='/api/admin/status') return c.json({activeBrowsers:2,capacity:5,remoteLogins:0});
  if(path==='/api/admin/users') return c.json({users});
  if(path==='/api/admin/audit') return c.json({events:[{created_at:new Date().toISOString(),action:'Convite de demonstração criado'},{created_at:new Date().toISOString(),action:'Usuário de demonstração conectado'}]});
  if(path==='/api/admin/invite') { const email=(await c.req.json()).email; users.push({id:randomUUID(),email,role:'user',blocked:false}); return c.json({url:'http://127.0.0.1:3300/?preview=invite#token=convite-ficticio'}); }
  if(path.endsWith('/reset')) return c.json({url:'http://127.0.0.1:3300/?preview=invite#token=recuperacao-ficticia'});
  if(path.endsWith('/block')) { const user=users.find(u=>u.id===path.split('/').at(-2)); if(user) user.blocked=(await c.req.json()).blocked; return c.json({ok:true}); }
  return c.json({error:{message:'Ação indisponível nesta prévia.'}},404);
});
serve({fetch:app.fetch,hostname:'127.0.0.1',port:3300});
console.info('Prévia local: http://127.0.0.1:3300/?preview=user');
