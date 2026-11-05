import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const action=process.argv[2]||'up';
if(action==='up') {
  docker(['--profile','images','build']);
  docker(['up','-d','--wait']);
  console.log('');
  console.log('Ambiente de teste (real local) no ar:');
  console.log('  Login/painel:  http://localhost:3440  (1º acesso: "Configurar administrador" com o BOOTSTRAP_TOKEN)');
  console.log('  Convites:      http://localhost:3440/#token=...  (link gerado no painel admin, válido por 24h)');
  console.log('  API OpenAI:    http://localhost:3440/v1  (use uma chave dsp_ gerada no painel)');
  console.log('  Token do primeiro setup: .cache/proxy-ia-live.env (BOOTSTRAP_TOKEN)');
  console.log('  Logs: make live-logs | Navegadores: make live-workers | Parar: make live-stop');
} else if(action==='stop') {
  // Dynamic browsers are outside Compose; stop only resources owned by this lab.
  const result=spawnSync('docker',['ps','-q','--filter','label=dsp_live.managed=worker'],{cwd:root,encoding:'utf8'});
  if(result.status!==0) process.exit(result.status||1);
  docker(['stop']);
  for(const id of result.stdout.trim().split(/\s+/).filter(Boolean)) {
    const stopped=spawnSync('docker',['stop',id],{cwd:root,stdio:'inherit'});
    if(stopped.status!==0) process.exit(stopped.status||1);
  }
} else if(action==='status') docker(['ps']);
else throw new Error('Use up, stop or status.');
