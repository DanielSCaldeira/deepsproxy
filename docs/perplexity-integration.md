# Integração Perplexity web — 2026-11-06

Provedor `perplexity`, site `https://www.perplexity.ai/`, modelos expostos como
`perplexity/<id-original>`. A integração segue o padrão do ChatGPT: o worker
opera o compositor do próprio site e captura a resposta da requisição que o
frontend envia; tokens e cookies permanecem no Chromium.

**Estado:** implementado e coberto por testes com HTML/eventos simulados a partir
das capturas públicas. **Nenhum envio real autenticado foi feito**: login, envio,
streaming real e ciclo de ferramenta continuam pendentes de validação com conta.

## O que foi verificado de fato (sem conta)

Inspeção em 2026-11-06 com Playwright + `playwright-extra`/stealth, headless,
contexto `pt-BR`, sem credenciais, sem tentar login e sem enviar perguntas.
Evidências locais (fora do Git) em `.cache/perplexity/`: HTML sanitizado,
capturas de tela, lista de requisições, menu de modelos e respostas JSON
públicas com identificadores removidos. Bundles públicos copiados para
`.cache/perplexity-src/` para leitura estática.

- **Cloudflare:** a página carregou sem interstício. Houve apenas a detecção
  JavaScript `/cdn-cgi/challenge-platform/.../jsd/oneshot` (HTTP 200) e
  `/api/bot-assessment`. Isso não garante o mesmo resultado no worker com egress
  nem em navegador autenticado. Nenhum desafio foi resolvido automaticamente.
- **Interface para visitantes:** em inglês mesmo com `pt-BR` (os textos vindos
  da API, como “Novo” e “Rápido”, estavam em português). O compositor aparece
  para visitantes, portanto o editor visível **não** prova login.

### Elementos do compositor (HTML público hidratado)

| Elemento | Observado | Seletor usado |
| --- | --- | --- |
| Campo | `div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]`, sem ID; `aria-label` muda de “Ask anything…” para “Type @ for connectors”/“Type / for search modes” após foco | `#ask-input:visible, div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]:visible` |
| Enviar | `button[type=button][aria-label="Submit"]`, só existe após digitar (no lugar de “Use voice mode”) | `button[aria-label="Submit"]:visible` (+ `Enviar`, não observado) |
| Parar | não visível sem geração; bundle `ask-input`: rótulo `Stop response (Esc)`, atalho Esc | `button[aria-label^="Stop response"]` (+ `Parar resposta`, não observado) |
| Modelo | `button[aria-haspopup="menu"][aria-label="Model"]`; menu `[role=menu]` com `[role=menuitem]` cujo texto é rótulo + selo (“Max”, “Novo”) em outra linha | `MODEL_BUTTON`/`MENU_ITEMS` em `src/providers/perplexity.ts` |
| Modo | botões `Search` e `Computer` no compositor; o padrão observado é Search | não alterado pelo adaptador |
| Login | botão “Sign In” na barra lateral; modal `data-testid="login-modal"` com “Continue with Google”, “Continue with Apple”, campo `input[type=email]` + “Continue with email” e “Single sign-on (SSO)” | usado só por humano na tela remota |
| Cookies | `data-testid="consent-dialog"` (“Decline optional”/“Got it”) | não é clicado pela automação |

### Endpoints e transporte (bundles `pplx-stream`, `platform-core`, `spa-shell`)

- `GET /api/auth/session` (NextAuth): visitante recebeu `{}` (verificado).
  `GET /api/auth/providers` lista `email`, `google`, `apple`, `googleonetap`,
  `workos` (SSO) e `pplx-jwt-to-cookie`.
- `GET /rest/models/config/v2`: `models` (id → rótulo, modo, fornecedor),
  `search_config` (rótulo, `non_reasoning_model`, `reasoning_model`, selo),
  `default_models.search = "turbo"`. Verificado como visitante.
- Geração: `POST /rest/sse/perplexity_ask` (query `version=2.18&source=default`),
  corpo `{ params: { model_preference, mode, sources, search_focus,
  use_schematized_api: true, send_back_text_in_streaming_api: false, ... }, query_str }`.
  O cliente SSE do site usa a função global `fetch` (POST JSON, `credentials: include`).
- Eventos SSE: `message` (JSON da entrada), `end_of_stream`, `info`, `ping`.
  A mensagem tem `status` (`PENDING`, `COMPLETED`, `FAILED`, `RESUMING`),
  `final`, `backend_uuid`, `context_uuid`, `thread_url_slug` e `blocks`.
- Blocos por `intended_usage`. Um `diff_block {field, patches}` aplica JSON
  Patch (RFC 6902) ao campo do bloco anterior; outros blocos substituem o
  anterior de mesmo uso. Resposta: `markdown_block` (`chunks`, `answer`,
  `chunk_starting_offset`, `progress`) dos usos `ask_text`/`ask_text_*`, ou dos
  usos em `structured_answer_block_usages`. Fontes: `web_result_block.web_results`
  (`name`, `url`, `snippet`). Passos internos: `plan_block`/`pro_search_steps`.
- Erros: HTTP 403 com `cf-mitigated: challenge` = desafio Cloudflare; 403 JSON
  `detail.error_code` (ex.: `VIEWER_TIER_RESTRICTED`); 429 com `Retry-After`.
  Outros: `/rest/sse/perplexity_ask/reconnect/{entry}`, `/rest/sse/perplexity_terminate`.
- Após o envio, o site navega para `/search/<slug>`.

Esses formatos vêm da leitura estática do JavaScript, **não de uma resposta
real**; o decodificador foi testado só com eventos simulados nesse formato.

## Decisões

- **Envio por interação + captura:** foca o editor, preenche (`fill`), clica em
  Submit com `noWaitAfter`; um `fetch` instalado antes dos scripts clona apenas a
  resposta de `/rest/sse/perplexity_ask` cujo `query_str` corresponde ao prompt
  (comparação ignorando espaços em branco, pois o Lexical pode normalizar quebras de linha). Sem reenvio automático.
- **Modelos:** `perplexity/auto` (padrão do site) e `perplexity/<non_reasoning_model>`
  de `search_config` cujo rótulo aparece habilitado no menu da conta. Variantes
  “thinking” e o modo Computer/agentes de navegador não são anunciados.
  `contextLength: 0` (origem `unknown`). O site memoriza a última escolha; em
  `auto` o adaptador clica em “Best/Melhor” quando o item existe. Para modelo
  específico, a captura exige `params.model_preference` igual ao pedido; caso
  contrário falha com 400 (sem trocar de modelo silenciosamente).
- **Citações:** marcadores inline (`[1]`) ficam como o site escreveu; quando presentes, ao final é
  acrescentada uma lista `Fontes:` numerada (`[n] título - URL`, só http/https,
  sem duplicatas, até 20). A lista é omitida quando a resposta contém
  `<tool_call>` (protocolo de IDE) ou com `PERPLEXITY_SOURCES=none`.
  A correspondência entre a numeração inline e a ordem de `web_results` não foi
  confirmada em resposta real.
- **Revisões de texto:** deltas só são emitidos enquanto o texto acumulado
  estende o já enviado; uma revisão transitória é aguardada, mas se a versão
  final divergir a resposta falha (não é possível retratar deltas OpenAI).
- **Login:** confirmação manual (`manualLoginConfirmation`), como no ChatGPT:
  o humano entra pela tela remota (e-mail com código, Google ou Apple) e clica em
  **Concluir login**. A validação consulta `/api/auth/session` no navegador e
  devolve só um booleano (usuário com `id`/`email`/`username` e `expires`
  futuro). `{}`/401 = login necessário; HTML ou 403 de desafio = indisponível
  (não apaga o login). 429 vira limite de uso sem invalidar a autenticação.
  O status é reavaliado a cada 15 s, detectando sessão expirada.
- Apenas texto; `reasoning_effort` diferente de `none` é rejeitado, como no ChatGPT.

## Componentes alterados

- Novos: `src/providers/perplexity.ts`, `perplexity-browser.ts`,
  `perplexity-protocol.ts`, `src/perplexity.test.ts`, `scripts/smoke-perplexity.ts`.
- Registro: `types.ts`, `catalog.ts`, `registry.ts`, `session-store.ts`
  (`PERPLEXITY_PROFILE_DIR`, padrão `perplexity_profile`), `browser-logging.ts`,
  `generation-guard.ts`, `api-error.ts`, `routes/chat.ts`, `index.ts`, `openapi.ts`.
- Produção: migração versão 6 (restrição de provedor + conta `perplexity` para
  usuários existentes), `ensureAccounts`, `providers`, gateway (nome e
  confirmação manual), provisioner, `panel.ts`, `public/panel.js`.
- Backup/restauração: `deploy/restore-profile.sh` aceita `perplexity`.
- Egress: `deploy/squid.conf` libera `.perplexity.ai` (site, `pplx-next-static-public`,
  `count`, `experimentation-cdn`), `fscdn.eppo.cloud` (feature flags) e
  `appleid.apple.com`/`appleid.cdn-apple.com` (login Apple). Google e
  `challenges.cloudflare.com` já estavam liberados. `squid -k parse` **não** foi
  executado (o ambiente de containers não foi usado).
- `scripts/test.js`, `.env.example`, `.gitignore`, `.dockerignore`.
- Testes compartilhados: `production.test.ts` (quatro provedores, roteamento
  `perplexity/auto` e confirmação manual) e `provider-migration.test.ts`.

## Testes

`src/perplexity.test.ts` (8 testes): catálogo/roteamento/erros e mensagem de
ajuda; JSON Patch com CRLF e Unicode fragmentado e lista de fontes; snapshots,
usos estruturados, janelas de chunks e `end_of_stream`; falhas explícitas
(revisão final, patch inseguro, `FAILED`, truncamento, dados inválidos);
ferramentas pelo parser compartilhado; captura no navegador (ignora outros
endpoints/prompts, exige modelo, cancela a requisição real); fixture do
compositor (login, modelos do menu, item desabilitado, `/v1` normal e SSE com
histórico de ferramenta, cancelamento sem consumir, 429, desafio Cloudflare,
expiração); confirmação manual antecipada e bem-sucedida.

Resultado em 2026-11-06: `npm run build` passou; `src/perplexity.test.ts` 8/8;
`npm test` com 129 testes: 126 aprovados, 0 falhas, 2 ignorados e 1 cancelado
por tempo (`diagnostic-flow.test.ts`, DeepSeek). Esse teste também expira no
commit base `bb3ecff` sem as alterações desta integração, nesta máquina.

## Pendente de validação com conta real

1. Login pela tela remota do painel (e-mail com código, Google e Apple) dentro
   do worker com egress; formato real de `/api/auth/session` autenticado.
2. Envio real normal e SSE para `perplexity/auto`: correlação do `query_str`
   (Lexical pode normalizar quebras de linha; prompts longos podem virar anexo
   ou exceder o limite do site), formato real dos eventos, sinal de conclusão e
   numeração das citações. Executar `npx tsx scripts/smoke-perplexity.ts`.
3. Seleção de modelos na conta Free/Pro: itens com selo “Max”/“Pro”, paywall,
   item “Best” e efeito da escolha memorizada pelo site.
4. Ciclo real de ferramenta (chamada → resultado → continuação) conforme o guia;
   o Perplexity pode responder com busca na web em vez de seguir o protocolo.
5. Botão Parar com geração ativa, avisos de limite da conta gratuita e rótulos
   em português.
6. Desafio Cloudflare no worker (o humano resolve na tela remota) e
   `squid -k parse` com a nova ACL.
# Atualização dos testes autenticados — 2026-11-06

O envio real continua em `/rest/sse/perplexity_ask`, mas a resposta também pode
vir em `workflow_root.workflow_block.steps[].items[]`, com patches incrementais.
O decodificador lê apenas `WORKFLOW_ITEM_TEXT` marcado como `answer`; consultas
de busca, raciocínio e resultados de ferramentas não entram no texto final.
Foram observados texto final e fontes em chamada real após a correção.

O rodapé de fontes só é acrescentado quando a resposta contém citações inline.
Isso preserva respostas com formato exato. O tratamento de cookies usa a opção
visível de recusar cookies opcionais. Há regressões para esses comportamentos e
para o cancelamento do leitor depois de um frame final válido.
