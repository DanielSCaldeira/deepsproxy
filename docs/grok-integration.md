# Integração Grok web (xAI) — 2026-11-06

Provedor `grok`, chat em <https://grok.com/>, modelos anunciados como
`grok/<id>`. O adaptador segue o padrão ChatGPT: o proxy opera o compositor
do próprio site e captura a resposta da requisição que o frontend envia.

> **Estado:** implementado e coberto por testes com HTML e eventos simulados.
> **Nenhum envio autenticado foi feito.** A inspeção usou somente o site
> público, sem login e sem credenciais. Envio real, streaming real, ciclo de
> ferramenta e catálogo de uma conta continuam pendentes (ver
> [Pendências](#pendências-que-exigem-conta-real)).

## O que foi inspecionado e como

Playwright com `playwright-extra` + stealth (mesmo lançador do Qwen), Chromium
headless, `pt-BR`, perfil temporário vazio. Evidências locais em `.cache/grok/`
(fora do Git): `home.html/json/png`, `composer-filled.html`, `model-menu.json`,
`accounts.*`, `anon-*.json/png`, `probes.json`, `network.json` e os bundles
públicos (`bundles/`). Scripts usados: `.cache/grok/inspect.ts`, `probe.ts` e
`anon-send.ts`.

| Etapa | Resultado observado |
| --- | --- |
| `GET https://grok.com/` | HTTP 200, título "Grok"; Cloudflare executou o desafio JS invisível (`/cdn-cgi/challenge-platform/.../jsd/oneshot`) sem bloquear. |
| Página de login `https://accounts.x.ai/sign-in?redirect=grok-com` | **HTTP 403 "Attention Required! \| Cloudflare"** no headless. Nada foi contornado; o login fica para o navegador humano da tela remota. |
| `GET /api/auth/session` sem login | HTTP 200 `{"status":"unauthenticated"}`. |
| `GET /rest/app-chat/conversations`, `/rest/user-settings`, `POST /rest/rate-limits` sem login | HTTP 401 `{"code":16,"message":"No credentials presented. [WKE=unauthenticated:no-credentials]"}`. |
| Um envio anônimo ("Responda exatamente com o texto TESTE_GROK_OK") | O site **não chamou a API de chat**: exibiu `[data-testid="user-message"]` e o cartão `[data-testid="anon-paywall-sign-up-card"]` ("Continue sua conversa / Inscreva-se..."). Por isso o formato real do stream não pôde ser capturado. |

## Elementos de automação

### Compositor (verificado sem login)

```html
<form data-composer="true">
  <div data-testid="chat-input">
    <div contenteditable="true" role="combobox" aria-label="Pergunte ao Grok qualquer coisa"
         class="tiptap ProseMirror ..."></div>
  </div>
  <button type="button" id="model-select-trigger" aria-label="Modelo: Fast" aria-haspopup="menu">Fast</button>
  <button type="submit" aria-label="Enviar" data-testid="chat-submit" aria-disabled="false"></button>
</form>
```

| Função | Seletor no adaptador | Evidência |
| --- | --- | --- |
| Editor | `form[data-composer] [data-testid="chat-input"] [contenteditable="true"]:visible`, alternativa `form[data-composer] [contenteditable="true"][role="combobox"]:visible` | HTML real; `fill()` gerou `<p>texto</p>` no TipTap. |
| Enviar | `form[data-composer] button[data-testid="chat-submit"][type="submit"]:visible` | HTML real; habilitado (`aria-disabled="false"`) após preencher. |
| Parar | `button[aria-label="Parar a resposta do modelo"]`, `button[aria-label="Stop model response"]` | Somente bundle (`stop-stream-button-label`). **Não observado** durante uma geração. |
| Seletor de modo | `#model-select-trigger` (`aria-label="Modelo: <título>"`) | HTML real. |
| Opções de modo | `role="menuitemradio"`: Fast, Auto, Expert, Heavy; "Premium" é `role="menuitem"` (upsell) | Menu real sem login: Auto/Expert/Heavy marcados "Requer login". |
| Deslogado | `a[href^="/sign-in"]` ("Entrar"), `a[href^="/sign-up"]`, `[data-testid="anon-paywall-sign-up-card"]`, `[data-testid="anon-paywall-error-card"]` | HTML real e bundle. |
| Mensagens | `[data-testid="user-message"]`; o bundle contém `assistant-message` e a classe `message-bubble` | O contêiner da resposta autenticada **não foi observado**; o adaptador não depende do DOM da resposta. |

### Rede (bundles públicos; formato não confirmado em uma conta)

- **Geração:** `POST /rest/app-chat/conversations/new`, JSON com, entre outros,
  `message`, `modelName`, `modeId`, `temporary`, `isReasoning`,
  `disableSearch`, `enableImageGeneration`, `sendFinalMetadata`... A continuação
  de conversa usa `/rest/app-chat/conversations/{id}/responses`; o adaptador
  sempre abre uma conversa nova em `/`.
- **Stream:** NDJSON (`processChunks` divide o corpo por `\n` e faz
  `JSON.parse` por linha). Cada linha é `{ result: { conversation | title |
  response } }` ou `{ error }`. Em `result.response`: `token`, `isThinking`,
  `messageTag`, `messageStepId`, `isSoftStop`, `responseId`, `userResponse`,
  `modelResponse` (`message`, `sender`, `partial`, `thinkingTrace`, `steps`...),
  `finalMetadata`, `throttle`, `keepAlive`, `sideBySideIndex`, `toolUsageCard`,
  `error`.
- **Parada:** `DELETE /rest/app-chat/conversations/inflight-response/{responseId}`
  (o frontend chama ao clicar em parar). O adaptador clica no botão e aborta a
  requisição capturada; não chama esse endpoint diretamente.
- **Sessão:** `GET /api/auth/session` → `status` ∈ `authenticated` (com
  `session`), `unauthenticated`, `mfa_required`, `blocked`, `user_deleted`,
  `cursor_only_enterprise` (estados lidos do bundle).
- **Catálogo:** `POST /rest/modes {locale}` → `{ modes: [{ id, title,
  description, badgeText, availability }], defaultModeId }` e
  `POST /rest/models {locale}` → `{ models: [{ modelId, name, modeName,
  modelMode, tags }], unavailableModels, defaultFreeModel, ... }`. Enum de
  modos no bundle: `MODEL_MODE_FAST/AUTO/EXPERT/HEAVY` e outros internos.
- **Limite:** `POST /rest/rate-limits {requestKind, modelName}` →
  `remainingQueries`, `waitTimeSeconds`, `windowSizeSeconds`, `totalQueries`...
  Textos de limite no bundle: `rate-limited-response.*`.
- **Erros:** corpo estilo gRPC `{ code, message }` (16 = UNAUTHENTICATED
  observado; 8 = RESOURCE_EXHAUSTED tratado como limite, não verificado).

## Decisões de implementação

Arquivos: `src/providers/grok.ts` (adaptador), `grok-browser.ts` (captura) e
`grok-protocol.ts` (decodificação, erros, catálogo).

- **Envio por interação:** abre `https://grok.com/`, aguarda o editor, seleciona
  o modo, preenche e clica em Enviar com `noWaitAfter` (o site muda para
  `/c/...`). A captura determina a conclusão; nada é reenviado automaticamente.
- **Captura:** script injetado antes do frontend envolve `fetch` e só reivindica
  `POST /rest/app-chat/conversations/new` cujo `message` coincide com o prompt
  ativo (espaços normalizados só na comparação). Se o corpo trouxer `modeId`
  diferente do modo pedido, a requisição é recusada (`model_mismatch`). Erros
  HTTP expõem apenas status e código, nunca mensagens ou tokens.
- **Decodificação:** emite apenas `token` com `isThinking !== true`,
  `messageTag` ausente ou `final`, sem cartão de ferramenta e
  `sideBySideIndex` 0/ausente. Raciocínio do Grok é descartado (não é exposto
  como `reasoning`). Conclusão: `modelResponse` final (`partial !== true`), que
  só completa um prefixo já enviado; `isSoftStop`; ou fim limpo do HTTP com
  texto. Stream sem texto, JSON inválido e `error` geram erro explícito.
- **Modelos:** `grok/<id>` a partir de `/rest/modes` (observado pelo navegador)
  cruzado com as opções habilitadas do menu; sem esse catálogo, IDs derivados
  dos títulos do menu (`grok/fast`, `grok/auto`, `grok/expert`, `grok/heavy`).
  Opções com `aria-disabled`, "Requer login" ou similares não são anunciadas.
  `grok/auto` seleciona a opção "Auto" do site; se ela não existir, mantém o
  modo padrão atual do site, sem prometer um modelo subjacente. Depois de
  clicar, o adaptador confere `aria-label="Modelo: <título>"`; se um upsell
  mantiver outro modo, falha com 400 sem enviar. `contextLength: 0` (desconhecido),
  sem `max_output_tokens`.
- **API:** só texto (como ChatGPT); `reasoning_effort` diferente de `none` é
  recusado; `thinking` é ignorado.
- **Login:** `manualLoginConfirmation` (botão **Concluir login** no painel),
  igual ao ChatGPT. A tela remota abre `https://grok.com/`; o usuário entra
  por X, Google, Apple ou e-mail em `accounts.x.ai` e resolve desafios
  Cloudflare manualmente. A validação lê só `status` de `/api/auth/session`:
  `authenticated` com `session` → conectado; `unauthenticated`/`mfa_required` →
  login necessário; `blocked`/`user_deleted` → suspensa. HTML de desafio ou
  HTTP ≠ 200 → indisponível (não apaga o login).
- **Expiração/limite durante o uso:** cartão `anon-paywall-*` após enviar →
  401 e bloqueio `login_required`; HTTP 429 ou código 8 → limite com
  `Retry-After` (mínimo 60 s); `/rest/rate-limits` com `remainingQueries: 0`
  observado pelo navegador também gera 429 se o site não enviar a mensagem.
- **Tempo:** limite de 300 s por geração (Expert/Heavy raciocinam por minutos).
- **Navegador:** `playwright-extra` + stealth e `configureBrowserUserAgent`,
  como no Qwen, por causa do Cloudflare.

## Registro nas camadas

| Camada | Alteração |
| --- | --- |
| Identidade | `ProviderId` (`types.ts`), `isProviderId`/`providerIdForModel` (`catalog.ts`), fábrica (`registry.ts`). |
| Perfil | `GROK_PROFILE_DIR` (padrão `grok_profile`) em `session-store.ts`; `.gitignore`, `.dockerignore`, `.env.example`, `scripts/test.js`. |
| Banco | Restrição `provider_accounts_provider_check` inclui `grok`; novo bloco (marcador de versão 6) cria uma conta Grok por usuário; `providers` e `ensureAccounts`. Reaplicação segura. |
| Provisionamento/gateway/painel | `provisioner.ts` aceita `grok`; gateway nomeia "Grok" e marca `manualLoginConfirmation`; `panel.js` mostra Concluir login; texto de ajuda da tela remota. |
| Erros/logs | `api-error.ts` (nome, URL, prefixo `grok_`, instrução de Concluir login), `generation-guard.ts`, `browser-logging.ts`. |
| API | `chat.ts` (só texto, `reasoning_effort`), `index.ts` (sem `max_output_tokens` inventado), `openapi.ts`. |
| Backup/restauração | `backup.sh` já enumera todas as contas; `restore-profile.sh` aceita `grok`. |
| Rede | `squid.conf`: `.grok.com .x.ai` (observados) e hosts de login X/Apple (não observados pelo proxy). Google e `.challenges.cloudflare.com` já estavam liberados. `squid -k parse` **não** foi executado (sem subir containers). |

Nota de mesclagem: o marcador de migração `6` e a linha da restrição de
provedores tendem a conflitar com outros ramos de provedores; a lista final da
restrição deve conter todos os provedores, porque o bloco é reaplicado a cada
inicialização.

## Testes executados

```powershell
npm run build                              # tsc sem erros
node scripts/test.js src/grok.test.ts      # 7/7
npm test                                   # suíte completa (ver Resultado)
```

`src/grok.test.ts` cobre: catálogo/roteamento e mapeamento de erros; NDJSON com
CRLF, Unicode fragmentado, raciocínio, etapas marcadas, `keepAlive`,
`throttle`, side-by-side, `modelResponse` parcial/final e `isSoftStop`; dados
malformados e erros gRPC; chamada de ferramenta pelo parser compartilhado;
captura no navegador (correlação, outra conversa, `model_mismatch`,
cancelamento); fixture do compositor observado com login, listagem de modos,
seleção Auto/Expert, upsell e opção bloqueada sem envio, prompt serializado
com ferramentas pela rota `/v1`, `reasoning_effort` recusado, cancelamento sem
consumir o corpo, 429 com `Retry-After`, cartão de paywall → login necessário,
sessão expirada e conta bloqueada; confirmação manual antecipada recusada e
confirmação válida salvando o mesmo perfil. `production.test.ts` e
`provider-migration.test.ts` passaram a enumerar quatro provedores e a rotear
`grok/auto` para a conta Grok do usuário.

Resultado da suíte completa: ver seção [Resultado](#resultado).

## Pendências que exigem conta real

1. Login real pelo painel (X, Google, Apple, e-mail) dentro do worker, incluindo
   o comportamento do Cloudflare em `accounts.x.ai` no navegador humano e se a
   política `BrowserSignin` interfere no login Google.
2. Confirmar que `/api/auth/session` autenticado devolve `status:
   "authenticated"` com `session`, e a persistência após reiniciar o worker.
3. Envio real: confirmar que o frontend usa `window.fetch` (não XHR nem worker)
   para `/rest/app-chat/conversations/new`, o campo `message` igual ao texto do
   editor, a presença de `modeId` e o formato NDJSON (`token`, `messageTag`,
   `modelResponse.sender/partial`, fim do stream).
4. Seletor do botão Parar durante a geração e o contêiner da resposta.
5. Catálogo real de `/rest/modes` (IDs, títulos, `availability`) para conta
   gratuita e SuperGrok; rótulos de opções bloqueadas para usuário logado.
6. Ciclo completo de ferramenta (roteiro da seção 6 do guia), streaming e
   não streaming, pelo worker e depois pelo gateway com chave `dsp_`.
7. Avisos de limite reais (HTTP 429, código gRPC, `/rest/rate-limits`) e
   mensagens de conta bloqueada.
8. ACL do Squid validada com `squid -k parse` e hosts realmente necessários ao
   login X/Apple.

Smoke opcional após login no painel:

```powershell
# DSP_API_KEY no ambiente ou .cache/grok-api-key.txt; DSP_TIMEOUT_MS opcional.
npx tsx scripts/smoke-grok.ts
```

Grava requisições sem credenciais e respostas em `.cache/grok-live-api-result.json`.

## Resultado

Em 2026-11-06, no worktree `feat/provider-grok` (Windows, Node 24.14):

- `npm run build`: sem erros.
- `node scripts/test.js src/grok.test.ts src/production.test.ts src/provider-migration.test.ts`:
  25/25 aprovados.
- `npm test`: 128 testes, 125 aprovados, 0 falhas de asserção, 2 ignorados e
  1 cancelado por tempo: `diagnostic-flow.test.ts` ("browser diagnostics
  distinguish login..."), teste DeepSeek com limite fixo de 30 s. Ele passa
  isolado (≈24 s) e a suíte completa da base `bb3ecff`, sem as mudanças do Grok,
  falhou da mesma forma nesta máquina (118 aprovados, o mesmo teste cancelado),
  com vários navegadores de outros trabalhos em paralelo. Não foi alterado.
- `production.test.ts` passou a usar `maxWorkers: 6`, porque o caso de
  isolamento agora inicia também o worker Grok.
