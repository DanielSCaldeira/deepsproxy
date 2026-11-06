# Integração Cohere (Command) web — 2026-11-06

Provedor `cohere`, modelos expostos como `cohere/<id-original>`. O adaptador,
o login pelo painel e o registro em todas as camadas foram implementados e
testados com fixtures. **Nenhum envio real foi feito**: a inspeção foi feita
sem conta e sem credenciais, e o playground autenticado não pôde ser observado.
Seletores do compositor, endpoint e formato do stream efetivos ficam pendentes
de validação com uma conta real (ver a última seção).

## URL escolhida: `https://dashboard.cohere.com/playground/chat`

Inspeção feita em 2026-11-06 com Chromium headless (Playwright), idioma pt-BR,
sem login. Capturas sanitizadas (HTML sem scripts longos, controles, rede e
screenshots) estão em `.cache/cohere/` e ficam fora do Git.

| Candidata | Resultado observado |
| --- | --- |
| `https://chat.cohere.com/` | 307 → `coral.cohere.com` → 301 → `dashboard.cohere.com` → 307 → `/welcome/login`. |
| `https://coral.cohere.com/` | 301 → `dashboard.cohere.com` → `/welcome/login`. O Coral foi desativado como app próprio. |
| `https://dashboard.cohere.com/playground/chat` | 307 (Vercel, `X-Matched-Path: /chat`) → `/welcome/login?redirect_uri=%2Fplayground%2Fchat`. |

`cohere.com` só oferece **Sign in** → `https://dashboard.cohere.com/welcome/login`.
O bundle público do dashboard (`_next/static/chunks/pages/_app-*.js`) declara
`NEXT_PUBLIC_CHAT_URL: "https://dashboard.cohere.com/playground/chat"` e
`NEXT_PUBLIC_PLAYGROUND_URL: "https://dashboard.cohere.com/playground"`. É a
única interface de chat com login de conta (e-mail, Google ou GitHub); as
outras URLs só redirecionam para ela, e é a escolhida. O North (`cohere.com/north`)
é um produto empresarial sem cadastro aberto.

O playground é servido por outra aplicação, por *rewrite* (`/playground/:path*`
no `_buildManifest.js`). Sem sessão, o servidor redireciona antes de entregar
HTML ou JavaScript; os bundles do playground não são públicos
(`/playground/_next/...` retorna 404).

## Elementos identificados

### Login (verificado sem credenciais)

- `/welcome/login`: botões `type="button"` **Continue with Google** e
  **Continue with Github** (sem `aria-label`), `input#email[name=email][type=email]`,
  `input#password[name=password]`, `button[type=submit]` **Log in**, links
  `/welcome/register` e `/reset-password`.
- reCAPTCHA Enterprise na página de login e banner de cookies CookieYes
  (**Accept all**, **Reject optional**). O login fica com o usuário na tela remota.
  Nada disso é automatizado.
- Sessão (bundle `_app`): cookies `access_token` (5 dias) e `refresh_token`
  (7 dias), gravados pelo frontend com `js-cookie` (`sameSite: lax`, `secure`).
- API de conta: `POST https://production.api.os.cohere.com/rpc/BlobheartAPI/<Método>`
  com `Authorization: Bearer <access_token>`. `Session` devolve `{ user }`;
  `Refresh` renova os tokens. Sem sessão, `Session` retornou **401** na rede da
  página de login (verificado).

### Critério de login válido/expirado (implementado)

`validate()` executa, no próprio Chromium, `cohereSessionCheck`: lê o cookie
`access_token` e chama `Session` com ele. Para o Node só voltam `status`,
`authenticated` e `refreshable`, nunca token ou identidade.

- 200 com `user` → autenticada.
- Sem `access_token`, mas com `refresh_token` → reabre o playground para o
  frontend renovar, aguarda 2 s e verifica de novo uma vez.
- 401/403 ou ausência de cookies → `login_required`; outros status → `unavailable`.
- Durante a geração, o adaptador também exige que a URL continue em `/playground`.
  Um redirecionamento para `/welcome/login` é tratado como sessão expirada.

### Chat (não verificado: inferido do bundle do dashboard e da documentação pública)

- O bundle do dashboard contém um cliente da API pública (`NEXT_PUBLIC_DORY_API_URL:
  "https://api.cohere.com/v1"`). `chat`/`streamChat` fazem `POST /v1/chat` com
  `{ message, model, chat_history, conversation_id, preamble, stream, tools, ... }`
  e o cabeçalho `Request-Source`. O modelo padrão nesse cliente é
  `command-a-plus-05-2026`; o bundle também cita `command-a-reasoning-08-2025`.
- Existe a RPC `GetOrCreateDefaultAPIKey`. **Hipótese não verificada:** o
  playground chama `api.cohere.com` com a chave de teste da conta e fica
  sujeito aos limites dessa chave (429).
- Formatos de stream documentados pela Cohere, suportados pelo decoder:
  - v2 (SSE): `event: content-delta` / `data: {"type":"content-delta","delta":{"message":{"content":{"text":"..."}}}}`,
    terminando em `message-end` (`delta.finish_reason`, `delta.usage.tokens.output_tokens`);
  - v1 (NDJSON): `{"event_type":"text-generation","text":"..."}` …
    `{"event_type":"stream-end","finish_reason":"COMPLETE","response":{...}}`.
- Seletores do compositor (semânticos e **não verificados**), em
  `src/providers/cohere.ts`:
  - campo: `textarea` com placeholder ou `aria-label` contendo
    “message”/“mensagem”, `textarea[name=message]` ou
    `[contenteditable=true][role=textbox]`. Campos de sistema/preamble são
    excluídos explicitamente;
  - envio: `button[aria-label*=send i]`, `[aria-label*=enviar i]`,
    `[data-testid*=send i]` ou o `submit` do formulário. Sem botão visível,
    usa Enter no campo;
  - parada: `button[aria-label*=stop i]`, `[data-testid*=stop i]` ou texto “Stop”;
  - modelo: `[data-testid*=model i]` (botão/combobox) ou
    `button`/`combobox` com `aria-label*=model i`; opções por `role=option`,
    `menuitem` ou `menuitemradio`.
- Avisos de limite: só pelo status HTTP da requisição capturada (429 ou códigos
  `rate_limit`/`too_many_requests`/`trial_limit`). O texto exibido na interface
  não foi observado.

## Decisões de implementação

- Padrão ChatGPT: o frontend monta e envia a requisição. O adaptador opera o
  campo e o botão e captura a resposta com um `fetch` instrumentado
  (`src/providers/cohere-browser.ts`) antes dos scripts do site. A captura aceita
  `POST` para `api.cohere.com/v1|v2/chat` ou uma rota `/chat` da mesma origem, e
  só associa a requisição cujo último turno `user` coincide com o prompt ativo,
  com espaços normalizados apenas para comparar.
- O site recebe o prompt textual do serializador compartilhado, com
  ferramentas, histórico e `Tool Response`. Cada geração reabre
  `/playground/chat`. Se a requisição capturada levar turnos anteriores
  (`messages` com mais de um turno ou `chat_history`), ela é **bloqueada antes da
  rede** (`stale_history`) para não misturar conversas.
- `cohere/auto` usa o modelo padrão do playground, sem garantir qual é. Os IDs
  específicos só são anunciados quando um catálogo `GET api.cohere.com/v1|v2/models`
  aparece no tráfego **e** o rótulo aparece no menu de modelos. Uma seleção
  específica precisa chegar no `body.model` da requisição; caso contrário, o
  pedido é recusado antes do envio (`model_mismatch` → 400).
- `contextLength: 0` (origem `unknown`), sem `max_output_tokens`. O
  `reasoning_effort` diferente de `none` e o conteúdo não textual são recusados
  na fronteira da API. O canal `thinking` do stream nunca é emitido.
- Login pelo painel: `manualLoginConfirmation` (como ChatGPT e DeepSeek). O
  navegador humano, sem automação, abre `/playground/chat`; o login por
  Google/GitHub e o reCAPTCHA ficam com o usuário. **Concluir login** fecha esse
  navegador, abre a automação no mesmo perfil, valida a sessão e a salva. Se a
  confirmação vier antes do login, o navegador humano é reaberto.
- O 429 aplica `Retry-After` quando o cabeçalho é legível. Em requisição
  cross-origin, isso só ocorre se o CORS expuser o cabeçalho; caso contrário,
  aplica o mínimo de 60 s. Um 429 não apaga o login. O 403 genérico não é
  tratado como suspensão.

## Camadas alteradas

- Novos arquivos: `src/providers/cohere.ts`, `cohere-browser.ts`,
  `cohere-protocol.ts`, `src/cohere.test.ts`, `scripts/smoke-cohere.ts` e este documento.
- Identidade e roteamento: `types.ts`, `catalog.ts` (`cohere/` → `cohere`) e `registry.ts`.
- Perfil: `session-store.ts` (`COHERE_PROFILE_DIR`, padrão `cohere_profile`),
  `.gitignore`, `.dockerignore`, `.env.example` e `scripts/test.js`.
- Mensagens e diagnóstico: `api-error.ts` (serviço, URL de ajuda e Concluir
  login), `generation-guard.ts` e `browser-logging.ts`.
- API: `routes/chat.ts` (texto apenas; sem `reasoning_effort`), `index.ts`
  (sem `max_output_tokens` inventado) e `openapi.ts`.
- Produção: `database.ts` (passo 6 com conta `cohere` por usuário e
  `ensureAccounts`), `gateway.ts` (nome e confirmação manual), `provisioner.ts`,
  `panel.ts`, `public/panel.js`, `deploy/restore-profile.sh` e
  `deploy/squid.conf` (`dashboard.cohere.com`, `production.api.os.cohere.com`
  e `api.cohere.com`).
- Migração: o passo 5 recriava a restrição com uma lista fixa e falhava ao ser
  reaplicado depois da inclusão de `cohere`. Agora ele recria a restrição a
  partir de `providers`. **Atenção na mesclagem com outros provedores:** basta
  acrescentar o ID em `providers` e manter um `INSERT` por provedor.

## O que foi verificado

- Redirecionamentos das três URLs candidatas, a página de login, o 401 da RPC
  `Session` sem sessão, a configuração pública e o cliente de chat no bundle
  do dashboard.
- `npm run build` passou. `src/cohere.test.ts` tem 8 testes, todos aprovados:
  - catálogo e erros;
  - SSE v2 com CRLF e Unicode fragmentado;
  - NDJSON v1;
  - falhas explícitas;
  - ferramentas pelo parser comum;
  - captura com prompt divergente, histórico antigo, modelo divergente e cancelamento;
  - playground simulado com campo de sistema ignorado, seleção de modelo,
    renovação por `refresh_token`, rotas `/v1` com ferramentas, cancelamento
    sem consumir, 429 e sessão expirada;
  - confirmação de login antecipada e válida.
- `production.test.ts` e `provider-migration.test.ts` cobrem quatro contas
  por usuário, o roteamento de `cohere/auto` para a conta certa e a migração
  repetida.
- Suíte completa (`npm test`, máquina com outros agentes rodando navegadores):
  129 testes, 125 aprovados, 0 falhas, 2 skipped e 2 cancelados por timeout:
  - `browser-logging` passou ao ser executado isoladamente;
  - `diagnostic-flow` também excede 30 s no commit base `bb3ecff`.

## Pendente de validação com conta real

1. Login real pela tela remota (e-mail, Google e GitHub) e destinos extras do
   egress. Confira o log `tunnel_errors` do Squid: o playground pode carregar
   assets de outro subdomínio `cohere.com`.
2. HTML autenticado do playground: campo, envio, parada, menu de modelos e
   campo de sistema. Os seletores acima não foram vistos.
3. Endpoint efetivo da geração (`/v1/chat`, `/v2/chat` ou rota própria),
   formato real do stream, sinal de conclusão e chamada do catálogo de modelos.
4. Se cada abertura de `/playground/chat` inicia uma conversa vazia. Caso
   contrário, os envios falharão com `stale_history` e será preciso operar o
   controle de nova conversa.
5. Mensagens e status de limite da chave de teste, inclusive se `Retry-After` é exposto.
6. Envio normal e SSE pela API do worker e pelo gateway com chave `dsp_`
   (`npx tsx scripts/smoke-cohere.ts`). Depois, o ciclo completo de ferramenta do
   guia (`tool_calls` → `role: "tool"` → resposta com o valor lido).
