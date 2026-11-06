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
  const grok = process.env.PROVIDER === 'grok';
  const service = chatgpt ? 'ChatGPT' : grok ? 'Grok' : qwen ? 'Qwen' : 'DeepSeek';
  const chatUrl = chatgpt ? 'https://chatgpt.com/' : grok ? 'https://grok.com/' : qwen ? 'https://chat.qwen.ai/' : 'https://chat.deepseek.com/';
  const originalCode = code;
  const kind = code.replace(/^(deepseek|qwen|chatgpt|grok)_/, '');
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
  if (chatgpt || grok) action = action.replace(/, com e-mail e senha \(o login pelo Google é bloqueado em navegadores automatizados\)/g, '').replace('Aguarde o status Conectada', 'Clique em Concluir login e aguarde o status Conectada');
  return { error: {
    // Many OpenAI-compatible clients display only message, so it must stand alone.
    message: `${original || technical}\n\nO que fazer: ${action}`,
    type: code === 'invalid_tool_call' ? 'upstream_error' : originalCode,
    code: originalCode, original_message: original, user_action: action, help_url: url,
    ...(until ? { suspended_until: until } : {}),
    ...(kind === 'rate_limited' ? { retry_at: guard.nextAllowedAt } : {}),
  } };
}
