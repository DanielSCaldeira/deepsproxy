const el = id => document.getElementById(id);
let remoteProvider, disconnectedProvider, accountList = [];
let csrf = '', me, mode = 'login', busy = false, refreshTask, rfb, RFB;
const linkToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (linkToken) history.replaceState(null, '', '/');
function notice(message = '') {
  for (const id of ['message', 'remote-message']) { el(id).textContent = message; el(id).hidden = !message; }
}
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
  el('keys').replaceChildren(); el('users').replaceChildren(); el('accounts').replaceChildren(); accountList = []; el('available-models').textContent = ''; remoteProvider = undefined;
}
function hideRemote() { el('remote-panel').hidden = true; document.body.classList.remove('remote-open'); }
function closeRemote() { disconnectedProvider = undefined; if (rfb) { const connection = rfb; rfb = undefined; connection.disconnect(); } hideRemote(); el('remote').replaceChildren(); }
async function copy(value) { try { await navigator.clipboard.writeText(value); notice('Copiado.'); } catch { notice('Selecione o texto e copie.'); } }
function textCell(row, text) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); return cell; }
function button(parent, title, run, danger = false) { const button = document.createElement('button'); button.textContent = title; button.className = danger ? 'danger' : 'secondary'; button.addEventListener('click', () => guarded(run)); parent.append(button); }
function needsLoginConfirmation(account) {
  return account?.manualLoginConfirmation ?? ['deepseek', 'chatgpt', 'claude', 'perplexity', 'cohere'].includes(account?.provider);
}
function updateRemoteConfirmation() {
  const account = accountList.find(account => account.provider === remoteProvider);
  el('remote-finish').hidden = !needsLoginConfirmation(account);
  el('remote-help').textContent = needsLoginConfirmation(account)
    ? 'Após entrar no ' + account.name + ' e ver o chat, clique em Concluir login nesta barra para validar e salvar sua sessão.'
    : 'Conclua a autenticação na tela remota. A tela fecha após a validação da sessão.';
}
async function guarded(run) { if (busy) return; busy = true; for (const b of document.querySelectorAll('button')) b.disabled = true; try { notice(); await run(); } catch (error) { notice(error.message); } finally { busy = false; for (const b of document.querySelectorAll('button')) b.disabled = false; } }
async function signedIn() {
  me = await api('/api/me'); csrf = me.csrf;
  el('authentication').hidden = true; el('dashboard').hidden = false; el('logout').hidden = false;
  el('who').textContent = me.email; el('administration').hidden = me.role !== 'admin';
  el('api-base').textContent = location.origin + '/v1'; await refresh(); await keys(); if (me.role === 'admin') await users();
}
const states = {
  authenticated: ['Conectada', 'good', 'Seu login está ativo. A tela de login fecha automaticamente após a confirmação.'],
  login_required: ['Login necessário', 'warn', 'Entre novamente para retomar o uso dos modelos.'],
  rate_limited: ['Limite de uso atingido', 'warn', 'Login ativo. Aguarde a liberação de uso pelo provedor.'],
  suspended: ['Suspensa pelo provedor', 'bad', 'Consulte o aviso no serviço antes de tentar novamente.'],
  not_initialized: ['Ainda não conectada', 'warn', 'Use Conectar para autenticar sua conta.'],
  unavailable: ['Não foi possível verificar', 'bad', 'Atualize o status ou recupere o navegador.'],
};
function renderAccounts(accounts) {
  const fragment = document.createDocumentFragment();
  for (const account of accounts) {
    const row = document.createElement('article'); row.className = 'account-row'; row.dataset.provider = account.provider;
    const heading = document.createElement('div'); heading.className = 'row';
    const title = document.createElement('h3'); title.textContent = account.name;
    const [label, tone, detail] = states[account.accountState] || states.unavailable;
    const restrictedLogin = account.accountState === 'suspended' && account.authenticated === true;
    const status = document.createElement('strong'); status.className = tone; status.dataset.field = 'state'; status.textContent = restrictedLogin ? 'Autenticada · conta bloqueada' : label;
    heading.append(title, status); row.append(heading);
    const description = document.createElement('p'); description.className = 'muted'; description.textContent = (restrictedLogin ? 'Login confirmado. O provedor bloqueou o uso da conta; os envios estão interrompidos.' : account.loginActive ? (needsLoginConfirmation(account) ? 'Entre no serviço e clique em Concluir login para validar e salvar sua sessão.' : 'Login em andamento. Conclua a autenticação na tela remota.') : detail) + (account.suspendedUntil ? ' Até: ' + account.suspendedUntil : ''); row.append(description);
    if (['suspended','rate_limited'].includes(account.accountState) && account.originalMessage) {
      const warning = document.createElement('p'); warning.dataset.field = 'provider-message'; warning.textContent = 'Aviso do provedor: ' + account.originalMessage; row.append(warning);
    }
    if (account.accountState === 'rate_limited' && account.nextAllowedAt) { const retry = document.createElement('p'); retry.textContent = 'Próxima tentativa: ' + new Date(account.nextAllowedAt).toLocaleString('pt-BR'); row.append(retry); }
    const meta = document.createElement('div'); meta.className = 'account-meta';
    const runtime = account.loginActive ? 'Login em andamento' : account.runtimeState === 'sleeping' ? 'Navegador em espera' : account.runtimeState === 'unavailable' ? 'Navegador indisponível' : account.busy ? 'Processando' : 'Navegador disponível';
    for (const text of [runtime, account.sessionSaved ? 'Sessão salva' : 'Sessão ainda não salva', account.checkedAt ? 'Verificação: ' + new Date(account.checkedAt).toLocaleString('pt-BR') : 'Aguardando primeira verificação', account.queueDepth ? account.queueDepth + ' chamada(s) na fila' : '']) {
      if (text) { const item = document.createElement('span'); item.textContent = text; meta.append(item); }
    }
    row.append(meta);
    const actions = document.createElement('div'); actions.className = 'actions'; actions.style.marginTop = '16px';
    button(actions, account.loginActive ? 'Abrir login' : account.authenticated || account.accountState === 'authenticated' ? 'Reconectar conta' : 'Conectar', () => account.loginActive ? remote(account.provider) : operation('connect', account.provider));
    if (account.loginActive && needsLoginConfirmation(account)) button(actions, 'Concluir login', () => operation('finish', account.provider));
    button(actions, 'Recuperar navegador', () => operation('recover', account.provider));
    button(actions, 'Desconectar', () => operation('disconnect', account.provider), true);
    row.append(actions); fragment.append(row);
  }
  el('accounts').replaceChildren(fragment);
  // Polling may finish while another action is pending.
  if (busy) for (const b of el('accounts').querySelectorAll('button')) b.disabled = true;
  const models = accounts.filter(account => account.accountState === 'authenticated').flatMap(account => account.models || []).map(model => typeof model === 'string' ? model : model.id);
  el('available-models').textContent = models.length ? models.join(', ') : 'Conecte um serviço para consultar os modelos.';
}
async function refresh(force = false) {
  if (!me) return;
  if (refreshTask) {
    await refreshTask;
    if (!force || !me) return;
  }
  // A completed login needs a new snapshot, even if polling was already active.
  const task = refreshAccounts();
  refreshTask = task;
  try { await task; } finally { if (refreshTask === task) refreshTask = undefined; }
}
async function refreshAccounts() {
  try {
    const data = await api('/api/me/accounts');
    if (!me) return;
    accountList = data.accounts; renderAccounts(accountList); updateRemoteConfirmation();
    const selected = accountList.find(account => account.provider === (disconnectedProvider || remoteProvider));
    if (selected && !selected.loginActive && (rfb || disconnectedProvider === selected.provider)) {
      closeRemote();
      if (selected.accountState === 'authenticated') notice(selected.name + ' conectado. A tela de login foi fechada automaticamente. Seus modelos estão disponíveis.');
      else if (selected.accountState === 'suspended') notice(selected.authenticated ? 'Login do ' + selected.name + ' confirmado e sessão salva. A conta está bloqueada pelo provedor; os envios estão interrompidos.' : 'A conta do ' + selected.name + ' está bloqueada pelo provedor. Consulte o aviso no painel.');
    }
  } catch (error) { notice(error.message); }
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
async function remote(provider) {
  if (!RFB) RFB = (await import('/novnc/core/rfb.js')).default;
  if (remoteProvider && remoteProvider !== provider) await api('/api/me/accounts/' + remoteProvider + '/connection/cancel','POST',{});
  closeRemote(); remoteProvider = provider;
  const data = await api('/api/me/accounts/' + provider + '/remote-ticket','POST',{});
  el('remote-title').textContent = 'Entre no ' + (accountList.find(account => account.provider === provider)?.name || provider);
  updateRemoteConfirmation();
  el('remote-panel').hidden = false;
  document.body.classList.add('remote-open');
  el('remote-fit').textContent = 'Ajustar à tela';
  el('remote-fit').setAttribute('aria-pressed', 'false');
  rfb = new RFB(el('remote'), (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/me/remote?ticket=' + encodeURIComponent(data.ticket),{ shared:false });
  rfb.scaleViewport = false; rfb.clipViewport = false; rfb.resizeSession = false;
  const current = rfb;
  current.addEventListener('disconnect',()=> { if (rfb === current) { disconnectedProvider = remoteProvider; rfb = undefined; hideRemote(); void refresh(); } });
  el('remote-fit').focus();
}
async function operation(action, provider) {
  if (action === 'disconnect' && !confirm('Desconectar e apagar a sessão ' + provider + ' salva? Você precisará fazer login novamente.')) return;
  if (action !== 'finish' && (remoteProvider === provider || action === 'connect')) closeRemote();
  const data = await api('/api/me/accounts/' + provider + '/connection/'+action,'POST',{});
  if (data.operationId) {
    notice(action === 'finish' ? 'Validando e salvando sua sessão…' : 'Preparando sua conexão…');
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve,2000));
      const result = await api('/api/me/operations/'+data.operationId);
      if (result.status === 'failed') throw new Error(result.error);
      if (result.status === 'done') {
        notice();
        if (action === 'connect') { try { await remote(provider); } catch { await refresh(true); } }
        await refresh(true);
        if (action === 'finish') {
          const account = accountList.find(account => account.provider === provider);
          if ((account?.authenticated || account?.accountState === 'authenticated') && account.sessionSaved) {
            notice(account.accountState === 'suspended'
              ? 'Login do ' + account.name + ' confirmado e sessão salva. A conta está bloqueada pelo provedor; os envios estão interrompidos.'
              : account.name + ' conectado. Sessão salva.' + (account.accountState === 'rate_limited' ? ' Limite de uso atingido; aguarde a liberação pelo provedor.' : ' Seus modelos estão disponíveis.'));
          }
        }
        return;
      }
    }
    throw new Error('A operação continua em andamento. Atualize o status em instantes.');
  }
}
el('auth-form').addEventListener('submit',event => { event.preventDefault(); void guarded(async () => { const path = '/api/auth/' + (mode === 'redeem' ? 'redeem' : mode === 'setup' ? 'setup' : 'login'); await api(path,'POST',{ email:el('email').value, password:el('password').value, token:mode === 'redeem' ? linkToken : el('bootstrap').value }); el('password').value=''; el('bootstrap').value=''; await signedIn(); }); });
el('logout').onclick = () => guarded(async () => { await api('/api/auth/logout','POST',{}); me = null; closeRemote(); showAuth(); });
el('refresh').onclick = () => guarded(() => refresh(true));
el('remote-fit').onclick = () => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  el('remote-fit').textContent = rfb.scaleViewport ? 'Tamanho real (100%)' : 'Ajustar à tela';
  el('remote-fit').setAttribute('aria-pressed', String(rfb.scaleViewport));
};
el('remote-close').onclick = () => guarded(async () => { if (remoteProvider) await api('/api/me/accounts/' + remoteProvider + '/connection/cancel','POST',{}); closeRemote(); remoteProvider = undefined; await refresh(); });
el('remote-finish').onclick = () => guarded(async () => { if (remoteProvider) await operation('finish', remoteProvider); });
el('remote-retry').onclick = () => guarded(async () => { const provider = remoteProvider; if (!provider) return; await api('/api/me/accounts/' + provider + '/connection/cancel','POST',{}); closeRemote(); await operation('connect', provider); });
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
