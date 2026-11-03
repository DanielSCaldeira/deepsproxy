export const statusPage = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepsProxy · Status</title>
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#101418;color:#edf2f4}
    *{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:auto;padding:52px 24px}
    header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:48px}
    .brand{font-weight:750;font-size:22px;letter-spacing:-.6px}.brand span{color:#80d8b5}small,.muted{color:#9aa8b2}
    h1{font-size:clamp(28px,5vw,42px);letter-spacing:-1px;margin:0 0 12px}p{line-height:1.6}
    .intro{margin-bottom:28px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .card,.panel{background:#181f25;border:1px solid #2b363e;border-radius:14px;padding:24px}
    .label{font-size:13px;color:#aab8c2;margin:0 0 18px}.value{font-size:21px;font-weight:650;display:block;margin-bottom:10px}
    .good{color:#80d8b5}.warn{color:#ffd28c}.bad{color:#ff9a9a}.panel{margin-top:20px}
    h2{font-size:18px;margin:0 0 18px}code{font-family:ui-monospace,Consolas,monospace;font-size:14px;overflow-wrap:anywhere}
    .url{background:#101418;padding:16px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;gap:16px}
    button{background:#253b35;color:#b5f1d9;border:1px solid #3c6153;border-radius:8px;padding:10px 16px;cursor:pointer;font:inherit;font-size:14px}
    button:hover{background:#315044}button:disabled{opacity:.6;cursor:wait}a{color:#a3d6ff;text-decoration:none}a:hover{text-decoration:underline}
    .links{display:flex;gap:24px;flex-wrap:wrap;margin:20px 0 0}.foot{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:26px;font-size:12px;color:#9aa8b2}
    #notice{background:#302b21;border:1px solid #685433;color:#ffdfa9;border-radius:10px;padding:16px;margin-bottom:20px;line-height:1.6}
    input{background:#101418;border:1px solid #4d5b65;border-radius:8px;padding:12px;color:#fff;font:inherit;min-width:0;flex:1}
    form{display:flex;gap:12px;margin-top:12px}#auth{margin-bottom:20px}#auth p{margin:0 0 8px}[hidden]{display:none!important}
    .detail{font-size:13px;line-height:1.6;color:#aab8c2;margin:0}
    @media(max-width:700px){main{padding-top:28px}.cards{grid-template-columns:1fr}header{margin-bottom:32px}.url{align-items:flex-start;flex-direction:column}form{flex-wrap:wrap}}
  </style>
</head>
<body><main>
  <header><div class="brand">Deeps<span>Proxy</span></div><button id="refresh" type="button">Atualizar status</button></header>
  <div class="intro"><h1>Status da conexão</h1><p class="muted">Acompanhe o servidor local e a sessão do DeepSeek.</p></div>
  <div id="notice" role="status" hidden></div>
  <section class="panel" id="auth" hidden>
    <h2>Acesso protegido</h2><p class="detail">Informe a chave configurada no proxy para consultar o status. Ela permanece apenas nesta página.</p>
    <form id="auth-form"><input id="api-key" type="password" autocomplete="off" placeholder="Chave da API" aria-label="Chave da API" required><button>Consultar status</button></form>
  </section>
  <section class="cards" aria-live="polite">
    <article class="card"><p class="label">SERVIDOR LOCAL</p><strong class="value" id="server">Verificando…</strong><p class="detail" id="server-detail">Consultando o proxy.</p></article>
    <article class="card"><p class="label">CONTA DEEPSEEK</p><strong class="value" id="session">Verificando…</strong><p class="detail" id="session-detail">Verificando a autenticação.</p></article>
    <article class="card"><p class="label">SESSÃO SALVA</p><strong class="value" id="saved">Verificando…</strong><p class="detail" id="saved-detail">Conferindo a persistência do login.</p></article>
  </section>
  <section class="panel"><h2>Conectar seu aplicativo</h2><p class="detail" style="margin-bottom:16px">Use este endereço como URL base no Zed, Continue ou outro cliente compatível.</p>
    <div class="url"><code id="base"></code><button id="copy" type="button">Copiar endereço</button></div>
    <p class="detail" style="margin-top:16px">Modelo: <code>deepseek-v4-flash</code></p>
    <nav class="links"><a href="/docs">Documentação da API ↗</a><a href="/health">Saúde do servidor ↗</a><a href="/v1/models">Modelos disponíveis ↗</a></nav>
  </section>
  <footer class="foot"><span id="updated">Aguardando primeira consulta</span><span>Atualização automática a cada 15 segundos</span></footer>
</main>
<script>
  const el = id => document.getElementById(id);
  let key = '', pending = false;
  el('base').textContent = location.origin + '/v1';
  function value(id, text, tone) { el(id).textContent = text; el(id).className = 'value ' + tone; }
  async function refresh() {
    if (pending) return;
    pending = true; el('refresh').disabled = true;
    try {
      const response = await fetch('/api/status', { headers: key ? {Authorization:'Bearer ' + key} : {}, cache:'no-store', signal:AbortSignal.timeout(30000) });
      if (response.status === 401) {
        el('auth').hidden = false;
        value('server', 'Acesso protegido', 'warn');
        value('session', 'Aguardando chave', 'warn'); value('saved', 'Aguardando chave', 'warn');
        el('notice').textContent = 'Informe uma chave válida para consultar a conexão e a sessão salva.';
        el('notice').hidden = false; return;
      }
      if (!response.ok) throw new Error('status');
      const data = await response.json();
      el('auth').hidden = true; el('notice').hidden = true;
      value('server', 'Em execução', 'good');
      el('server-detail').textContent = 'Ativo há ' + Math.floor(data.uptimeSeconds / 60) + ' min · API disponível.';
      const states = {
        authenticated:['Conectada','good','Login reconhecido pelo DeepSeek.'],
        login_required:['Login necessário','warn','A sessão precisa ser autenticada novamente.'],
        not_initialized:['Aguardando navegador','warn','O navegador do proxy ainda não está disponível.'],
        unavailable:['Indisponível','bad','Não foi possível verificar o chat do DeepSeek.']
      };
      const state = data.deepseek.profileInUse ? ['Perfil em uso','warn','Outro processo está usando o perfil do DeepSeek.'] : states[data.deepseek.state] || states.unavailable;
      value('session',state[0],state[1]);
      el('session-detail').textContent = state[2] + (data.deepseek.busy ? ' Há uma consulta em andamento.' : '');
      value('saved',data.deepseek.sessionSaved ? 'Salva neste computador' : 'Ainda não salva',data.deepseek.sessionSaved ? 'good' : 'warn');
      el('saved-detail').textContent = data.deepseek.sessionSaved ? 'A sessão será reutilizada ao reiniciar. O DeepSeek pode exigir novo login se ela expirar.' : 'O login será salvo após confirmar a autenticação.';
      if (data.deepseek.profileInUse) {
        el('notice').textContent = 'Se a janela de login estiver aberta, conclua o login nela. O proxy se conectará automaticamente após a confirmação. Caso contrário, encerre o outro processo que está usando o perfil.';
        el('notice').hidden = false;
      } else if (data.deepseek.state === 'login_required' || data.deepseek.state === 'not_initialized') {
        el('notice').textContent = 'Se houver uma janela do DeepSeek aberta, faça o login nela e mantenha-a aberta: a API utiliza essa mesma sessão. Caso contrário, pare o proxy e execute npm run login na pasta do projeto; esse comando também inicia a API.';
        el('notice').hidden = false;
      }
      el('updated').textContent = 'Consultado às ' + new Date(data.timestamp).toLocaleTimeString('pt-BR') + (data.deepseek.checkedAt ? ' · Sessão verificada às ' + new Date(data.deepseek.checkedAt).toLocaleTimeString('pt-BR') : '');
    } catch {
      value('server','Sem resposta','bad'); value('session','Não verificada','warn'); value('saved','Não verificada','warn');
      el('server-detail').textContent = 'Não foi possível consultar o proxy.';
      el('session-detail').textContent = 'Aguardando conexão com o servidor.';
      el('saved-detail').textContent = 'Aguardando conexão com o servidor.';
      el('notice').textContent = 'O servidor não respondeu. Confirme se o DeepsProxy está em execução e tente atualizar.';
      el('notice').hidden = false;
    } finally { pending = false; el('refresh').disabled = false; }
  }
  el('refresh').addEventListener('click',refresh);
  el('auth-form').addEventListener('submit',event => {event.preventDefault();key=el('api-key').value;el('api-key').value='';refresh();});
  el('copy').addEventListener('click',async () => {try {await navigator.clipboard.writeText(el('base').textContent);el('copy').textContent='Copiado';setTimeout(()=>el('copy').textContent='Copiar endereço',2000);} catch {el('copy').textContent='Selecione e copie o endereço';}});
  refresh(); setInterval(refresh,15000);
</script></body></html>`;
