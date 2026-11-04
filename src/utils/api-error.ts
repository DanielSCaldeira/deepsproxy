import { getGenerationGuard, UpstreamError } from '../services/generation-guard.ts';

const chatUrl = 'https://chat.deepseek.com/';

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
  const technical = error instanceof Error ? error.message : String(error);
  const guard = getGenerationGuard().status();
  const stored = ['deepseek_account_suspended', 'deepseek_login_required'].includes(code) ? guard.block?.originalMessage : null;
  const original = stored || (error instanceof UpstreamError ? error.originalMessage : technical);
  let action: string;
  let url: string | null = null;
  let until: string | null = null;
  if (code === 'deepseek_account_suspended') {
    until = guard.block?.suspendedUntil ?? null;
    action = `A conta DeepSeek está suspensa${until ? ` até ${until} (horário informado pelo DeepSeek)` : ''}. Interrompa as tentativas automáticas. Acesse ${chatUrl} para consultar o aviso e as opções de suporte. Após a liberação, execute make login e conclua o login na janela aberta pelo proxy.`;
    url = chatUrl;
  } else if (code === 'deepseek_login_required') {
    action = `Execute make login e conclua a autenticação na janela aberta pelo proxy, incluindo CAPTCHA se solicitado. Site: ${chatUrl}. Aguarde a confirmação de que a sessão foi salva antes de tentar novamente. Fazer login somente em outro navegador não autentica o perfil do proxy.`;
    url = chatUrl;
  } else if (code === 'deepseek_rate_limited') {
    action = `Aguarde${guard.nextAllowedAt ? ` até ${guard.nextAllowedAt}` : ' o prazo informado pelo serviço'} antes de tentar novamente. O proxy respeita o Retry-After; evite repetir pedidos durante a espera.`;
  } else if (code === 'deepseek_chat_unavailable' || /Timeout waiting for PoW|Failed to trigger PoW/i.test(technical)) {
    action = `Execute make login para verificar a sessão na janela do proxy. Acesse ${chatUrl} e confira se há aviso de suspensão, CAPTCHA ou indisponibilidade. Resolva o aviso e aguarde a confirmação do login antes de reenviar.`;
    url = chatUrl;
  } else if (code === 'invalid_tool_call') {
    action = 'O modelo retornou uma chamada de ferramenta inválida. Reenvie o pedido; se persistir, simplifique as instruções ou revise o esquema das ferramentas.';
  } else if (code === 'request_cancelled') {
    action = 'O pedido foi cancelado. Envie um novo pedido quando desejar continuar.';
  } else if (/Playwright not initialized/i.test(technical)) {
    action = `Aguarde a inicialização do navegador do proxy. Se a falha persistir, execute make login e conclua o acesso em ${chatUrl}.`;
    url = chatUrl;
  } else {
    action = 'Verifique a conexão e a disponibilidade do serviço DeepSeek. Aguarde antes de tentar novamente; se persistir, consulte os logs do proxy com a mensagem de erro abaixo.';
  }
  return { error: {
    // Many OpenAI-compatible clients display only message, so it must stand alone.
    message: `${original || technical}\n\nO que fazer: ${action}`,
    type: code === 'invalid_tool_call' ? 'upstream_error' : code,
    code, original_message: original, user_action: action, help_url: url,
    ...(until ? { suspended_until: until } : {}),
    ...(code === 'deepseek_rate_limited' ? { retry_at: guard.nextAllowedAt } : {}),
  } };
}
