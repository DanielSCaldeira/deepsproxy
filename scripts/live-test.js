import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const envPath=new URL('../.cache/proxy-ia-live.env',import.meta.url);
await mkdir(new URL('../.cache/',import.meta.url),{recursive:true});
try { await readFile(envPath); }
catch(error) {
  if(error.code!=='ENOENT') throw error;
  const secret=()=>randomBytes(32).toString('hex');
  await writeFile(envPath,`DOMAIN=localhost\nPOSTGRES_PASSWORD=${secret()}\nBOOTSTRAP_TOKEN=${secret()}\nPROVISIONER_TOKEN=${secret()}\nWORKER_MASTER_SECRET=${secret()}\nMAX_ACTIVE_BROWSERS=2\nDEEPSPROXY_IMAGE_TAG=live\n`,{mode:0o600,flag:'wx'});
}
const args=['compose','--env-file',fileURLToPath(envPath),'-f','compose.live.yml'];
function docker(extra) {
  const result=spawnSync('docker',[...args,...extra],{cwd:root,stdio:'inherit'});
  if(result.error) throw result.error;
  if(result.status!==0) process.exit(result.status||1);
}
// Describes every port of the live lab; published host ports come from Docker, not from this table.
const SERVICES={
  gateway:{label:'gateway',port:3000,what:'Painel/login, API OpenAI e tela remota'},
  provisioner:{label:'provisioner',port:3001,what:'Cria/para os navegadores das contas (workers)'},
  postgres:{label:'postgres',port:5432,what:'Banco de dados do ambiente live'},
  egress:{label:'egress',port:3128,what:'Proxy de saída (squid) dos navegadores'},
};
const GATEWAY_PATHS=[
  ['/','Painel e login (1º acesso: "Configurar administrador" com o BOOTSTRAP_TOKEN de .cache/proxy-ia-live.env)'],
  ['/#token=...','Convites / recuperação (link gerado no painel admin, válido por 24h)'],
  ['/v1','API OpenAI (use uma chave dsp_ gerada no painel)'],
  ['/health','Healthcheck do gateway'],
];
function composeServices() {
  const result=spawnSync('docker',[...args,'ps','-a','--format','json'],{cwd:root,encoding:'utf8'});
  if(result.status!==0) return null;
  const text=result.stdout.trim();
  if(!text) return [];
  if(text.startsWith('[')) return JSON.parse(text);
  return text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
function printPorts() {
  const services=composeServices();
  if(!services) { console.log('');
    console.log('Não foi possível consultar o Docker (Docker Desktop está aberto?). Portas esperadas: http://localhost:3440 (painel e API /v1).');
    return; }
  const byName=new Map(services.map(s=>[s.Service,s]));
  const state=name=>byName.get(name)?.State||'parado';
  console.log('');
  console.log('Portas no seu computador (host):');
  let published=0;
  for(const s of services) {
    const seen=new Set();
    for(const p of s.Publishers||[]) {
      if(!p.PublishedPort||seen.has(p.PublishedPort)) continue;
      seen.add(p.PublishedPort); published++;
      const host=!p.URL||p.URL==='0.0.0.0'||p.URL==='::'?'localhost':p.URL==='127.0.0.1'?'localhost':p.URL;
      console.log(`  http://${host}:${p.PublishedPort}  → ${s.Service} :${p.TargetPort} (${s.State})`);
      if(s.Service==='gateway') for(const [path,what] of GATEWAY_PATHS) console.log(`      ${path.padEnd(12)} ${what}`);
    }
  }
  if(!published) console.log('  nenhuma — ambiente parado (suba com: make live)');
  console.log('');
  console.log('Portas internas (só na rede Docker, não acessíveis do host):');
  for(const [name,info] of Object.entries(SERVICES)) {
    const pub=(byName.get(name)?.Publishers||[]).find(p=>p.PublishedPort);
    const extra=pub?` (publicado no host como ${pub.PublishedPort})`:'';
    console.log(`  ${info.label.padEnd(12)} :${String(info.port).padEnd(5)} ${info.what}${extra} [${state(name)}]`);
  }
  console.log('');
  console.log('Navegadores (workers) ativos:');
  const workers=spawnSync('docker',['ps','--filter','label=dsp_live.managed=worker','--format','{{.Names}}\t{{.Label "dsp_live.provider"}}\t{{.Status}}'],{cwd:root,encoding:'utf8'});
  const rows=workers.status===0?workers.stdout.trim().split(/\r?\n/).filter(Boolean):[];
  if(!rows.length) console.log('  nenhum — abrem ao clicar em Conectar no card do serviço no painel');
  for(const row of rows) {
    const [name,provider,status]=row.split('\t');
    console.log(`  ${name} (${provider||'?'}, ${status}) — :3000 API do navegador, :5900 VNC da tela remota (acessados pelo painel)`);
  }
  console.log('');
  console.log('Atalhos: make live-logs | make live-workers | make live-ports | make live-stop');
}
const action=process.argv[2]||'up';
// Fail early with a readable message when the Docker engine is not running.
if(spawnSync('docker',['version','--format','{{.Server.Version}}'],{cwd:root,stdio:'ignore'}).status!==0) {
  console.error('Docker não está em execução. Abra o Docker Desktop, aguarde ficar "running" e rode o comando de novo.');
  console.error('Portas do ambiente live quando estiver no ar: http://localhost:3440 (painel, login e API /v1).');
  process.exit(1);
}
if(action==='up') {
  docker(['--profile','images','build']);
  docker(['up','-d','--wait']);
  console.log('');
  console.log('Ambiente de teste (real local) no ar.');
  printPorts();
} else if(action==='stop') {
  // Dynamic browsers are outside Compose; stop only resources owned by this lab.
  const result=spawnSync('docker',['ps','-q','--filter','label=dsp_live.managed=worker'],{cwd:root,encoding:'utf8'});
  if(result.status!==0) process.exit(result.status||1);
  docker(['stop']);
  for(const id of result.stdout.trim().split(/\s+/).filter(Boolean)) {
    const stopped=spawnSync('docker',['stop',id],{cwd:root,stdio:'inherit'});
    if(stopped.status!==0) process.exit(stopped.status||1);
  }
} else if(action==='status') { docker(['ps']); printPorts(); }
else if(action==='ports') printPorts();
else if(action==='worker-logs') {
  // Follows every active browser; lives here because Windows make cannot spawn long inline node -e commands.
  const result=spawnSync('docker',['ps','-q','--filter','label=dsp_live.managed=worker'],{cwd:root,encoding:'utf8'});
  if(result.status!==0) process.exit(result.status||1);
  const ids=result.stdout.trim().split(/\s+/).filter(Boolean);
  if(!ids.length) console.log('Nenhum navegador (worker) ativo.');
  for(const id of ids) spawn('docker',['logs','-f','--tail','50',id],{cwd:root,stdio:'inherit'});
}
else throw new Error('Use up, stop, status, ports or worker-logs.');
