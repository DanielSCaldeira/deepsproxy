import type { ProviderCredentials, ApiProvider } from '../production/provider-credentials.ts';
import { HttpError } from '../production/security.ts';
import { UserQueue } from '../production/queue.ts';

const bases = { openrouter: 'https://openrouter.ai/api/v1', nvidia: 'https://integrate.api.nvidia.com/v1' };
const TTL = 300_000;
// Explicitly reviewed hosted free endpoints, not downloadable NIM/partner deployments.
export const nvidiaFreeEndpoints = [
  { id: 'deepseek-ai/deepseek-v4.1-flash', source: 'https://build.nvidia.com/deepseek-ai/deepseek-v4.1-flash', checked: '2026-11-07', parameters: ['tools'] },
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', source: 'https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b', checked: '2026-11-07', parameters: ['tools','tool_choice'] },
];
export interface FreeModel { id: string; context_length: number; supported_parameters: string[]; source: string; checked_at: string }
export function freeOpenRouterModel(model: any): boolean {
  const p = model?.pricing;
  return typeof model?.id === 'string' && (model.id.endsWith(':free') || model.id === 'openrouter/free') &&
    p && typeof p === 'object' && p.prompt !== undefined && p.completion !== undefined &&
    Object.values(p).length > 0 && Object.values(p).every(v => (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '' && Number(v) === 0) &&
    model.architecture?.output_modalities?.includes('text');
}
const allowed = new Set(['model','messages','stream','stream_options','tools','tool_choice','parallel_tool_calls','temperature','top_p','max_tokens','max_completion_tokens','stop','frequency_penalty','presence_penalty','seed','response_format','reasoning_effort']);
export function safeRequest(body: any, model: FreeModel, provider: ApiProvider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Pedido inválido.', 'invalid_request_error');
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw new HttpError(400, `Parâmetro não permitido: ${key}.`, 'unsupported_parameter');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'Informe messages.', 'invalid_request_error');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream inválido.');
  const messages = body.messages.map((m: any) => {
    if (!m || !['system','developer','user','assistant','tool'].includes(m.role) || Object.keys(m).some(k => !['role','content','name','tool_calls','tool_call_id','reasoning_content','reasoning','reasoning_details','refusal'].includes(k))) throw new HttpError(400, 'Mensagem inválida.');
    for (const key of ['reasoning_content','reasoning','refusal']) if (m[key] !== undefined && m[key] !== null && (m.role !== 'assistant' || typeof m[key] !== 'string')) throw new HttpError(400, 'Metadados de mensagem inválidos.');
    if (m.reasoning_details !== undefined && (m.role !== 'assistant' || !Array.isArray(m.reasoning_details))) throw new HttpError(400, 'Metadados de raciocínio inválidos.');
    let content = m.content;
    if (content === undefined && m.role === 'assistant' && m.tool_calls) content = null;
    if (Array.isArray(content)) {
      if (!content.every((p: any) => p?.type === 'text' && typeof p.text === 'string' && Object.keys(p).every(k => ['type','text'].includes(k)))) throw new HttpError(400, 'Esta integração aceita somente texto.', 'unsupported_content');
      content = content.map((p: any) => p.text).join('\n');
    }
    if (content !== null && typeof content !== 'string') throw new HttpError(400, 'Conteúdo de mensagem inválido.');
    if (m.tool_calls && (!Array.isArray(m.tool_calls) || m.tool_calls.some((t: any) => t?.type !== 'function' || typeof t.id !== 'string' || typeof t.function?.name !== 'string' || typeof t.function?.arguments !== 'string'))) throw new HttpError(400, 'tool_calls inválido.');
    return { ...m, content };
  });
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => t?.type !== 'function' || typeof t.function?.name !== 'string' || Object.keys(t).some(k => !['type','function'].includes(k))))) throw new HttpError(400, 'Somente ferramentas function executadas pelo cliente são permitidas.');
  if (body.tool_choice !== undefined && !['auto','none','required'].includes(body.tool_choice) && !(body.tool_choice?.type === 'function' && typeof body.tool_choice.function?.name === 'string')) throw new HttpError(400, 'tool_choice inválido.');
  if (body.stream_options && (Object.keys(body.stream_options).some(k => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) throw new HttpError(400, 'stream_options inválido.');
  const output = body.max_completion_tokens ?? body.max_tokens ?? 1024;
  if (!Number.isInteger(output) || output < 1) throw new HttpError(400, 'Limite de saída inválido.');
  // Conservative byte upper bound; never truncate or trigger extra paid/quota-consuming summary calls.
  if (model.context_length && Buffer.byteLength(JSON.stringify(messages) + JSON.stringify(body.tools || []), 'utf8') + output > model.context_length) throw new HttpError(400, 'Contexto excedido; reduza o histórico.', 'context_length_exceeded');
  for (const param of ['tools','tool_choice','parallel_tool_calls','reasoning_effort','response_format']) {
    if (body[param] !== undefined && !model.supported_parameters.includes(param)) throw new HttpError(400, `Recurso indisponível neste modelo: ${param}.`, 'unsupported_parameter');
  }
  const result = { ...body, model: model.id.slice(provider.length + 1), messages };
  if (!body.max_tokens && !body.max_completion_tokens) result.max_tokens = output;
  if (provider === 'openrouter') result.provider = { allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0 } };
  return result;
}

/** HTTP-only service. Cache, queue and cooldown are isolated by user/provider. No automatic retries. */
export class FreeApis {
  private catalogs = new Map<string, { until: number; revision: string; models: FreeModel[] }>();
  private queues = new Map<string, UserQueue>();
  private cooldowns = new Map<string, number>();
  constructor(readonly credentials: ProviderCredentials, private fetcher: typeof fetch = fetch) {}
  private scope(user: string, provider: ApiProvider) { return `${user}/${provider}`; }
  invalidate(user: string, provider: ApiProvider) { const id = this.scope(user,provider); this.catalogs.delete(id); this.cooldowns.delete(id); }
  queue(user: string, provider: ApiProvider) {
    const id = this.scope(user,provider);
    let queue = this.queues.get(id);
    if (!queue) { queue = new UserQueue(); this.queues.set(id,queue); }
    return queue;
  }
  private async json(url: string, apiKey?: string) {
    try {
      const response = await this.fetcher(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new HttpError([401,403,429].includes(response.status) ? response.status : 503, 'Não foi possível consultar o provedor.', 'upstream_unavailable');
      return await response.json();
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(503, 'Catálogo indisponível; nenhum modelo pago será utilizado.', 'catalog_unavailable'); }
  }
  async models(user: string, provider: ApiProvider, force = false): Promise<FreeModel[]> {
    const credential = await this.credentials.load(user,provider), id = this.scope(user,provider);
    const cached = this.catalogs.get(id);
    if (!force && cached && cached.until > Date.now() && cached.revision === credential.revision) return cached.models;
    this.catalogs.delete(id);
    const data = await this.json(`${bases[provider]}/models`,credential.apiKey);
    if (!Array.isArray(data.data)) throw new HttpError(503, 'Catálogo inválido.', 'catalog_unavailable');
    const checked_at = new Date().toISOString();
    let models: FreeModel[];
    if (provider === 'openrouter') {
      models = data.data.filter(freeOpenRouterModel).map((m: any) => ({ id: `openrouter/${m.id}`, context_length: Number.isSafeInteger(m.context_length) && m.context_length > 0 ? m.context_length : 0, supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((x: unknown) => typeof x === 'string') : [], source: `${bases.openrouter}/models`, checked_at }));
    } else {
      const verified = await Promise.all(nvidiaFreeEndpoints.filter(e => data.data.some((m: any) => m.id === e.id)).map(async e => {
        try {
          const page = await this.fetcher(e.source, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
          const html = page.ok ? await page.text() : '';
          // Fail closed if the official prototype page changes or removes its free endpoint.
          if (!html.includes('Start building with a free API endpoint.') || !html.includes('https://integrate.api.nvidia.com/v1')) return null;
          return { id: `nvidia/${e.id}`, context_length: 0, supported_parameters: e.parameters, source: e.source, checked_at };
        } catch { return null; }
      }));
      models = verified.filter((m): m is FreeModel => m !== null);
    }
    // A concurrent key replacement must not repopulate the cache for the old credential.
    if ((await this.credentials.load(user,provider)).revision !== credential.revision) throw new HttpError(409, 'A chave foi alterada. Atualize os modelos.');
    this.catalogs.set(id, { until: Date.now() + TTL, revision: credential.revision, models });
    return models;
  }
  async catalog(user: string) {
    if (!this.credentials.enabled) return [];
    const rows = await this.credentials.list(user);
    const result = await Promise.all(rows.map(async row => {
      try { return await this.models(user,row.provider); } catch { return []; }
    }));
    return result.flat();
  }
  async limits(user: string) {
    const c = await this.credentials.load(user,'openrouter');
    const json = await this.json(`${bases.openrouter}/key`,c.apiKey);
    const daily = json.data?.free_model_daily_requests;
    return daily && ['used','limit','remaining'].every(k => typeof daily[k] === 'number') ? { used: daily.used, limit: daily.limit, remaining: daily.remaining } : null;
  }
  async generate(user: string, provider: ApiProvider, body: any, signal: AbortSignal) {
    const scope = this.scope(user,provider), until = this.cooldowns.get(scope) || 0;
    if (until > Date.now()) return Response.json({ error: { code: 'rate_limited', message: 'Cota ou limite temporário atingido. Aguarde para tentar novamente.' } }, { status: 429, headers: { 'Retry-After': String(Math.ceil((until-Date.now())/1000)) } });
    const model = (await this.models(user,provider)).find(m => m.id === body?.model);
    if (!model) throw new HttpError(400, 'Modelo não permitido: somente endpoints gratuitos ativos.', 'invalid_model');
    const request = safeRequest(body,model,provider), credential = await this.credentials.load(user,provider);
    let response: Response;
    try {
      response = await this.fetcher(`${bases[provider]}/chat/completions`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.any([signal,AbortSignal.timeout(120_000)]) });
    } catch { if (signal.aborted) throw new HttpError(499, 'Chamada cancelada.'); throw new HttpError(502, 'Falha de transporte do provedor.', 'upstream_unavailable'); }
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      const seconds = retry ? (/^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry)-Date.now())/1000)) : 60;
      if (response.status === 429) this.cooldowns.set(scope, Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 60) * 1000);
      await response.body?.cancel();
      const status = [400,401,402,403,404,429].includes(response.status) ? response.status : 502;
      return Response.json({ error: { code: status === 429 ? 'rate_limited' : 'upstream_error', message: status === 402 ? 'O provedor recusou o uso gratuito. Nenhuma alternativa paga será utilizada.' : status === 401 || status === 403 ? 'Verifique a chave e as permissões no provedor.' : status === 429 ? 'Limite gratuito atingido. Aguarde a liberação pelo provedor.' : 'O provedor não conseguiu concluir o pedido.' } }, { status, headers: retry ? { 'Retry-After': retry } : {} });
    }
    const contentType = response.headers.get('Content-Type') || '';
    if (!(body.stream ? contentType.includes('text/event-stream') : contentType.includes('application/json'))) { await response.body?.cancel(); throw new HttpError(502, 'Resposta inesperada do provedor.'); }
    // Preserve JSON/SSE bytes, native tool deltas, usage and error events, without retries.
    return response;
  }
}
