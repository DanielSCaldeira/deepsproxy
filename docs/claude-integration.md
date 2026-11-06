# Integração Claude web (claude.ai) — 2026-11-06

O provedor `claude` foi acrescentado ao adaptador, catálogo, registro, painel,
provisionamento, migração, gateway, backup/restauração, ACL do egress e testes.
**Nenhum envio real com conta foi feito.** A inspeção usou apenas páginas e
bundles públicos, sem credenciais, sem login e sem resolver desafios.
Tudo o que depende de uma conta autenticada está marcado como "não verificado".

Arquivos do provedor:

- `src/providers/claude.ts`: adaptador (navegador, login, status, modelos, envio).
- `src/providers/claude-browser.ts`: captura da requisição de completion no navegador.
- `src/providers/claude-protocol.ts`: decodificação do SSE, erros, sonda de login e catálogo.
- `src/claude.test.ts`, `scripts/smoke-claude.ts`.

## Como a inspeção foi feita

Playwright com `playwright-extra` + stealth (`src/services/browser.ts`), headless,
idioma pt-BR, contexto novo sem perfil. Evidências locais (fora do Git) em
`.cache/claude/`: HTML sem corpo de scripts (`root.html`, `login.html`, `new.html`),
capturas de tela, inventário semântico (`*.semantics.json`), lista de requisições
(`network.json`), respostas das sondas (`probes.json`) e os bundles públicos em
`.cache/claude/js/` (195 arquivos, ~21 MB).

| URL | Resultado observado |
| --- | --- |
| `https://claude.ai/` | Primeira resposta HTTP 403 com título "Um momento…" (desafio Cloudflare gerenciado/Turnstile). O desafio foi concluído pelo próprio navegador, sem interação, e redirecionou para `/login`. |
| `https://claude.ai/login` | HTTP 200, "Sign in - Claude". |
| `https://claude.ai/new` | Sem sessão, redireciona para `/login?from=logout&reauth=1&returnTo=%2Fnew%3F` e chama `POST /api/auth/logout`. |

O fato de o desafio passar headless nesta máquina não garante o mesmo resultado
no worker (IP, egress e perfil diferentes).

## Elementos identificados

### Login (verificado no HTML público)

| Elemento | Seletor |
| --- | --- |
| Google | `[data-testid="login-with-google"]` ("Continue with Google") |
| Apple | `[data-testid="login-with-apple"]` |
| E-mail | `input[data-testid="email"][type="email"][aria-label="Email"]` |
| Continuar com e-mail | `button[data-testid="continue"][type="submit"]` |
| SSO | botão "Continue with SSO" |
| Código por e-mail | `data-testid` `code` e `enter-code` (lista de testids do bundle; tela não aberta) |
| Cookies | `[data-testid="consent-accept"]`, `consent-reject`, `consent-customize` |

A página carrega hCaptcha (`newassets.hcaptcha.com`, `api.hcaptcha.com`,
`api2.hcaptcha.com`), Turnstile (`challenges.cloudflare.com`) e Google Identity
(`accounts.google.com/gsi/*`). O login é sempre humano, na tela remota.

### Sonda de autenticação (verificada sem sessão)

| Endpoint | Sem sessão |
| --- | --- |
| `GET /api/organizations` | 403 JSON `{"type":"error","error":{"type":"permission_error","details":{"error_code":"account_session_invalid"}}}` |
| `GET /api/account` | 403 JSON, mesmo `error_code` |
| `GET /api/bootstrap` | 200 JSON `{"account":null, "statsig":…, "growthbook":…}` |
| `GET /api/auth/session` | 404 (não existe neste site) |

Decisão: `validate()` executa `fetch('/api/organizations')` dentro do Chromium e
devolve ao Node apenas status, se é JSON, a quantidade de organizações com `uuid`
e o `error_code`/`type`. Regras (`claudeAuthState`):

- 200 JSON com ao menos uma organização → autenticado (**forma da resposta
  autenticada não verificada**; documentada como lista de organizações com `uuid`).
- 401/403 JSON com `account_session_invalid` ou `authentication_error` → login necessário.
- Qualquer outra coisa (inclusive 403 HTML do Cloudflare) → indisponível, nunca
  "deslogado". Se o título for "Um momento…/Just a moment…", a mensagem pede para
  concluir a verificação na tela de login.

Um `permission_error` sem `account_session_invalid` (por exemplo, restrição de
plano) não é tratado como login expirado.

### Compositor e controles (bundles; não observados autenticado)

Lidos no código compilado (`shared-8-*.js`, `shared-9-*.js`, `shared-l-p-m-w-4-*.js`):

| Elemento | Seletor usado | Evidência |
| --- | --- | --- |
| Editor | `[data-testid="chat-input"]` (role `textbox`, `contenteditable`, `aria-label` "Write your prompt to Claude", atributo `data-composer-editor`) | constante `FI="chat-input"` aplicada ao editor |
| Enviar | `[data-testid="chat-input-send"]`, `aria-label` "Send message" | constante `Xh="chat-input-send"` |
| Parar | `[data-testid="chat-input-stop"]`, `aria-label` "Stop response" | constante `Iz="chat-input-stop"` |
| Modelo | `[data-testid="model-selector-dropdown"]`; opções `[data-testid="model-selector-option"]` (`menuitemradio`); submenu `model-selector-more-models` | |
| Usuário logado | `[data-testid="user-menu-button"]` | não usado na validação |

Os rótulos em português ("Enviar mensagem", "Interromper resposta") são
suposições e ficam apenas como alternativa aos `data-testid`.
Fallback do editor: `fieldset [contenteditable="true"][role="textbox"]`.

### Geração e streaming (bundles; não observados com conta)

- Endpoint: `POST /api/organizations/{org}/chat_conversations/{conversa}/completion`
  (ou `completion2` no backend alternativo "c2"; `retry_completion` para repetir).
  `GET …/completion_status?poll=…` acompanha retomadas.
- Corpo: JSON com `prompt`, `model`, `timezone`, anexos e
  `rendering_mode: "messages"`; numa conversa nova inclui `create_conversation_params`.
  Corpos grandes podem ir **comprimidos com gzip** (`Content-Encoding: gzip`,
  worker `completionGzipWorker`).
- Envio via `fetch` com leitura incremental de SSE.
- Eventos (`pD` no bundle): `message_start`, `content_block_start`,
  `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta`,
  `citation_*`, …), `content_block_stop`, `message_delta`, `message_stop`, `ping`,
  `error`, `message_limit`, `completion` (legado), `content_block_retract`,
  `model_fallback`, `compaction_status`, `conversation_ready` e outros.
- Limite de uso: `message_limit.type` em `within_limit`/`approaching_limit`/`exceeded_limit`
  com `resetsAt`; e `stop_reason: "stop_sequence"` + `stop_sequence: "usage_limit"`.

### Catálogo de modelos

O frontend obtém a lista de uma configuração dinâmica (`claude_ai_available_models`,
itens `{model_id, minimum_tier: free|pro|max}`) e do estado `model_selector_state`.
Sem sessão, o `bootstrap` não traz conta nem modelos, e as chaves do GrowthBook
são hashes. Nomes padrão vistos no bundle: `claude-sonnet-4-6` ("Sonnet 4.6") e
`claude-haiku-4-5-20251001` ("Haiku 4.5"). Eles **não** são anunciados de forma fixa.

## Decisões do adaptador

- **Navegador:** `chromium` do `playwright-extra` com stealth (como Qwen/DeepSeek),
  perfil persistente, proxy do egress no worker. Perfil local padrão `claude_profile/`
  (`CLAUDE_PROFILE_DIR`; `PROVIDER_PROFILE_DIR` tem precedência).
- **Login pelo painel:** `connect()` fecha a automação e abre o navegador humano
  (`InteractiveBrowser`) em `https://claude.ai/login`; a pessoa escolhe código por
  e-mail, Google ou SSO e resolve eventuais desafios. `manualLoginConfirmation`
  está ativo: o painel mostra **Concluir login**. `finishLogin()` fecha o
  navegador humano, reabre a automação, valida pela sonda e salva a sessão;
  se falhar, reabre a tela de login e devolve erro 401 sem perder o perfil.
- **Sessão expirada:** `status()` revalida a cada 15 s quando ocioso; 403
  `account_session_invalid` vira `login_required`. Erro 401/`account_session_invalid`
  durante o envio bloqueia o guard em `login_required`.
- **Envio:** abre `/new`, espera o editor, seleciona o modelo (se explícito),
  arma a captura, clica no editor, preenche e clica em enviar com `noWaitAfter`
  (o site navega para `/chat/<uuid>`). A captura determina o fim.
- **Captura (`installClaudeCapture`):** intercepta somente `POST` same-origin em
  `…/chat_conversations/*/completion` ou `completion2`; lê o corpo (texto,
  bytes, Blob ou `Request`), descomprime gzip com `DecompressionStream` e compara
  `prompt` com normalização de espaços. Requisições não correspondentes passam
  intactas. Erros HTTP só repassam `error_code`/`type` validados e `resetsAt`.
- **Decodificação:** apenas blocos `text`; raciocínio (`thinking`), `tool_use`
  de ferramentas do próprio site e citações são descartados. `content_block_retract`
  após texto enviado falha explicitamente. Sem `message_stop` → erro 502.
  Uso (`usage.output_tokens`) é repassado se existir.
- **Modelos:** `claude/auto` = seleção atual/padrão do site (não promete um
  modelo específico; o site lembra a última escolha da conta). Modelos explícitos
  `claude/<id-original>` só são anunciados quando o JSON de `/api/bootstrap`
  autenticado trouxer pares `{model|model_id, name}` **e** o menu mostrar uma
  opção cujo texto comece com esse nome. A captura recusa o envio se o `model`
  do corpo não for o pedido (400, sem troca silenciosa).
- **Limites:** HTTP 429, `rate_limit_error`, `exceeded_limit` ou `usage_limit`
  → 429 com `defer` pelo `Retry-After` ou `resetsAt` (mínimo 60 s), sem apagar o login.
  `overloaded_error`/529 → 503. Suspensão só por código explícito
  (`account_banned|suspended|disabled`), **não verificado**.
- **API:** somente texto; `reasoning_effort` diferente de `none` é rejeitado;
  sem `max_output_tokens` inventado; `contextLength: 0` (origem `unknown`).

## Camadas alteradas

`types.ts`, `catalog.ts`, `registry.ts`, `session-store.ts` (perfil),
`api-error.ts` (nome, URL, ação "Concluir login"), `generation-guard.ts` e
`browser-logging.ts` (nome do provedor), `routes/chat.ts` (validações de texto e
raciocínio), `index.ts` (`max_output_tokens`), `openapi.ts`,
`production/database.ts` (migração 6, `providers`, `ensureAccounts`),
`production/gateway.ts` (nome e confirmação manual), `production/provisioner.ts`,
`public/panel.js` (Concluir login), `deploy/restore-profile.sh`, `deploy/squid.conf`,
`deploy/README.md`, `.env.example`, `.gitignore`, `.dockerignore`, `scripts/test.js`.

A migração 6 recria a restrição `provider_accounts_provider_check` a partir da
lista `providers` do próprio build e cria uma conta `claude` por usuário; é
reaplicável e preserva as contas anteriores. Ao mesclar com outros provedores
que também usem a versão 6, basta manter um bloco por provedor (a restrição usa a
lista completa).

ACL do egress: `.claude.ai`, `s-cdn.anthropic.com`, `assets-proxy.anthropic.com`
(observados no carregamento público). `.challenges.cloudflare.com`, `.hcaptcha.com`
e `.google.com` já existiam. `squid -k parse` não foi executado (sem subir containers).

## Testes

`src/claude.test.ts` (7 testes) cobre: roteamento e catálogo; sonda com a
resposta real sem sessão; HTML de desafio como indisponível; classificação de erros;
SSE com CRLF, Unicode, blocos de raciocínio/ferramenta ignorados, uso e fim único;
formato legado `completion`; limites (`usage_limit`, `exceeded_limit`,
`rate_limit_error`), sessão inválida, sobrecarga, retração, truncamento e JSON
inválido; ferramentas pelo parser compartilhado; captura com corpo simples e gzip,
`completion2`, requisições e prompts alheios ignorados, cancelamento e modelo
recusado; frontend simulado com editor `chat-input`, envio desabilitado até
digitar, seleção de modelo honrada/ignorada/inexistente, `/v1/models`, `/v1` com
histórico de ferramenta normal e SSE, cancelamento sem consumir, 429 com `resetsAt`,
expiração; confirmação antecipada recusada e confirmação bem-sucedida.

Testes compartilhados ajustados: `provider-migration.test.ts` (4 contas) e
`production.test.ts` (4 provedores, nome/confirmação e roteamento de `claude/auto`).

A migração 5 é reexecutada a cada início; sua restrição passou a ser gerada a
partir de `providers`, pois a lista fixa anterior rejeitava as linhas `claude`
na segunda execução (falha reproduzida em `provider-migration.test.ts`).

Resultados em 2026-11-06 no worktree: `npm run build` passou. `npm test`:
129 testes, 125 aprovados, 2 ignorados, 1 falha e 1 cancelado. A falha (e o
cancelamento do mesmo arquivo) é `diagnostic-flow.test.ts` ("browser diagnostics
distinguish login…"), do DeepSeek, por tempo limite de 30 s; ela também falha no
código base `bb3ecff` sem as alterações do Claude, com a máquina carregada por
outros navegadores. Os 7 testes do Claude, produção, painel e migração passaram.

## Pendente de validação com conta real

1. Abrir o card Claude no painel, entrar por código de e-mail e por Google na tela
   remota; confirmar se Cloudflare/hCaptcha aparecem pelo egress do worker.
2. Confirmar a forma de `GET /api/organizations` autenticado e a transição
   para `authenticated`; testar **Concluir login** antes e depois do login.
3. Confirmar no HTML autenticado os `data-testid` do editor, enviar, parar e menu
   de modelos, inclusive em pt-BR.
4. Confirmar que a requisição de envio é `…/completion` (ou `completion2`), via
   `fetch` na página (não em Worker), com `prompt` e `model` no corpo, e o formato
   real dos eventos SSE.
5. Confirmar se `/api/bootstrap` autenticado traz os modelos com `model` e `name`;
   caso contrário só `claude/auto` será anunciado.
6. Enviar texto normal e SSE (`npx tsx scripts/smoke-claude.ts` com `DSP_API_KEY`),
   fazer o ciclo completo de ferramenta descrito no guia, cancelar uma geração e
   reiniciar o worker para verificar a sessão salva.
7. Observar a resposta real de limite de uso (HTTP 429 vs. evento `message_limit`)
   e de conta suspensa.
8. Validar a ACL com `squid -k parse` e acrescentar destinos somente após falhas observadas.
