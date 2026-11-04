const el = id => document.getElementById(id);
let csrf = '', me, mode = 'login', busy = false, refreshing = false, rfb, RFB;
const linkToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (linkToken) history.replaceState(null, '', '/');
function notice(message = '') { el('message').textContent = message; el('message').hidden = !message; }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && me) { me = null; closeRemote(); showAuth(); } throw new Error(data.error?.message || 'Não foi possível concluir a operação.'); }
  return data;
}
function showAuth() {
  el('authentication').hidden = false; el('dashboard').hidden = true; el('logout').hidden = true; el('who').textContent = ''; csrf = '';
  for (const id of ['key-secret','link-value','audit']) el(id).textContent = '';
  for (const id of ['new-key','share-link']) el(id).hidden = true;
  el('keys').replaceChildren(); el('users').replaceChildren();
}
function closeRemote() { if (rfb) { const connection = rfb; rfb = undefined; connection.disconnect(); } el('remote-panel').hidden = true; el('remote').replaceChildren(); }
async function copy(value) { try { await navigator.clipboard.writeText(value); notice('Copiado.'); } catch { notice('Selecione o texto e copie.'); } }
function textCell(row, text) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); return cell; }
function button(parent, title, run, danger = false) { const button = document.createElement('button'); button.textContent = title; button.className = danger ? 'danger' : 'secondary'; button.addEventListener('click', () => guarded(run)); parent.append(button); }
async function guarded(run) { if (busy) return; busy = true; for (const b of document.querySelectorAll('button')) b.disabled = true; try { notice(); await run(); } catch (error) { notice(error.message); } finally { busy = false; for (const b of document.querySelectorAll('button')) b.disabled = false; } }
async function signedIn() {
  me = await api('/api/me'); csrf = me.csrf;
  el('authentication').hidden = true; el('dashboard').hidden = false; el('logout').hidden = false;
  el('who').textContent = me.email; el('administration').hidden = me.role !== 'admin';
  el('api-base').textContent = location.origin + '/v1'; await refresh(); await keys(); if (me.role === 'admin') await users();
}
const states = {
  authenticated: ['Conectada', 'good', 'Seu login foi reconhecido pelo DeepSeek.'],
  login_required: ['Login necessário', 'warn', 'Entre novamente para retomar o uso da API.'],
  suspended: ['Suspensa pelo DeepSeek', 'bad', 'O provedor informou uma suspensão. Recuperar o navegador não remove essa restrição.'],
  not_initialized: ['Ainda não conectada', 'warn', 'Use Conectar para entrar na sua conta DeepSeek.'],
  unavailable: ['Não foi possível verificar', 'bad', 'Tente atualizar o status ou recuperar o navegador.'],
};
async function refresh() {
  if (!me || refreshing) return;
  refreshing = true;
  try {
    const state = await api('/api/me/status');
    const [label, tone, detail] = states[state.accountState] || states.unavailable;
    el('account-state').textContent = label; el('account-state').className = 'value ' + tone;
    el('account-detail').textContent = detail + (state.suspendedUntil ? ' Até: ' + state.suspendedUntil : '');
    const runtime = state.loginActive ? 'Login em andamento' : state.runtimeState === 'sleeping' ? 'Em espera' : state.runtimeState === 'unavailable' ? 'Indisponível' : state.busy ? 'Processando' : 'Disponível';
    el('runtime-state').textContent = runtime;
    el('runtime-detail').textContent = state.runtimeState === 'sleeping' ? 'Será iniciado automaticamente no próximo uso. O status da conta é o da última verificação.' : state.runtimeState === 'unavailable' ? 'O status da conta é o da última verificação. A recuperação automática está em andamento.' : state.queueDepth ? state.queueDepth + ' chamada(s) na fila.' : 'Navegador exclusivo da sua conta.';
    el('saved-state').textContent = state.sessionSaved ? 'Salva na VPS' : 'Ainda não salva';
    el('checked-at').textContent = state.checkedAt ? 'Última verificação: ' + new Date(state.checkedAt).toLocaleString('pt-BR') : 'Aguardando a primeira verificação.';
    el('connection-hint').textContent = state.loginActive ? 'Conclua o login na tela abaixo. As chamadas à API aguardam o encerramento deste processo.' : state.accountState === 'authenticated' ? 'Sua sessão será reutilizada. Se o provedor solicitar, você poderá entrar novamente por aqui.' : detail;
    if (!state.loginActive && rfb) { closeRemote(); if (state.accountState === 'authenticated') notice('DeepSeek conectado. Você já pode gerar uma chave.'); }
  } catch (error) { notice(error.message); } finally { refreshing = false; }
}
async function keys() {
  const data = await api('/api/me/keys'); el('keys').replaceChildren();
  for (const key of data.keys) { const row = document.createElement('tr'); textCell(row,key.name); textCell(row,key.prefix + '…'); textCell(row,key.revoked_at ? 'Revogada' : 'Ativa'); const actions = textCell(row,''); if (!key.revoked_at) button(actions,'Revogar',async () => { if (confirm('Revogar esta chave? Os aplicativos que a usam perderão o acesso.')) { await api('/api/me/keys/' + key.id,'DELETE'); await keys(); } },true); el('keys').append(row); }
}
async function users() {
  const health = await api('/api/admin/status'); el('admin-health').textContent = 'Banco disponível · ' + health.activeBrowsers + ' de ' + health.capacity + ' navegadores ativos · ' + health.remoteLogins + ' login(s) em andamento.';
  const data = await api('/api/admin/users'); el('users').replaceChildren();
  for (const user of data.users) { const row = document.createElement('tr'); textCell(row,user.email); textCell(row,user.role === 'admin' ? 'Administrador' : 'Usuário'); textCell(row,user.blocked ? 'Bloqueado' : 'Permitido'); const actions = textCell(row,''); actions.className = 'actions'; button(actions,'Novo link de acesso',async () => share(await api('/api/admin/users/'+user.id+'/reset','POST',{}))); if (user.id !== me.id) button(actions,user.blocked?'Desbloquear':'Bloquear',async () => { await api('/api/admin/users/'+user.id+'/block','POST',{blocked:!user.blocked}); await users(); },!user.blocked); el('users').append(row); }
  const audit = await api('/api/admin/audit'); el('audit').textContent = audit.events.map(event => new Date(event.created_at).toLocaleString('pt-BR')+' · '+event.action).join('\n') || 'Nenhuma atividade.';
}
function share(data) { el('link-value').textContent = data.url; el('share-link').hidden = false; }
async function remote() {
  if (!RFB) RFB = (await import('/novnc/core/rfb.js')).default;
  closeRemote();
  const data = await api('/api/me/remote-ticket','POST',{});
  el('remote-panel').hidden = false;
  rfb = new RFB(el('remote'), 'wss://' + location.host + '/api/me/remote?ticket=' + encodeURIComponent(data.ticket),{ shared:false });
  rfb.scaleViewport = true; rfb.resizeSession = false;
  const current = rfb;
  current.addEventListener('disconnect',()=> { if (rfb === current) { rfb = undefined; el('remote-panel').hidden = true; void refresh(); } });
  el('remote-panel').scrollIntoView({behavior:'smooth',block:'start'});
}
async function operation(action) {
  if (action === 'disconnect' && !confirm('Desconectar e apagar a sessão DeepSeek salva? Você precisará fazer login novamente.')) return;
  if (action !== 'connect') closeRemote();
  const data = await api('/api/me/connection/'+action,'POST',{});
  if (data.operationId) {
    notice('Preparando sua conexão…');
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve,2000));
      const result = await api('/api/me/operations/'+data.operationId);
      if (result.status === 'failed') throw new Error(result.error);
      if (result.status === 'done') { notice(); if (action === 'connect') { try { await remote(); } catch { await refresh(); } } await refresh(); return; }
    }
    throw new Error('A operação continua em andamento. Atualize o status em instantes.');
  }
}
el('auth-form').addEventListener('submit',event => { event.preventDefault(); void guarded(async () => { const path = '/api/auth/' + (mode === 'redeem' ? 'redeem' : mode === 'setup' ? 'setup' : 'login'); await api(path,'POST',{ email:el('email').value, password:el('password').value, token:mode === 'redeem' ? linkToken : el('bootstrap').value }); el('password').value=''; el('bootstrap').value=''; await signedIn(); }); });
el('logout').onclick = () => guarded(async () => { await api('/api/auth/logout','POST',{}); me = null; closeRemote(); showAuth(); });
el('refresh').onclick = () => guarded(refresh);
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => guarded(() => operation(button.dataset.action));
el('remote-close').onclick = () => guarded(async () => { await api('/api/me/connection/cancel','POST',{}); closeRemote(); await refresh(); });
el('remote-retry').onclick = () => guarded(async () => { await api('/api/me/connection/cancel','POST',{}); closeRemote(); await operation('connect'); });
el('key-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { const data = await api('/api/me/keys','POST',{name:el('key-name').value}); el('key-secret').textContent=data.key; el('new-key').hidden=false; el('key-name').value=''; await keys(); }); };
el('dismiss-key').onclick = () => { el('key-secret').textContent=''; el('new-key').hidden=true; };
el('copy-key').onclick = () => copy(el('key-secret').textContent);
el('copy-base').onclick = () => copy(el('api-base').textContent);
el('copy-link').onclick = () => copy(el('link-value').textContent);
el('invite-form').onsubmit = event => { event.preventDefault(); void guarded(async () => { share(await api('/api/admin/invite','POST',{email:el('invite-email').value})); el('invite-email').value=''; await users(); }); };
async function init() {
  if (linkToken) mode='redeem';
  else { try { await signedIn(); return; } catch { const state = await api('/api/auth/state'); if (state.setupRequired) mode='setup'; } }
  showAuth();
  if (mode !== 'login') { el('auth-title').textContent=mode==='setup'?'Configurar administrador':'Definir minha senha'; el('auth-submit').textContent='Salvar e entrar'; el('password').autocomplete='new-password'; el('auth-description').textContent=mode==='setup'?'Crie o primeiro acesso administrativo.':'Defina uma senha para acessar sua conta no painel.'; el('email-label').hidden=mode==='redeem'; el('email').required=mode!=='redeem'; el('bootstrap-label').hidden=mode!=='setup'; el('bootstrap').required=mode==='setup'; }
}
void init().catch(error => notice(error.message));
setInterval(()=>void refresh(),15000);
