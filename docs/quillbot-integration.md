# Integração QuillBot AI Chat — 2026-11-06

Provedor `quillbot`, modelo anunciado `quillbot/chat`. Este registro separa o
que foi verificado no site público, sem conta, do que ainda depende de uma
conta real. **Nenhum login foi feito e nenhuma credencial foi usada.**

## URL escolhida

- Chat: `https://quillbot.com/ai-chat` (confirmada a partir de `quillbot.com`:
  o menu lateral “AI Chat” aponta para `/ai-chat`). Uma conversa aberta muda a
  URL para `/ai-chat/c/<uuid>`.
- Login: `https://quillbot.com/login?returnUrl=/ai-chat`. A página mostra
  `Continue with Google` (`data-testid="google-login-btn-login-form"`),
  `Continue with Facebook` (`facebook-login-btn-login-form`), `Continue with
  Apple` (`apple-login-btn-login-form`), e-mail (`input[name=username]`,
  `autocomplete=username`), senha (`input[name=password]`) e `login-btn`.
- Domínio de autenticação Firebase declarado pelo site: `auth.quillbot.com`.
  API do site: `https://quillbot.com/api` (`QUILL_BACKEND_HOST` + `/api`).

## Como foi inspecionado

Data: 2026-11-06, Chromium do Playwright com `playwright-extra` + stealth,
perfis temporários, sem cookies prévios. Evidências locais (não versionadas)
em `.cache/quillbot/`.

- **Headless**: `/ai-chat` respondeu 403 com o interstício da Cloudflare
  (“Just a moment...”, Turnstile). Nada foi feito para contornar o desafio.
- **Com janela (headed)**: a mesma página carregou normalmente, sem desafio
  visível, e permitiu levantar HTML, rede e bundles.
- Bundles públicos analisados (`libs.quillbot.com`): `ai-chat-core v0.27.2`,
  `ai-chat v1.16.2`, `auth v7.27.2`, `core v12.185.1`, `stream-gate v0.31.3`.
- **Envio anônimo real (1 mensagem)**: o site permite 1 mensagem para
  visitantes (`/api/ai-chat/chat/limit/ai-chat.chat` → `{"data":{"limit":1,"remaining":1}}`).
  Foi enviada uma única mensagem sintética (“Responda apenas com a palavra:
  OK”) usando a própria captura do adaptador (`installQuillBotCapture`) e o
  decodificador (`parseQuillBotStream`), para confirmar o transporte real. Em
  seguida o contador ficou `remaining: 0`. Isso valida o formato com visitante,
  não com conta autenticada.

## Elementos de automação

| Elemento | Seletor/sinal | Verificado |
| --- | --- | --- |
| Campo (variante “legacy”, `/ai-chat`) | `textarea[data-testid="ai-chat-input"]`, placeholder “Ask me anything”; há um `textarea[aria-hidden]` gêmeo invisível do MUI | Sim (público) |
| Enviar (legacy) | `button[data-testid="quill-chat-send-button"]` (habilitado mesmo vazio; Enter sem Shift também envia) | Sim |
| Campo (variante “unified”, `/ai-chat/c/...`) | `textarea[data-testid="unified-ai-chat-input"][aria-label="Message input"]` | Sim |
| Enviar (unified) | `button[data-testid="ai-chat-send-button"][aria-label="Send message"]`, desabilitado até digitar | Sim |
| Parar | `button[data-testid="ai-chat-stop-button"][aria-label="Stop generating"]` (visto durante a geração) | Sim |
| Contêiner da conversa | `[data-testid="quill-chat-view-container"]` (legacy) | Só no bundle |
| Nova conversa | `ai-chat-new-chat-button` (legacy), `chat-header-new-chat-btn` (unified) | Sim |
| Seleção de modelo | Não existe. Há `quill-chat-tools-trigger`/`ai-chat-tools-button` (ferramentas: imagem, busca, parafraseador...) e `quill-chat-modes-trigger`/`lengths` (modos/tamanho), que não são modelos | Sim |
| Visitante | `button[data-testid="header-menu-button"][title="Log in"]`; menu “Log in / Sign up”; cookie `authenticated=false`; estado SSR `window.__QUILLBOT_CORE_STATE__.user.isAuthenticated=false` | Sim |
| Logado | cookie `authenticated=true` (nome reservado no bundle) e `GET /api/auth/user-cache` ≠ 403 | **Não verificado** |

O adaptador aceita as duas variantes do compositor. Ele abre `/ai-chat` a cada
pedido (nova conversa); o histórico vai no prompt serializado.

## Transporte e eventos

- Envio: `POST https://quillbot.com/api/ai-chat/chat/conversation/<uuid>` via
  `fetch` global (`credentials: include`, `Accept: text/event-stream`,
  cabeçalhos `platform-type`, `qb-product`, `webapp-version`).
  Corpo observado: `{"message":{"content":"..."},"context":{},"origin":{"name":"ai-chat.chat","url":"https://quillbot.com"}}`
  (o bundle também prevê `files`, `prompt`, `json` e `tools`).
- Resposta real: HTTP 200, `Content-Type: application/x-ndjson`, um JSON por linha.
  Sequência observada:
  `status:waiting` → `status:processing` → `message_part {index:0}` →
  `content {content:"OK"}` → `usage {input_tokens, output_tokens, model, cost_usd, cost_source}` →
  `status:completed`.
- `content` é **delta** do trecho atual (o frontend acumula). `message_part`
  inicia um novo balão; o adaptador o separa com uma linha em branco.
- Conclusão: só `status: completed`. O frontend trata o fim do corpo sem
  `completed` como erro; o adaptador também.
- Outros eventos do bundle: `title`, `file`, `annotation`, `ui_part`
  (ignorados), `tool_progress` (só `status: rate_limited` importa),
  `rate_limited {user_status}`, `error {error:{message,code}}`.
- Cancelamento do frontend: `POST /api/ai-chat/chat/conversation/<id>/cancel`.
  O adaptador clica no botão de parar, se visível, e chama a mesma rota com os
  cabeçalhos do próprio pedido, sem levá-los ao Node.
- Erros HTTP: corpo `{code, message, status}`. Códigos de limite citados no
  bundle: `USER_GENERATIONS_HOURLY_LIMIT`, `USER_GENERATIONS_LIMIT`,
  `ANON_GENERATIONS_LIMIT`, `UNVERIFIED_GENERATIONS_LIMIT`, além de
  `REACHED_MAX_ACTIVE_SESSIONS`. Só o 403 `COM_FORBIDDEN` de `user-cache` foi
  visto de fato.
- O modelo subjacente aparece apenas no evento `usage` (visitante:
  `bedrock-gpt-6-luna`). Não há catálogo nem escolha; por isso existe um só
  modelo, `quillbot/chat`, com `contextLength: 0` (contexto desconhecido) e sem
  `max_output_tokens` anunciado.

## Decisões do adaptador

Arquivos: `src/providers/quillbot.ts` (ciclo de vida, login, envio),
`quillbot-browser.ts` (captura e sonda de login, executadas no navegador) e
`quillbot-protocol.ts` (NDJSON → `ProviderEvent`, erros, modelo).

- Padrão ChatGPT: o site prepara e envia a requisição; um `fetch` instrumentado
  antes dos scripts copia somente a conversa cujo `message.content`
  normalizado coincide com o prompt ativo. O clique usa `noWaitAfter`; a
  captura determina o fim. Não há reenvio automático.
- Autenticação (`validate`): uma sonda dentro da página devolve só booleanos e
  números — interstício da Cloudflare pelo título, cookie `authenticated=true`,
  status de `GET /api/auth/user-cache` e o contador `limit/remaining`. Logado =
  cookie verdadeiro **e** `user-cache` 200. 401/403 → `login_required`;
  título “Just a moment...” → indisponível (503), sem bloquear a conta.
- `remaining: 0` deixa o status `rate_limited` com a mensagem “Limite de
  mensagens do QuillBot atingido.” e recusa o envio antes de digitar. HTTP 429
  ou eventos de limite adiam a fila por `Retry-After` (mínimo 60 s) sem apagar
  o login.
- Login no painel: `manualLoginConfirmation` (igual ao ChatGPT). O worker abre
  o navegador humano em `/login?returnUrl=/ai-chat`; após o login o usuário
  clica em **Concluir login**, o adaptador reabre a automação no mesmo perfil,
  valida e salva a sessão. Confirmação antecipada falha e reabre a tela.
- Somente texto: imagens/arquivos e `reasoning_effort` são recusados em
  `src/routes/chat.ts`.

## Registro nas camadas

`types.ts`, `catalog.ts`, `registry.ts`; `session-store.ts`
(`QUILLBOT_PROFILE_DIR`, padrão `quillbot_profile`); nomes em
`generation-guard.ts`, `api-error.ts` (URL de ajuda `https://quillbot.com/ai-chat`)
e `browser-logging.ts`; `index.ts` (sem `max_output_tokens` inventado);
`openapi.ts`; `production/database.ts` (`providers`, `ensureAccounts` e
migração **15**: uma conta `quillbot` por usuário, reaplicável);
`provisioner.ts`; `gateway.ts` (nome “QuillBot” e confirmação manual);
`public/panel.js`; `deploy/restore-profile.sh`; `deploy/squid.conf`;
`.gitignore`, `.dockerignore`, `.env.example`; `scripts/test.js`.

Migração: `migrate()` reaplica todos os blocos a cada início. O bloco 5
recriava a restrição com a lista fixa `('deepseek','qwen','chatgpt')`, o que
falhava na segunda execução assim que existisse uma conta de outro provedor
(o teste de migração repetida acusou isso). A restrição do bloco 5 passou a ser
gerada a partir de `providers`, de modo que cada novo provedor só precisa
entrar nessa lista. O número 15 evita colidir com as integrações paralelas;
pode ser renumerado na mesclagem, desde que continue após a 5. Ao mesclar as
outras integrações, mantenha uma única lista `providers` com todos os IDs.

Egress (Squid): `.quillbot.com` cobre site, `libs`, `assets`, `media` e
`auth.quillbot.com` (observados). `identitytoolkit.googleapis.com`,
`securetoken.googleapis.com` (Firebase Auth), `appleid.apple.com`,
`appleid.cdn-apple.com`, `www.facebook.com` e `static.xx.fbcdn.net` foram
acrescentados por documentação dos provedores de login, **sem observação
real**; `.google.com`, `.gstatic.com` e `.challenges.cloudflare.com` já
existiam. `squid -k parse` não foi executado (o ambiente de containers não foi
iniciado nesta tarefa).

## Testes

`src/quillbot.test.ts` (7 testes): roteamento e erros; NDJSON com CRLF,
Unicode partido, partes, uso e linha final sem `\n`; falhas explícitas
(malformado, sem `completed`, `failed`, `error`, `rate_limited`); chamadas de
ferramenta pelo parser comum; captura no navegador (ignora outros pedidos,
correlaciona prompt normalizado, devolve a resposta ao frontend, cancela e
extrai código de erro); fixture do frontend com as duas variantes do
compositor, `/v1/models`, `/v1/chat/completions` com histórico de ferramenta
(stream e não stream), cancelamento sem consumir, 429, contador zerado,
interstício da Cloudflare, sessão expirada e cookie de visitante; confirmação
manual antecipada e bem-sucedida. Ajustes compartilhados:
`provider-migration.test.ts` (4 contas), `production.test.ts` (4 provedores,
roteamento `quillbot/chat`, nome e confirmação manual; capacidade da fixture
de 5 para 8 navegadores, pois o cenário agora ativa 6 workers),
`production-ui.test.ts` (card QuillBot com **Concluir login**).

Resultado em 2026-11-06 (worktree, máquina compartilhada com outras
integrações em paralelo): `npm run build` sem erros; `npm test` com 128
testes, 125 aprovados, 0 falhas, 2 ignorados e 1 cancelado por tempo:
`diagnostic-flow.test.ts` (“browser diagnostics distinguish login...”, limite
de 30 s, DeepSeek). Esse teste também excedeu 30 s no código base `bb3ecff`
sem estas mudanças (1 de 3 execuções passou) e passa com limite maior
(32–55 s com as mudanças, 40 s na base): é sensível à carga, não à integração.

Smoke opcional contra um ambiente já autenticado:
`DSP_API_KEY=... npx tsx scripts/smoke-quillbot.ts` (texto e streaming em
`quillbot/chat`; resultado em `.cache/quillbot-live-api-result.json`).

## Pendente de validação com conta real

- Login por e-mail, Google, Apple e Facebook na tela remota do worker (popups
  OAuth, possíveis desafios Cloudflare/reCAPTCHA, hosts do Squid).
- Confirmar que, logado, o cookie `authenticated` vale `true` e
  `GET /api/auth/user-cache` responde 200; e que, expirado, volta 401/403.
- Comportamento headless/worker diante do interstício da Cloudflare (no
  headless local ele bloqueou; o worker usa navegador com janela no Xvfb).
- Envio autenticado real em texto e streaming pelo worker e pelo gateway `/v1`.
- Ciclo completo de ferramenta de IDE (chamada `<tool_call>`, execução no
  cliente, continuação com o resultado).
- Limites de conta Free/Premium: formato de `limit/remaining` logado, códigos
  de 429 e `rate_limited`, e se uma conta logada usa outro `origin`.
- Tamanho máximo do texto aceito pelo campo (prompts longos de IDE) e se o
  site trunca conteúdo (`DOCUMENT_TOO_LARGE`).
- Se o servidor encerra a geração com a rota `/cancel` usada pelo adaptador.
