import { getGenerationGuard, UpstreamError } from '../services/generation-guard.ts';


/** Extract the reported error, without forwarding arbitrary response metadata. */
export function upstreamMessage(body: string): string | null {
  try {
    const data = JSON.parse(body);
    const message = [data?.error?.message, data?.data?.biz_msg, data?.biz_msg, data?.message, data?.msg, data?.error]
      .find(value => typeof value === 'string' && value.trim());
    return typeof message === 'string' ? message.trim().slice(0, 4096) || null : null;
  } catch {
    return /^\s*</.test(body) ? null : body.trim().slice(0, 4096) || null;
  }
}

export function apiError(error: unknown, code: string) {
  const qwen = process.env.PROVIDER === 'qwen';
  const chatgpt = process.env.PROVIDER === 'chatgpt';
  const claude = process.env.PROVIDER === 'claude';
  const perplexity = process.env.PROVIDER === 'perplexity';
  const cohere = process.env.PROVIDER === 'cohere';
  const ernie = process.env.PROVIDER === 'ernie';
  const gemini = process.env.PROVIDER === 'gemini';
  const copilot = process.env.PROVIDER === 'copilot';
  const kimi = process.env.PROVIDER === 'kimi';
  const mistral = process.env.PROVIDER === 'mistral';
  const quillbot = process.env.PROVIDER === 'quillbot';
  const meta = process.env.PROVIDER === 'meta';
  const service = claude ? 'Claude' : perplexity ? 'Perplexity' : cohere ? 'Cohere' : ernie ? 'Ernie' : gemini ? 'Gemini' : copilot ? 'Copilot' : kimi ? 'Kimi' : mistral ? 'Mistral' : quillbot ? 'QuillBot' : meta ? 'Meta AI' : chatgpt ? 'ChatGPT' : qwen ? 'Qwen' : 'DeepSeek';
  const chatUrl = claude ? 'https://claude.ai/' : perplexity ? 'https://www.perplexity.ai/' : cohere ? 'https://dashboard.cohere.com/playground/chat' : ernie ? 'https://wenxin.baidu.com/' : gemini ? 'https://gemini.google.com/app' : copilot ? 'https://copilot.microsoft.com/chats/new' : kimi ? 'https://www.kimi.ai/' : mistral ? 'https://chat.mistral.ai/chat' : quillbot ? 'https://quillbot.com/ai-chat' : meta ? 'https://www.meta.ai/' : chatgpt ? 'https://chatgpt.com/' : qwen ? 'https://chat.qwen.ai/' : 'https://chat.deepseek.com/';
  const originalCode = code;
  const kind = code.replace(/^(deepseek|qwen|chatgpt|claude|perplexity|cohere|ernie|gemini|copilot|kimi|mistral|quillbot|meta)_/, '');
  const technical = error instanceof Error ? error.message : String(error);
  const guard = getGenerationGuard().status();
  const stored = ['account_suspended', 'login_required'].includes(kind) ? guard.block?.originalMessage : null;
  const original = stored || (error instanceof UpstreamError ? error.originalMessage : technical);
  let action: string;
  let url: string | null = null;
  let until: string | null = null;
  if (kind === 'account_suspended') {
    until = guard.block?.suspendedUntil ?? null;
    action = `A conta ${service} está suspensa${until ? ` até ${until} (horário informado pelo ${service})` : ''}. Interrompa as tentativas automáticas. Acesse ${chatUrl} para consultar o aviso e as opções de suporte. Após a liberação, abra o painel do Proxy IA (ambiente de teste: http://localhost:3440), clique em Conectar no card do ${service} e conclua o login na tela remota que abre dentro do site, com e-mail e senha (o login pelo Google é bloqueado em navegadores automatizados).`;
    url = chatUrl;
  } else if (kind === 'login_required') {
    action = `Abra o painel do Proxy IA (ambiente de teste: http://localhost:3440), clique em Conectar no card do ${service} e conclua o login na tela remota que abre dentro do site, com e-mail e senha (o login pelo Google é bloqueado em navegadores automatizados), incluindo CAPTCHA se solicitado. Site: ${chatUrl}. Aguarde o status Conectada antes de tentar novamente. Fazer login em outro navegador não autentica o proxy.`;
    url = chatUrl;
  } else if (kind === 'rate_limited') {
    action = `Aguarde${guard.nextAllowedAt ? ` até ${guard.nextAllowedAt}` : ' o prazo informado pelo serviço'} antes de tentar novamente. O proxy respeita o Retry-After; evite repetir pedidos durante a espera.`;
  } else if (kind === 'chat_unavailable' || /Timeout waiting for PoW|Failed to trigger PoW/i.test(technical)) {
    action = `No painel do Proxy IA, use Entrar novamente no card do ${service} para verificar a sessão na tela remota. Acesse ${chatUrl} e confira se há aviso de suspensão, CAPTCHA ou indisponibilidade. Resolva o aviso e aguarde a confirmação do login antes de reenviar.`;
    url = chatUrl;
  } else if (code === 'invalid_tool_call') {
    action = 'O modelo retornou uma chamada de ferramenta inválida. Reenvie o pedido; se persistir, simplifique as instruções ou revise o esquema das ferramentas.';
  } else if (code === 'request_cancelled') {
    action = 'O pedido foi cancelado. Envie um novo pedido quando desejar continuar.';
  } else if (/Playwright not initialized/i.test(technical)) {
    action = `Aguarde a inicialização do navegador do proxy. Se a falha persistir, use Recuperar navegador no card do ${service} no painel do Proxy IA e conecte novamente (${chatUrl}).`;
    url = chatUrl;
  } else {
    action = `Verifique a conexão e a disponibilidade do serviço ${service}. Aguarde antes de tentar novamente; se persistir, consulte os logs do proxy com a mensagem de erro abaixo.`;
  }
  if (perplexity) action = action.replace(/com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, 'com código por e-mail, Google ou Apple').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  if (ernie) action = action.replace(/com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, 'com a conta Baidu (SMS, QR code ou senha)').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  // Gemini uses Google sign-in itself; it is completed manually in the remote browser.
  if (gemini) action = action.replace(/com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, 'com a conta Google (senha, verificação em duas etapas e confirmação de dispositivo, quando solicitadas)').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  if (copilot) action = action.replace(/com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, 'com a conta Microsoft (inclusive a verificação em duas etapas)');
  if (chatgpt || claude || cohere || copilot || kimi || quillbot) action = action.replace(/, com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, '').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  if (mistral) action = action.replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  if (meta) action = action.replace(/com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, 'com Facebook, Instagram ou conta Meta').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  return { error: {
    // Many OpenAI-compatible clients display only message, so it must stand alone.
    message: `${original || technical}\n\nO que fazer: ${action}`,
    type: code === 'invalid_tool_call' ? 'upstream_error' : originalCode,
    code: originalCode, original_message: original, user_action: action, help_url: url,
    ...(until ? { suspended_until: until } : {}),
    ...(kind === 'rate_limited' ? { retry_at: guard.nextAllowedAt } : {}),
  } };
}
