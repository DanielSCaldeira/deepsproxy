# Integração Microsoft Copilot web — 2026-11-06

Provedor `copilot`, chat em `https://copilot.microsoft.com/chats/new`, modelos
expostos como `copilot/<modo-original>`. O adaptador segue o padrão do ChatGPT:
o próprio frontend do site prepara e envia a mensagem; o proxy opera o
compositor e captura a resposta do canal de chat do site.

**Estado: implementado e testado com frontend simulado. Nenhum envio real com
conta Microsoft foi feito.** Toda a inspeção foi feita sem credenciais.

## O que foi observado de fato (sem login, 2026-11-06, pt-BR/en-US)

Capturas sanitizadas em `.cache/copilot/` (fora do Git): `initial.html`,
`hydrated.json`, `t0..t3.{json,html,png}`, `anonymous-api.json` e os bundles
públicos em `.cache/copilot/bundles/`.

- `GET https://copilot.microsoft.com/` responde **301 para `https://copilot.com/`**,
  página de marketing "Sign into Copilot" (Office Hub). O botão "Sign in" leva a
  `copilot.com/login`, que redireciona para
  `login.microsoftonline.com/common/oauth2/v2.0/authorize` (campos `loginfmt`,
  `passwd`, botão `#idSIButton9`). Os cards "Go to Chat" apontam para
  `m365.cloud.microsoft/chat`, que também exige login.
- `GET https://copilot.microsoft.com/chats/new` responde 200 e carrega o app de
  consumidor (`/static/cmc/assets/*.js`). Sem login, o app mostra a página de
  bloqueio anônimo: `[data-testid="anonymous-block-page-title"]` com
  "Sign in to Copilot" e os botões "Sign in with Microsoft/Apple/Google".
  **O uso anônimo está bloqueado** nesta data (`anonymousBlockPageEnabled`,
  feature padrão `anonymous-block-page`), e o proxy também o recusa.
- Rede anônima do app: `POST /c/api/start` (200; `remainingTurns`, `features`),
  `GET /c/api/activation/homepage` (460), telemetria (OneCollector, Sentry,
  Sprig, Clarity) e um script de `copilot.fun`.
- `GET /c/api/user?api-version=2` sem token devolve 200 com
  `accountTier: "guest"`. O frontend envia `Authorization: Bearer` obtido do
  MSAL quando há conta; o proxy **não** lê nem reconstrói esse token.

## Levantado dos bundles públicos (não verificado com conta)

Os itens abaixo vêm do JavaScript público (`index-*.js`) e de esquemas zod do
próprio frontend. Precisam ser confirmados no navegador autenticado.

| Elemento | Seletor / formato |
| --- | --- |
| Campo do compositor | `[data-testid="composer-input"]` (textarea com autoajuste e limite de caracteres) |
| Enviar | `[data-testid="submit-button"]` (`aria-label` = `userInput.submitButtonText`) |
| Parar | `[data-testid="stop-button"]` (`aria-label` "Interrupt message" em inglês) |
| Gatilho de modo | botão com `data-testid="composer-chat-mode-<modo>-button"` e `aria-haspopup="menu"`; com modo não padrão selecionado vira botão de remoção (sem `aria-haspopup`) |
| Menu de modos | `#composer-dropdown-button-menu-contents` com itens `role="menuitem"` e o mesmo `data-testid` |
| Bloqueio anônimo | `[data-testid="anonymous-block-page-title"]`; cabeçalhos `sign-in-exp-chat-header-button` / `sign-in-exp-landing-header-button` |
| Canal de geração | WebSocket `wss://copilot.microsoft.com/c/api/chat?api-version=2&clientSessionId=…&accessToken=…` (thread principal) |

Modos do menu (`zLe`): `smart` (padrão, "Smart"/GPT-5 conforme a variante),
`reasoning` ("Think deeper"), `study`, `search` e `analyst` (só para alguns
tipos de conta). `chat` ("Quick response") é o modo interno e não aparece no
menu. Modos de tarefa (`research`, `computerUse`, `browserAction`...) não são
chat de texto e não são anunciados.

Eventos do WebSocket usados pelo decoder:

- Saída do frontend: `{"event":"send","conversationId","content":[{"type":"text","text"}],"mode","context"}`;
  `{"event":"stop","conversationId"}`; `setOptions`, `challengeResponse` etc.
- Entrada: `received`, `startMessage {conversationId,messageId}`,
  `appendText {messageId,partId,text,parentPartId?}`, `replaceText`,
  `chainOfThought`, `citation`, `partCompleted`, `done {messageId}`,
  `error {errorCode}` (`sign-in-required`, `over-turn-limit`,
  `text-too-long`, `too-many-messages`…), `chatMessageError {errorCode:"throttled",
  errorDetail.nextAvailableAt}`, `turnLimitReached`, `banned {expiresAt}` e
  `challenge {method: copilot|hashcash|cloudflare}` (resolvido pelo próprio
  frontend, com worker de hashcash).

O `GET /c/api/user` autenticado traz `accountTier`
(`guest|free|m365-personal|pro|m365-premium`) e `remainingUsage`.
Não há catálogo de modelos por API; os modos vêm do menu.

## Decisões de implementação

- `src/providers/copilot.ts`: um navegador persistente por conta, sessão via
  `createSessionStore`, `GenerationGuard`, pausas comuns e confirmação manual
  de login (`Concluir login`), como no ChatGPT. A navegação usa sempre
  `/chats/new`, porque `/` cai no redirecionamento 301 para `copilot.com`.
- Login válido (`copilotLoginState`): origem `copilot.microsoft.com`, sem
  página de bloqueio anônimo, compositor visível e `accountTier` diferente de
  `guest` observado na resposta que o **próprio frontend** recebe de
  `/c/api/user`. Redirecionamento para `copilot.com`/`login.*`, tier `guest`,
  401/403 ou o evento `sign-in-required` marcam login necessário. Se o
  compositor ficar visível por 8 s sem nenhuma observação de `/c/api/user`, a
  conta é tratada como autenticada (o app bloqueia anônimos); revisar com conta
  real. A carga da página tem prazo de 30 s.
- `src/providers/copilot-browser.ts` (script de inicialização): envolve
  `WebSocket.prototype.send` apenas para `/c/api/chat`, reivindica o frame
  `send` cujo texto corresponde ao prompt ativo (comparação com espaços
  normalizados), registra `conversationId` e copia só os eventos dessa
  conversa/mensagem. O token do URL do socket não sai do Chromium e os frames
  não são reescritos. Se o modo do frame diferir do solicitado, o frame **não é
  enviado** e a geração falha com 400.
- `src/providers/copilot-protocol.ts`: decodifica os eventos em
  `ProviderEvent`. Partes de texto distintas da mesma resposta são separadas por
  uma linha em branco; `replaceText` só é aceito se estender o texto já emitido;
  `chainOfThought`, citações, cartões e UI generativa são ignorados.
- Modelos: `copilot/auto` (modo padrão do site; desfaz um modo fixado antes)
  e `copilot/smart|reasoning|study|search` somente se o item existir no menu.
  `contextLength: 0` (origem `unknown`), sem `max_output_tokens`.
  `reasoning_effort` e conteúdo não textual são recusados na API.
- Limite do compositor: se o valor do textarea após preencher for menor que o
  prompt, a requisição falha com 413 sem enviar.
- Erros: `throttled`/limites → 429 com prazo do `nextAvailableAt` (mínimo 60 s),
  sem apagar o login; `banned` → suspensa; `sign-in-required` → login necessário;
  queda do socket antes de `done` → 502 sem reenvio automático.

## Camadas registradas

`types.ts`, `catalog.ts`, `registry.ts`, `session-store.ts`
(`COPILOT_PROFILE_DIR`, padrão `copilot_profile`), `generation-guard.ts`,
`api-error.ts` (orientação com conta Microsoft e 2FA), `browser-logging.ts`,
`routes/chat.ts`, `index.ts`, `openapi.ts`, `production/database.ts`
(migração 6: restrição de provedor e uma conta `copilot` por usuário),
`gateway.ts` (nome e confirmação manual), `provisioner.ts`, `panel.ts`,
`public/panel.js`, `deploy/restore-profile.sh`, `deploy/squid.conf`,
`deploy/README.md`, `.gitignore`, `.dockerignore`, `.env.example` e
`scripts/test.js`. `workers.ts` já filtra modelos por `<provedor>/`.

Destinos de saída liberados no Squid: `copilot.microsoft.com`, `copilot.fun`,
`login.microsoftonline.com`, `login.live.com`, `aadcdn.msauth.net`,
`logincdn.msftauth.net` (observados) e `account.live.com`,
`acctcdn.msauth.net`, `acctcdn.msftauth.net` (páginas de verificação em duas
etapas da conta Microsoft; não observados). Telemetria não foi liberada; se o
app depender dela, acrescentar somente após falha concreta. `squid -k parse`
não foi executado.

## Testes

`src/copilot.test.ts` usa um app simulado com os `data-testid` e o esquema de
eventos acima, servido por `context.route` e `context.routeWebSocket`:
roteamento/catálogo, critério de login, decoder (deltas, `replaceText`,
partes, outra conversa no mesmo socket, Unicode, erros, truncamento,
cancelamento), ferramentas pelo parser compartilhado, seleção de modo com modo
fixado, rejeição de modo inexistente, prompt serializado com histórico de
ferramenta via `/v1/chat/completions` (com e sem streaming), cancelamento sem
consumir o corpo, limite do compositor, queda do socket, limite de uso,
expiração, conta `guest` e confirmação de login antecipada/bem-sucedida.
Os testes compartilhados de produção e migração passaram a contar a conta
`copilot`.

Resultado em 2026-11-06 (worktree `feat/provider-copilot`): `npm run build`
sem erros; `src/copilot.test.ts` 7/7; `npm test` 129 testes, 125 aprovados,
e `src/diagnostic-flow.test.ts` estourou o prazo fixo de 30 s (1 falha e 1
cancelamento por EBUSY na limpeza). O mesmo teste também falhou duas vezes no
código base `bb3ecff` sob a mesma carga da máquina (vários navegadores em
paralelo) e passou isoladamente com esta mudança em 26 s; é sensível a tempo,
não ao provedor.

Os testes simulados de WebSocket exigem registrar `routeWebSocket` antes do
script de captura: o mock do Playwright substitui `window.WebSocket`. O
script do proxy precisa ser instalado antes do frontend e depender do
`WebSocket` nativo; se o site trocar a classe depois, a captura não verá o
envio (falha explícita após 30 s, sem reenvio).

## Pendente de validação com conta real

1. Login completo pelo painel (conta Microsoft com 2FA) e retorno ao app em
   `/chats/new`; confirmar se `GET /c/api/user` é chamado pelo frontend e
   qual `accountTier` uma conta gratuita recebe.
2. Seletores reais do compositor autenticado (campo, enviar, parar, menu de
   modos) e se `fill` no textarea habilita o envio.
3. O frame `send` real (campos, valor de `mode` para cada item do menu) e a
   sequência real de eventos até `done`, inclusive em `reasoning`.
4. Desafios `challenge` (hashcash/cloudflare) durante o envio e reconexões do
   socket com `messageRecovered`.
5. Limite de caracteres do compositor e mensagens de limite de uso.
6. Envio normal e SSE pela API do worker e pelo gateway com chave `dsp_`, e o
   ciclo completo de ferramenta descrito no guia.
7. ACL do Squid com o login real (domínios adicionais de 2FA/telemetria).
