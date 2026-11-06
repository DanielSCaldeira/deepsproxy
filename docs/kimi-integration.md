# Integração Kimi (Moonshot AI) web — 2026-11-06

O provedor `kimi` foi acrescentado ao código, painel, provisionamento, migração,
gateway, restauração de perfil e ACL de saída. Os modelos são anunciados como
`kimi/<id-original>`. **Nenhuma etapa autenticada foi executada**: não houve
login, envio real nem ciclo de ferramenta com conta Kimi. Tudo o que depende de
sessão está marcado abaixo como "não verificado".

## URL escolhida: `https://www.kimi.ai`

Consultas sem credenciais em 2026-11-06 (frontend `kimi-release-version`
`40f0c2d`, publicado em 2026-11-05):

| Endereço informado | Resultado |
| --- | --- |
| `https://kimi.ai` | redireciona para `https://www.kimi.ai/` (HTML `lang="en-US"`, canonical `www.kimi.ai`) |
| `https://kimi.com` | redireciona para `https://www.kimi.com/` (HTML `lang="zh-CN"`) |
| `https://kimi.moonshot.cn` | HTTP 302 para `https://www.kimi.com/` |

Os dois hosts servem o mesmo build, mas o login é regional:

- `www.kimi.com`: login por QR do WeChat, telefone com prefixo fixo `+86` e
  SSO. O rodapé diz que quem usa "Log in with Google" deve acessar kimi.ai.
- `www.kimi.ai`: telefone internacional (prefixo detectado, `+55` na
  inspeção), **Continue with Google** e SSO. Não apareceu campo de e-mail
  no modal; login por e-mail não foi observado.

Foi escolhida a versão internacional, `https://www.kimi.ai`. O navegador remoto
do painel abre essa URL. Os assets vêm de `statics.kimi.ai`; o bundle usa
`https://auth.kimi.com` como host padrão da API de autenticação.

## Como foi inspecionado

- `curl` do HTML público dos dois hosts e download dos 144 bundles JS
  referenciados (cópias em `.cache/kimi/bundles`, fora do Git).
- Os descritores protobuf embutidos nos bundles (base64) foram decodificados
  para obter serviços, métodos e mensagens (`.cache/kimi/*.proto.txt`).
- Playwright com `playwright-extra` + stealth, headless, sem credenciais:
  página inicial, editor antes/depois de digitar (sem enviar), menu de modelos
  e modal de login. Capturas em `.cache/kimi/*.png`, `dom-*.json`,
  `composer-*.html`, `network.json`, `*-login-modal.*`, `*-model-menu.*`.
- Não houve desafio anti-bot nem CAPTCHA no carregamento público. Nada foi
  enviado ao chat e nenhum login foi tentado.

## Elementos identificados

### Compositor (observado no DOM público)

| Função | Seletor | Observação |
| --- | --- | --- |
| Campo | `[data-testid="chat-editor"] [contenteditable="true"][role="textbox"]` | `div.chat-input-editor`, editor Lexical (`data-lexical-editor="true"`) |
| Enviar | `.send-button-container:not(.disabled)` | `div` sem `role`/`aria-label`; classe `disabled` com o campo vazio, removida ao digitar (observado) |
| Parar | `.send-button-container.stop` | o mesmo controle troca o ícone para `stop` durante a geração (lido no bundle, não observado) |
| Modelo | `[data-testid="model-select-trigger"]` | `aria-haspopup="menu"`, texto em `.model-name` (ex.: "K3 High") |
| Opções | `button[role="menuitemradio"][data-testid="model-option"] .model-name` | dentro de `[data-testid="model-list-options"]` |
| Mais modelos | `[data-testid="model-more-trigger"]` | submenu "More models"; esforço em `[data-testid="model-effort-item"]` |

Classes da resposta no bundle: `chat-content-item-assistant`,
`segment-assistant`, `markdown-container`. O adaptador não depende delas:
a resposta é lida da rede.

### Login e sessão

- Deslogado (observado): `button.login-button` "Log in", `span.not-login-icon`
  e "Log in to sync chat history".
- Modal de kimi.ai (observado): `[data-testid="login-phone-input"]`,
  `login-code-input`, `login-send-code`, `login-submit`, botão
  "Continue with Google" e `.sso-button`.
- Bundle: os tokens ficam em `localStorage` (`access_token`, `refresh_token`).
  O frontend só chama `UserService/GetCurrentUser` quando existe
  `refresh_token`, e considera logado (`hasLogin`) quando recebe `user`.
- Visitantes podem conversar (`REASON_ANONYMOUS_USAGE_EXCEEDED`,
  `REASON_ANONYMOUS_REQUIRE_LOGIN`). Por isso o editor visível não prova login.

### Transporte (bundle e rede pública)

- Connect RPC em `/apiv2/<pacote>.<Serviço>/<Método>`, codec JSON. Requisições
  usam nomes de campo protobuf (`useProtoFieldName`). A resposta unária
  observada usa camelCase (`availableModels`).
- Headers do frontend observados: `connect-protocol-version`, `x-msh-platform`,
  `x-msh-device-id`, `x-msh-session-id`, `x-msh-version`, `x-language`,
  `r-timezone` e `x-traffic-id`. Logado: `Authorization: Bearer <access_token>`.
  O `fetch` do frontend renova o token em um 401 e repete a chamada.
- Sem login, `StorageService/GetUserStorageQuota` e
  `MembershipService/GetSubscriptionStats` retornaram 401
  `{"code":"unauthenticated","details":[{"debug":{"reason":"REASON_INVALID_AUTH_TOKEN"}}]}`.
- Geração: `kimi.gateway.chat.v1.ChatService/Chat`, com streaming do servidor
  (`application/connect+json`). Os frames têm 1 byte de flags, 4 bytes de
  tamanho e JSON; a flag `0x02` encerra o stream com erro ou metadados.
  A requisição `ChatRequest` contém `message.blocks[].text.content`,
  `scenario`, `kimiplus_id` e `options` (`thinking`, `reasoning_effort`,
  `context_length`, `model` etc.).
- Eventos `ChatResponse`: `op` (`set`/`append`), `mask` (FieldMask),
  `event_offset` e um destes campos: `chat`, `message`, `block`, `ref`, `usage`,
  `notification`, `done`, `heartbeat`, `tts`, `interaction` ou
  `interaction_ack`. Blocos podem ser `text`, `think`, `tool`, `search`,
  `exception`, entre outros.
- Regra do frontend para blocos de texto: o primeiro evento cria o bloco;
  `set` com máscara `block` substitui; os demais anexam `text.content`.
- Parada: `ChatService/CancelChat`, acionado pelo botão.
- Limites: `kimi.chat.v1.Error.reason` e `common.error.v1.Reason` incluem
  `REASON_TEXT_USAGE_EXCEEDED`, `REASON_RATE_LIMIT_EXCEEDED`,
  `REASON_QUOTA_EXCEEDED_*`, `REASON_ACCOUNT_BANNED/SUSPENDED` etc.
  `Notification.type` também tem avisos de upgrade.
- Catálogo: `ConfigService/GetAvailableModels` responde sem login, com
  `availableModels`/`moreModels` (`scenario`, `displayName`, `key`, `id`,
  `kimiPlusId`, `reasoningEffortOptions`) e `defaultChatModel`. Em kimi.ai,
  sem login: `K3` (`k3-agent`, OK Computer), `K2.8 Preview`
  (`k28-agent-preview`, OK Computer) e `Instant` (`k2d6-chat`,
  `SCENARIO_CHAT`). O navegador em kimi.com recebeu `K3.1 Pro`
  (`k3d1-agent`); o catálogo varia por sessão.

## Implementação

| Arquivo | Conteúdo |
| --- | --- |
| `src/providers/kimi.ts` | Adaptador `KimiProvider` no padrão ChatGPT: navegador persistente, login humano pelo `InteractiveBrowser`, **Concluir login**, validação, catálogo, seleção de modelo, envio pela interface e captura |
| `src/providers/kimi-browser.ts` | Script injetado antes do frontend: observa só o `Chat` cujo texto corresponde ao prompt ativo e repassa os bytes em base64; tokens não saem do Chromium |
| `src/providers/kimi-protocol.ts` | Decodificação Connect, eventos → `ProviderEvent`, catálogo e mapeamento de erros |
| `src/kimi.test.ts` | Protocolo, captura, frontend simulado, login e API `/v1` com ferramentas |
| `scripts/smoke-kimi.ts` | Teste real opcional via `/v1` (normal e SSE), resultado em `.cache/kimi-live-api-result.json` |

Decisões:

- **Login válido** exige `refresh_token` no `localStorage` e
  `GetCurrentUser` com `user.id`. A chamada é feita no navegador e só um
  booleano e o status voltam ao Node. Em 401 com `refresh_token`, a página é
  recarregada uma vez para o frontend renovar o token; depois disso, a
  sessão é tratada como expirada (`login_required`). Os motivos
  `REASON_ACCOUNT_BANNED/SUSPENDED/DISABLED/ACCESS_DENIED` resultam em `suspended`.
- **Painel**: `manualLoginConfirmation` para `kimi`, como no ChatGPT. O
  navegador remoto abre `https://www.kimi.ai/`. O login com Google acontece
  no Chromium humano do worker, não no navegador automatizado.
- **Modelos**: só entradas `SCENARIO_CHAT` sem `kimiPlusId`. Os modelos
  "OK Computer" executam ferramentas e sandbox no próprio Kimi, o que conflita
  com ferramentas executadas pelo cliente IDE. O ID é `kimi/<Model.id>`
  (por exemplo, `kimi/k2d6-chat`), com `contextLength: 0` (origem
  `unknown`) e sem `max_output_tokens`. Não existe `kimi/auto`.
  Um modelo só é anunciado se o rótulo aparecer no menu da conta.
- **Envio**: o adaptador abre `/`, seleciona o modelo pelo menu, preenche o
  editor e clica no controle de envio com `noWaitAfter`. A captura determina
  o fim da resposta, com `done` ou o frame final. Se `options.model` vier
  preenchido e não for o `id`, a `key` ou o `modelId` pedido, a resposta
  falha com `model_mismatch`.
- **Raciocínio**: blocos `think` só viram eventos `reasoning` com
  `thinking=true`. A rota de chat usa `false` para `kimi`, como no ChatGPT.
  `reasoning_effort` diferente de `none` e conteúdo não textual são rejeitados.
- **Erros**: `unauthenticated` → 401; `resource_exhausted` e motivos de
  uso/limite → 429, com o login preservado e espera mínima de 60 s;
  suspensão → 403. Um 403 genérico não é tratado como suspensão. Texto já
  emitido que o site reescreve gera erro, sem duplicar a resposta.

### Camadas registradas

`ProviderId`, `catalog.ts` (`kimi/` → `kimi`), `registry.ts`,
`session-store.ts` (`KIMI_PROFILE_DIR`, padrão `kimi_profile`),
`database.ts` (restrição de provedor com `kimi`, migração 6 com uma conta
por usuário, `providers` e `ensureAccounts`), `provisioner.ts`, `gateway.ts` (nome "Kimi"
e confirmação manual), `public/panel.js`, `routes/chat.ts` (só texto, sem
`reasoning_effort`), `index.ts` (sem `max_output_tokens` inventado),
`openapi.ts`, `api-error.ts`, `generation-guard.ts`, `browser-logging.ts`,
`deploy/restore-profile.sh`, `deploy/squid.conf` (`.kimi.ai auth.kimi.com`;
domínios Google já liberados), `.gitignore`, `.dockerignore`, `.env.example`
e `scripts/test.js` (`KIMI_PROFILE_DIR` temporário).

Nota para a mesclagem: o bloco da migração 5 recria
`provider_accounts_provider_check` a cada inicialização. Por isso, `kimi` foi
acrescentado a essa lista; manter `kimi` só em uma migração posterior violaria a
restrição na segunda execução, como o teste de migração repetida mostrou.
Ao combinar com outros branches, essa lista deve conter todos os IDs, e cada
migração nova precisa de um número de versão diferente. Este branch usa o 6.

## O que foi verificado

- Redirecionamentos, HTML, bundles, descritores protobuf, compositor público,
  estado do envio ao digitar, menu de modelos, modais de login e chamadas
  Connect sem login.
- Testes automatizados com fixtures baseadas nessas capturas: frames
  divididos byte a byte, Unicode fragmentado, `append`/`set`, eco do usuário,
  `think` oculto, `done`, erros no frame final, truncamento, reescrita, parser
  de ferramentas, captura só do prompt ativo, `model_mismatch`, cancelamento,
  frontend simulado (editor Lexical, envio por classes e menu), `/v1` com
  histórico de ferramenta (normal e SSE), limite de uso, expiração com
  recarga, visitante sem `refresh_token`, confirmação antecipada recusada e
  sessão salva.
- `npm run build` passou. `npm test`: ver resultado no fim deste documento.

## Pendente de validação com conta real

1. Login no painel com Google e com telefone em kimi.ai, **Concluir login**,
   status `Conectada` e sessão salva após reiniciar o worker.
2. Se `GetCurrentUser` aceita a chamada do adaptador só com `Authorization`,
   `connect-protocol-version` e `x-msh-platform`, sem `x-msh-device-id`
   e `x-msh-session-id` (não verificado).
3. Envio real: `fill` no editor Lexical, habilitação e clique do
   `.send-button-container`, mudança para `/chat/<id>` e captura do `Chat`.
   Não foi verificado se `options.model` traz `id` ou `key`, nem a forma
   JSON dos eventos em streaming (camelCase esperado, como na resposta unária).
4. Catálogo da conta: modelos `SCENARIO_CHAT` disponíveis, troca pelo menu e
   submenu "More models". Talvez seja útil expor modelos de agente no futuro.
5. Parada com `.send-button-container.stop` (pode abrir confirmação) e
   liberação da fila. Avisos de limite reais (`Notification`, `Error.reason`).
6. Ciclo de ferramenta de IDE: chamada com `tool_choice` obrigatório,
   resultado `role: "tool"` e continuação com o valor lido, como no roteiro do
   [guia](guia-novos-provedores.md#6-valide-em-camadas-incluindo-um-ciclo-real-de-ferramenta).
7. ACL do Squid com o tráfego real do login Google/telefone (`auth.kimi.com`
   e eventuais CDNs/captcha não observados) e `squid -k parse`.

Roteiro sugerido após o login no painel:

```powershell
# DSP_API_KEY no ambiente ou em .cache/kimi-api-key.txt; KIMI_MODEL opcional.
npx tsx scripts/smoke-kimi.ts
```

## Resultado dos testes (2026-11-06, worktree `feat/provider-kimi`)

- `npm run build`: passou.
- `node scripts/test.js src/kimi.test.ts`: 8 testes, todos aprovados.
- Migração repetida, produção (contas `chatgpt`, `deepseek`, `kimi`, `qwen`
  por usuário, nome e confirmação manual do card Kimi) e painel: aprovados.
- `npm test`: 130 testes, 126 aprovados, 2 ignorados, 1 falha e 1 cancelado,
  ambos em `src/diagnostic-flow.test.ts` (timeout de 30 s do fluxo DeepSeek e
  `EBUSY` ao apagar o perfil temporário). O mesmo teste falha da mesma forma
  no commit base `bb3ecff` sem as alterações deste branch, nesta máquina e
  com outros agentes rodando ao mesmo tempo. Não envolve o Kimi.
