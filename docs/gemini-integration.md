# Integração Google Gemini web — 2026-11-06

Provedor `gemini`, chat em `https://gemini.google.com/app`, modelos expostos
como `gemini/<id>`. O adaptador, o login manual pelo painel, o registro em todas
as camadas e os testes controlados estão implementados. **Nenhuma conta Google
real foi usada**: o envio autenticado, o catálogo de uma conta e o ciclo de
ferramenta com o site real continuam pendentes (ver o roteiro no fim).

## O que foi inspecionado de fato

Inspeção em 2026-11-06 com Playwright (`playwright-extra` + stealth do projeto),
navegador headless, idioma pt-BR, **sem credenciais e sem login**. O build
observado do frontend é `boq_gemini-web-uiserver_20261105.12_p0`. Nenhum
desafio anti-bot apareceu. As capturas sanitizadas ficam em `.cache/gemini/`
(fora do Git): HTML inicial e hidratado, inventário de controles, menu de modos,
requisições de rede, captura do botão Copiar e screenshots.

O Gemini permite conversar **sem login** (modo visitante, só o modo
"3.5 Flash Lite" liberado). Para observar o compositor, a conclusão e o
transporte, foram enviados três prompts curtos e inofensivos como visitante.
Isso não envolve conta, senha nem contorno de proteção; o login Google não foi
tentado.

### Compositor e controles (verificado, visitante)

| Elemento | Seletor usado | Observação |
| --- | --- | --- |
| Campo | `rich-textarea [contenteditable="true"][role="textbox"]` | Editor Quill (`div.ql-editor`), `aria-label="Insira um comando para o Gemini"`; o placeholder visível é "Digite @ para acessar conectores…". |
| Enviar | `button[aria-label="Enviar mensagem"]` (fallbacks `Send message`, `button.send-button`) | Só aparece depois que o campo tem texto. |
| Parar | `button[aria-label="Parar resposta"]` (fallback `Stop response`) | Visível durante a geração, no lugar do envio. |
| Seletor de modo | `[data-test-id="bard-mode-menu-button"]` | `aria-label="Abrir seletor de modo. No momento: Flash-Lite"`. |
| Itens de modo | `gem-menu-item[role="menuitemradio"]` | `.label` com o nome, `aria-checked`, `aria-disabled="true"` e cadeado quando bloqueado; `data-mode-id`/`data-test-id="bard-mode-option-<hash>"` só nos liberados. |
| Turno do usuário | `user-query` | `innerText` começa com "Você disse" e quebra o prompt em parágrafos. |
| Resposta | `model-response` → `message-content .markdown` | `aria-busy="true"` enquanto renderiza, `aria-live="polite"`. |
| Ações da resposta | `message-actions copy-button button[aria-label="Copiar"]` | Tooltip "Copiar resposta"; existe também "Copiar o código" dentro de blocos de código (não usado). |
| Visitante | botão "Fazer login", `[data-test-id="signed-out-disclaimer"]`, `[data-test-id="sidenav-error-message"]`, `[data-test-id="mode-picker-sign-in-button"]`, link `accounts.google.com/ServiceLogin?...continue=https://gemini.google.com/app` | Confirmados. |

Sequência observada após o clique em Enviar: o botão Parar aparece; a URL muda
de `/app` para `/app/<id>`; surgem `user-query` e `model-response`; o botão Parar
some enquanto o markdown ainda está `aria-busy="true"`; por fim `aria-busy`
passa a `false` e `message-actions` (Refazer, Copiar, mais opções) é renderizado.

### Transporte (verificado, visitante)

O envio do visitante **não** usou o endpoint documentado por bibliotecas
não oficiais (`/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`).
O prompt seguiu por **WebChannel** em
`https://geminiweb-pa.clients6.google.com/v1/processSession` (`VER=8`,
`gsessionid`, `SID`, `RID`, `AID`, canal de retorno `GET ...TYPE=xmlhttp`),
com `req0___data__` em **protobuf binário codificado em base64**. As demais
chamadas são `/_/BardChatUi/data/batchexecute` (RPCs `rpcids=...`, com os
cabeçalhos `x-same-domain`, `x-goog-ext-525001261-jspb` e `x-goog-ext-73010989-jspb`)
e telemetria (`play.google.com/log`, Google Analytics, DoubleClick).

Decodificar protobuf sem esquema seria frágil e não foi feito. Por isso o
adaptador **não intercepta a rede**: ele opera o compositor e, ao concluir,
aciona o botão **Copiar** da própria resposta. Um script instalado antes do
frontend (`installGeminiCopyCapture`) intercepta `navigator.clipboard.write`/
`writeText` (e o evento `copy`) **somente enquanto a captura está armada** e
guarda o `text/plain`. Na inspeção, esse texto era o **Markdown bruto**:
`**negrito** e *ita*`, `<tool_call>{...}</tool_call>` intacto e o bloco
```` ```js ```` com cercas. O `innerText` do DOM perdia ênfases e cercas
de código, por isso não é usado como resposta.

### Autenticação

- **Verificado (visitante):** `/app` responde 200 com o compositor, mas o HTML
  contém o link `accounts.google.com/ServiceLogin` e `WIZ_global_data` **não**
  tem a chave `SNlM0e`. Um editor visível, portanto, não prova login.
- **Não verificado (conta real):** com sessão válida, espera-se `SNlM0e` não vazio
  em `WIZ_global_data` (comportamento documentado por clientes não oficiais) e o
  menu da conta apontando para `accounts.google.com/SignOutOptions`, sem o link
  `ServiceLogin`.

`validate()` executa no navegador um `fetch('/app')` com os cookies do perfil e
devolve ao Node apenas booleanos (`token`, `signInLink`, `accountLink`,
status e se a resposta saiu da origem). Autenticado = HTTP 200, mesma origem,
sem `ServiceLogin` e com `SNlM0e` ou `SignOutOptions`. Se o Google renomear
esses marcadores, o resultado falha fechado (`login_required`) — ajustar
`geminiAuthenticated` com a evidência real. A verificação periódica de status
ocorre no máximo a cada 60 s, porque baixa o HTML de `/app` (~850 KB).

## Decisões de implementação

- Arquivos: `src/providers/gemini.ts` (adaptador), `gemini-browser.ts`
  (seletores, captura do Copiar e leitura do estado do DOM, autocontidos para
  rodar no Chromium) e `gemini-protocol.ts` (regras puras: autenticação,
  catálogo, correlação, limite e erros).
- **Login manual com confirmação** (`manualLoginConfirmation`), como ChatGPT:
  o card abre `https://gemini.google.com/app` no navegador remoto; a pessoa
  clica em "Fazer login" e conclui senha, 2FA e verificação de dispositivo em
  `accounts.google.com`; depois clica em **Concluir login**. O navegador humano
  é fechado, o de automação abre o mesmo perfil sem restaurar snapshot antigo,
  valida e salva a sessão. Confirmação antecipada é recusada e reabre o login.
  O navegador humano é o Chromium sem flags de automação; o Google pode, ainda
  assim, recusar o login ("navegador não seguro") — **não verificado**.
- **Modelos:** `gemini/auto` mantém o modo atualmente selecionado no site (o
  padrão de uma conta nova); não promete um modelo específico. Os demais IDs
  vêm do menu real: o nome do item (por exemplo "3.5 Flash Lite") vira
  `gemini/3.5-flash-lite`. Itens bloqueados (`aria-disabled="true"`) não são
  anunciados; pedir um modo bloqueado ou inexistente falha com 400 **antes** de
  enviar o prompt. Contexto `0`/`unknown`; sem `max_output_tokens` inventado.
  Observação: o modo escolhido parece persistir no site, então `gemini/auto`
  depois de um pedido explícito usa o último modo selecionado.
- **Geração:** posse do `GenerationGuard` e da página do início ao fim; abre
  `/app` (conversa nova), espera o editor, seleciona o modo, preenche, clica em
  Enviar com `noWaitAfter` e passa a observar o DOM. O turno é correlacionado
  pelo `user-query` (comparação normalizada dos primeiros 200 caracteres); outro
  turno resulta em 502 sem reenvio. Conclusão = botão Parar ausente, markdown sem
  `aria-busy="true"` e botão Copiar visível em duas leituras seguidas. Prazo de
  60 s para a resposta começar e 180 s no total.
- **Streaming:** como a resposta só é obtida em Markdown fiel ao final, o
  adaptador emite **um único evento de conteúdo** seguido de `finish`. Clientes
  com `stream: true` recebem SSE válido, mas sem deltas incrementais.
- **Cancelamento:** aborta a leitura, clica em Parar se visível, desarma a
  captura e libera a fila, inclusive quando o cliente não consome o corpo.
- **Limite de uso (não verificado):** só textos fora do markdown da resposta
  (`[role="alert"]`, `mat-snack-bar-container`, `simple-snack-bar` e elementos
  `*error*` do turno) são comparados com padrões como "atingiu o limite"/"usage
  limit". Resultado: 429, adiamento ≥ 60 s e login preservado. O texto real do
  aviso do Gemini precisa ser confirmado numa conta que atinja o limite.
- Perda de login durante a geração (página sai de `gemini.google.com`) → 401 e
  bloqueio `login_required` até novo login pelo painel.
- Somente texto: mensagens com imagem/arquivo e `reasoning_effort` diferente de
  `none` são rejeitados com 400 na rota `/v1/chat/completions`. Raciocínio
  privado ("thinking") não é exposto.
- Ferramentas usam o serializador e o parser compartilhados (`<tool_call>`), sem
  alteração do protocolo.

## Camadas registradas

`ProviderId`, `isProviderId`/`providerIdForModel`, registro; perfil
`GEMINI_PROFILE_DIR` (padrão `gemini_profile`, `PROVIDER_PROFILE_DIR` tem
precedência) em `session-store`, `.gitignore`, `.dockerignore`, `.env.example`
e `scripts/test.js`; banco (`providers`, `ensureAccounts`, migração 6 que cria
uma conta `gemini` por usuário); a restrição `provider_accounts_provider_check`
da migração 5 passou a ser gerada a partir da lista `providers` — sem isso,
a reexecução da migração 5 a cada início recusaria linhas `gemini`.
Provisionador (provedor aceito), gateway (nome "Gemini", confirmação manual),
painel (`public/panel.js` e texto de ajuda), `restore-profile.sh`, mensagens de
erro com link e ação (`api-error.ts`), nomes no `generation-guard`, registro de
logs do navegador, `/v1/models` sem `max_output_tokens` inventado, OpenAPI e
validação de entrada em `routes/chat.ts`. A página `/` de status é genérica e
não precisou de alteração.

**Rede/egress:** os hosts necessários observados (`gemini.google.com`,
`geminiweb-pa.clients6.google.com`, `accounts.google.com`, `gemini.gstatic.com`,
`www.gstatic.com`, `fonts.gstatic.com`, `lh3.googleusercontent.com`) já são
cobertos pela ACL existente (`.google.com`, `.gstatic.com`,
`.googleusercontent.com`), por isso `deploy/squid.conf` não mudou. O login
Google pode precisar de `accounts.youtube.com` ou domínios regionais
(`accounts.google.com.br`) para gravar cookies — **não observado**; acrescentar
somente se o login real falhar por bloqueio do proxy. Telemetria
(Analytics/DoubleClick/Tag Manager) não é necessária.

## Testes

`src/gemini.test.ts` usa HTML e sequências reproduzidas das capturas:

- regras puras: rota, slugs do menu capturado (só o modo liberado é anunciado),
  evidência de login (visitante recusado), correlação com o prefixo "Você
  disse", aviso de limite e diretório de perfil;
- captura do Copiar: só a cópia armada é retida; fora disso o clipboard do site
  funciona normalmente;
- frontend simulado: editor Quill-like, envio que só aparece após digitar,
  Parar, `aria-busy`, ações da resposta e cópia via `ClipboardItem`; cobre
  login, catálogo, `gemini/auto`, modo explícito, modo bloqueado sem envio,
  ferramentas via `/v1/chat/completions` (com e sem streaming, prompt serializado
  com `Tools:`), rejeição de imagem e `reasoning_effort`, cancelamento sem
  consumir o corpo, turno divergente sem reenvio, limite com login preservado e
  expiração;
- confirmação manual antecipada recusada (com o compositor de visitante na
  página) e confirmação bem-sucedida salvando o perfil.

Testes compartilhados ajustados: `production.test.ts` (quatro contas por
usuário e roteamento de `gemini/auto`), `provider-migration.test.ts` (conta
`gemini` criada e migração repetida) e `production-ui.test.ts` (card Gemini com
**Concluir login** mesmo em snapshot sem a capacidade).

Resultados no worktree: ver a seção "Resultados" abaixo.

## Pendências que exigem conta real

1. Login Google pelo navegador remoto (senha, 2FA, dispositivo) e aceitação
   do navegador pelo Google; se necessário, liberar destinos adicionais no egress.
2. Confirmar os marcadores de sessão (`SNlM0e`, `SignOutOptions`, ausência de
   `ServiceLogin`) e a detecção de expiração.
3. Menu de modos de uma conta (Free e paga): nomes, itens liberados e se a
   seleção persiste entre conversas.
4. Envio autenticado: se o transporte continua o mesmo, se o editor aceita
   prompts longos do serializador sem convertê-los em anexo e se o botão
   Copiar devolve o Markdown completo também em respostas longas e com
   "thinking".
5. Texto e local real do aviso de limite de uso.
6. Ciclo de ferramenta real (chamada, execução no cliente e continuação com o
   resultado), pelo worker e pelo gateway com chave `dsp_`:
   `npx tsx scripts/smoke-gemini.ts` cobre texto normal e SSE.

## Resultados

- `npm run build`: aprovado.
- `node scripts/test.js src/gemini.test.ts`: 4 testes aprovados.
- `npm test`: 126 testes — 122 aprovados, 2 ignorados, 1 falha e 1 cancelado,
  ambos em `src/diagnostic-flow.test.ts` (teste de navegador do DeepSeek que
  estoura o limite fixo de 30 s; o cancelado é o `after` com `EBUSY` no
  `lockfile` do perfil temporário). O mesmo teste falha igualmente no commit
  base `bb3ecff` nesta máquina (verificado com as alterações guardadas em
  stash), sob a carga de vários navegadores em paralelo; não está relacionado
  ao Gemini. Os testes de produção, migração, painel e Gemini passaram.
- `production.test.ts` passou a usar `maxWorkers: 6`, porque o cenário agora
  inicia também o worker da conta Gemini.
