# Integração Meta AI web — 2026-11-06

Provedor `meta`, site `https://www.meta.ai/`, modelos `meta/<id>`. O adaptador,
o login pelo painel e o registro em todas as camadas foram implementados.
**Nenhum envio autenticado foi realizado**: não havia conta de teste e a
tarefa proibia login. Tudo que depende de uma conta real está listado em
[Pendências](#pendências-que-exigem-conta-real).

## Como a inspeção foi feita

- Data: 2026-11-06, Chromium headless com `playwright-extra` + stealth,
  locale `pt-BR`, sem perfil, sem cookies e sem credenciais.
- O site respondeu em inglês (a interface não seguiu o locale do navegador).
- Scripts e evidências locais ficam em `.cache/meta/` (fora do Git):
  `public/` (HTML sanitizado sem conteúdo de `<script>`, capturas de tela,
  controles e rede da página inicial e da entrada de login), `anon/` (tentativa
  de envio como visitante) e `bundles/` (130 bundles JavaScript públicos de
  `/_next/static/immutable/chunks/`).
- Nenhum CAPTCHA ou desafio visível apareceu. A página faz um `POST
  /__rd_verify_<id>` e grava o cookie `rd_challenge`; essa verificação passou
  sozinha (HTTP 200). Nada foi feito para contorná-la.

## O que foi observado de fato

### Página pública (visitante)

| Elemento | Observação |
| --- | --- |
| Botão de login | `[data-testid="login-button"]`, texto "Log in" (cabeçalho e rodapé) |
| Campo do visitante | `input[type=text][aria-label="Ask Meta AI"]`, placeholder "Ask Meta AI anything..." |
| Envio do visitante | `button[aria-label="Send"]`, desabilitado até digitar; sem `data-testid` nessa variante |
| Anexo | `[data-testid="composer-add-attachment-button"]`, `aria-label="Add attachment"` |
| Nova conversa | `a[data-testid="new-chat-button"][href="/"]` |

Ao clicar em Send como visitante, o site **não enviou** a mensagem: abriu um
diálogo "Welcome to Meta AI / Providing your birthday helps make sure you get
the right experience for your age…" com termos de uso. O diálogo não foi aceito.
Nenhuma conversa nem WebSocket foi aberto. O adaptador trata esse diálogo e o
botão de login como `login_required`.

### Login

`Log in` → `GET /api/oidc/start` (307) → `https://auth.meta.com/oidc` →
`https://auth.meta.com/` com as opções **Continue with Facebook**, **Continue
with Instagram** e **Use mobile number or email**. É OIDC com PKCE (`S256`),
`app_id=1522763855472543`, retorno a `https://www.meta.ai/oidc/callback`.
Durante o redirecionamento houve requisições a `www.facebook.com`,
`www.instagram.com` (`/aymh/redirect-cycle/`) e `static.xx.fbcdn.net`.

### Frontend (bundles públicos)

O site atual é Next.js (Turbopack) com Relay. Itens extraídos dos bundles,
**não exercitados com conta**:

- Cookie de sessão `ecto_1_sess` (HttpOnly, 365 dias); `datr`, `abra_sess`,
  `abra_csrf` e outros aparecem como legados/somente leitura.
- GraphQL em `POST /api/graphql` com consultas persistidas
  `{"doc_id": "<hash>", "variables": {...}}`. Consultas aceitam
  `multipart/mixed, application/json` (entrega incremental separada por `---`);
  assinaturas aceitam `text/event-stream` com linhas `data: {json}` e
  `event: complete`. 401 com `OAuthException`/código 190 ou erro
  `AUTH_REQUIRES_LOGOUT` dispara logout no frontend.
- Visitante: `useFetchTempUserCredentialsMutation`
  (`doc_id 2943394199ee6545d1f0c69d5b6e577f`, chamada na carga da página) cria
  credencial temporária enviada como `Authorization: Bearer` + cabeçalho de ID.
- **Envio de mensagem** (`useEctoDGWSendMessage`): WebSocket binário
  `wss://gateway.meta.ai/ws` ("DGW"), com codec próprio de quadros
  (dados/ack/drain), `authType` `15:0`, compressão negociável e fechamentos
  4001–4005. O formato dos eventos da resposta não foi observado.
- Seletores do usuário autenticado:
  - Editor: `[data-testid="composer-input"]` (Lexical, `contenteditable`).
  - Enviar: `[data-testid="composer-send-button"]`; parar:
    `[data-testid="composer-stop-button"]` (rótulo "Stop").
  - Modo: `[data-testid="composer-mode-dropdown-button"]`; opções
    `[data-testid="composer-mode-option-<id>"]`, onde `<id>` é o ID do modo
    em minúsculas vindo do servidor (`think_fast`, `think_hard`, `canvas`…);
    o site memoriza o último modo escolhido.
  - Conta: `[data-testid="user-menu-button"]` (menu da barra lateral).
  - Mensagens: `[data-message-item][data-message-id][data-message-role="user|assistant"]`,
    `role="article"`, `aria-label` "Your message"/"Meta AI response";
    linhas do usuário têm `data-user-message`.
  - Resposta: `[data-testid="assistant-message"]` com
    `data-streaming-state` (`INIT`, `STREAMING`, `DONE`, `ERROR`, `STOPPED`) e
    `data-streaming-complete`.
  - Copiar: botão `aria-label="Copy response"`; grava o texto-fonte da resposta
    com `navigator.clipboard.writeText` ou `clipboard.write` (`text/plain`).
- Avisos: "You've reached the message limit", "You're sending too many
  requests.", "You reached your limit…" (mídia/Thinking), "Log in or sign up to
  keep chatting with Meta AI.", "Meta AI isn't available yet in your country".

## Decisões do adaptador

Arquivos: `src/providers/meta.ts` (ciclo de vida, login, geração),
`meta-browser.ts` (funções executadas no Chromium) e `meta-protocol.ts`
(classificação e decodificação testáveis sem o site).

- **Envio por interação, conclusão pelo DOM.** O transporte é um WebSocket
  binário não documentado; decodificá-lo exigiria engenharia reversa frágil e
  não verificável sem conta. O adaptador opera o próprio compositor (foco,
  `fill`, clique em Send com `noWaitAfter`) e acompanha o
  `data-streaming-state` da resposta que segue a mensagem do usuário criada
  depois do envio (IDs anteriores são ignorados). Sem reenvio automático.
- **Texto final pela ação "Copy response".** Um script de inicialização
  substitui `navigator.clipboard.writeText/write` somente enquanto o proxy
  copia a resposta, guardando o texto na página em vez da área de transferência.
  Isso preserva markdown e marcadores `<tool_call>` que a renderização HTML
  descartaria. Se o botão não existir, usa o texto renderizado (com perda de
  formatação), registrado como limitação.
- **Sem streaming incremental.** A resposta é emitida em um único evento de
  conteúdo seguido de `finish`, após `DONE`. O cliente SSE recebe os deltas
  normalmente, mas só no fim da geração.
- **Login.** Mesmo fluxo do ChatGPT: navegador humano nativo pelo VNC do
  worker (`InteractiveBrowser`, URL inicial `https://www.meta.ai/`),
  `manualLoginConfirmation` e **Concluir login**. A validação exige
  `[data-testid="user-menu-button"]` e ausência de `login-button` visível ou
  do diálogo de visitante; o compositor sozinho não conta, pois visitantes
  também o têm. O cookie HttpOnly não é lido pelo Node. Página fora de
  `https://www.meta.ai` (ex.: `auth.meta.com`) é `login_required`.
- **Expiração.** Cada geração recarrega `https://www.meta.ai/` e revalida; o
  botão de login, o diálogo de visitante ou o aviso "Log in or sign up…" durante
  a geração resultam em 401 e bloqueio `login_required` até novo login.
- **Limites e região.** Avisos de limite viram 429 e adiam a conta por 15
  minutos (o site não informa prazo legível); o login permanece válido.
  "isn't available yet in your country" vira `unavailable` com a mensagem
  original no painel.
- **Modelos.** `meta/auto` = modo atualmente selecionado no site, sem alterá-lo
  (pode ser o último modo escolhido, pois o site o memoriza). Modos
  explícitos são anunciados apenas a partir do menu da conta e somente se o ID
  casar com `think_[a-z0-9_]+` e a opção não estiver desabilitada. Mídia,
  canvas e agentes ficam de fora. A seleção é conferida reabrindo o menu
  (`aria-checked="true"`); se falhar, retorna 400 sem enviar.
  `contextLength: 0` (origem `unknown`) e sem `max_output_tokens`.
- **API.** Somente texto; `reasoning_effort` diferente de `none` é rejeitado
  (use `meta/think_hard` quando anunciado). Ferramentas usam o serializador e o
  parser compartilhados.

## Camadas registradas

`ProviderId`, `catalog.ts`/`registry.ts`, perfil `META_PROFILE_DIR`
(`meta_profile`, ignorado no Git e Docker), `scripts/test.js`, banco
(`providers`, `ensureAccounts`, migração 6 que cria a conta `meta` de cada
usuário), provisionamento, gateway (nome "Meta AI", confirmação manual),
`public/panel.js`, `api-error.ts` (orientação de login com Facebook/Instagram/
conta Meta), `generation-guard.ts`, `browser-logging.ts`, `routes/chat.ts`,
`index.ts`, `openapi.ts`, `deploy/restore-profile.sh` e ACL do Squid
(`.meta.ai auth.meta.com .facebook.com .fbcdn.net .instagram.com`).

**Migração:** a etapa 5 recriava a restrição `provider IN (...)` com uma lista
fixa a cada inicialização, o que falharia assim que existisse uma conta `meta`.
A lista agora é gerada a partir da constante `providers` em `database.ts`;
cada provedor novo só precisa acrescentar seu ID ali e sua inserção de contas.
Ao mesclar os branches de provedores, combine as listas e numere as etapas de
inserção sem colisão (este branch usa a versão 6).

## Verificação executada

- Inspeção pública e estática descrita acima.
- `src/meta.test.ts` (6 testes): classificação da página a partir do HTML de
  visitante capturado e do diálogo real, estados da resposta, limites, região,
  login expirado, filtro de modos, captura escopada da área de transferência,
  leitor de turnos que ignora mensagens anteriores, e um frontend simulado com
  editor `contenteditable`, menu de modos, envio habilitado após digitar,
  `INIT → STREAMING → DONE`, cópia do texto-fonte com `<tool_call>`, fallback
  renderizado, rota `/v1` com histórico de ferramenta (normal e SSE),
  cancelamento sem consumir o corpo (clica em parar e libera a fila), limite
  de uso e confirmação manual antecipada/bem-sucedida.
- Testes compartilhados ajustados: `production.test.ts` (quatro provedores por
  usuário, roteamento de `meta/auto` para a conta certa) e
  `provider-migration.test.ts` (migração repetida com a conta `meta`).
- Resultados de `npm run build` e `npm test`: ver o fim deste documento.

## Pendências que exigem conta real

1. Confirmar no navegador autenticado todos os seletores acima (extraídos de
   bundles, não vistos renderizados): `user-menu-button`, `composer-input`,
   `composer-send-button`, `composer-stop-button`, menu de modos,
   `assistant-message` e o botão "Copy response" (inclusive se aparece só ao
   passar o mouse e o texto em pt-BR).
2. Login pelo painel com Facebook, Instagram e e-mail; checar se o Squid
   precisa de outros destinos (ex.: `static.cdninstagram.com`, `m.facebook.com`,
   checkpoints de 2FA) e se `auth.meta.com` exige outros hosts `*.meta.com`.
3. Envio real de texto normal e SSE com `scripts/smoke-meta.ts` (`DSP_API_KEY`
   ou `.cache/meta/api-key.txt`); medir duração e confirmar que o texto
   copiado é o markdown bruto.
4. Ciclo completo de ferramenta do guia (chamada obrigatória com SSE,
   execução pelo cliente, continuação com `tool_choice: "none"`).
5. Cancelamento real (botão Stop) e liberação da fila; reinício do worker com a
   sessão preservada; expiração da sessão.
6. IDs e rótulos reais dos modos da conta e o comportamento de `meta/auto`
   após usar `meta/think_hard`.
7. Mensagens reais de limite e de indisponibilidade regional (a conta pode
   estar autenticada e o produto indisponível no país).
8. Prompts longos no editor Lexical (limite de tamanho, quebras de linha).

## Resultados de build e testes (2026-11-06)

- `npm run build`: passou.
- `node scripts/test.js src/meta.test.ts`: 6/6 aprovados.
- `node scripts/test.js src/provider-migration.test.ts src/production.test.ts src/production-ui.test.ts`: 19/19 aprovados.
- `npm test` completo (três execuções): 124 aprovados, 2 ignorados; o teste
  `browser diagnostics distinguish login, suspension…` (`src/diagnostic-flow.test.ts`,
  fluxo DeepSeek, limite de 30 s) excedeu o tempo nas execuções completas, com
  a máquina abrindo vários Chromium em paralelo. Isolado,
  `node scripts/test.js src/browser-logging.test.ts src/diagnostic-flow.test.ts`
  passou 7/7 (19,4 s nesse teste). O teste não usa o provedor `meta`.
  A mesma falha ocorreu numa execução completa **sem** `src/meta.test.ts`
  (118 aprovados, 2 ignorados, 1 tempo excedido), o que indica carga da
  máquina, não regressão desta integração.
