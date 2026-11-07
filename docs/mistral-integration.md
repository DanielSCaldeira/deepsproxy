# Integração Mistral Vibe (antigo Le Chat) — 2026-11-06

Provedor `mistral`, chat em `https://chat.mistral.ai/chat`, modelos expostos como
`mistral/<modo>`. O site passou a se chamar **Vibe** (“Vibe (formerly Le Chat)”);
o título da página é “Vibe Chat”. Login em `auth.mistral.ai`, que redireciona para
`v2.auth.mistral.ai/login`: e-mail/senha, Apple, Google ou Microsoft.

**Estado:** adaptador, painel, provisionamento, migração, gateway, testes e
documentação implementados. **Nenhum login, envio real ou ciclo de ferramenta
foi executado com conta real.** Tudo o que depende de uma sessão autenticada
está marcado como pendente na última seção.

## O que foi inspecionado

Inspeção feita sem credenciais, com o Chromium do projeto (playwright-extra +
stealth, locale pt-BR, headless). Nada foi digitado, nenhum termo foi aceito e
nenhum desafio foi resolvido. Evidências locais (fora do Git) em `.cache/mistral/`:

| Arquivo | Conteúdo |
| --- | --- |
| `chat.html`, `chat.png`, `chat-dom.json` | HTML público de `/chat` (UUIDs e nonces removidos), captura de tela e resumo de controles |
| `composer-sanitized.html` | Formulário do compositor isolado, sem classes nem SVG |
| `network.json` | Requisições do carregamento público (sem corpo) |
| `auth-login.png`, `auth-login-dom.json` | Página de login (campos e botões, sem valores) |
| `bundles/` | Bundles JS públicos baixados pelo próprio navegador ao abrir `/chat` |

Ocorrência relevante: depois de alguns downloads paralelos com `curl`, o site
passou a responder com o desafio Cloudflare (“Um momento…”, HTTP 403 + Turnstile)
também para o navegador. A inspeção foi interrompida; nenhuma tentativa de
contornar o desafio foi feita. Cerca de 30 minutos depois uma visita normal voltou
a carregar o chat, e os bundles foram salvos a partir das respostas do navegador.
Isso mostra que o worker pode encontrar o desafio: o adaptador o reporta como
indisponibilidade (503), não como login expirado.

### HTML e controles (verificado no HTML público)

- Visitantes **podem conversar sem login**: o compositor existe para anônimos e o
  bundle incrementa um contador de mensagens anônimas. Um editor visível não
  prova autenticação.
- Compositor: `form` contendo `div[data-composer-editor="true"]` com um editor
  ProseMirror `div.ProseMirror[contenteditable="true"][data-placeholder="Ask anything"]`.
  Antes do editor há um `button[type="submit"][hidden]`.
- Botão de modo dentro do formulário: `button[type="button"]` com o texto `Fast`
  (o bundle também define `aria-label` com o título do modo atual).
- Visitante: botões `Sign in` e `Sign up` no cabeçalho, diálogo
  “Vibe Terms of Service” com `Accept and continue`.
- Payload RSC do Next.js (`self.__next_f`): para visitante, `"session":null` e
  `"anonymousUser":{...}`.

### Bundles (lido no código público, não exercitado com conta)

- Envio: `fetch("/api/chat", { method: "POST" })`, corpo JSON com `mode`
  (`create`, `start`, `append`, `edit`), `model`, `messageInput:
  [{ type: "text", text }]`, `clientPromptData`, `features` etc. Retomada em
  `/api/chat/resume`. Sem token no corpo; a autenticação é por cookie.
- Erros HTTP: `{ code, detail }`; 401 → autenticação; 429 → limite com
  `Retry-After`. Códigos internos incluem `CHAT_REQUEST_RATE_LIMITED`,
  `CHAT_MESSAGE_LIMIT_REACHED`, `QUOTA_*`.
- Stream da resposta: linhas `<código>:<payload>` separadas por `\n`, com
  sufixo opcional `__context__:<payload>`. Códigos < 15 são JSON; ≥ 15 usam
  superjson (`{"json": ...}`). Tabela: 0 text, 1 moderation, 2 references,
  3 canva, 4 canva_token, 5 tool_call, 6 error, 7 image, 8 done,
  9 references_ids, 10 file_reference, 11 widget, 12 reasoning,
  14 tool_reference, 15 state_update, 16 disclaimer.
- A interface **ignora** o código 0 e monta as mensagens a partir de
  `15` `state_update`: `bootstrap` (`chat`, `messages`, `canvas`) e `message`
  (`messageId`, `messageVersion`, `patches`). Os patches são RFC 6902 mais
  `append` (concatena em string existente; ignorado se o alvo não for string);
  caminho `""` ou `"/"` substitui a mensagem inteira. O texto visível vem de
  `contentChunks` do tipo `text`.
- Envio: `button[type="submit"]` com `aria-label` de
  `message_input.send_message_button` (“Send”; “Cannot send empty message” com o
  campo vazio). Parada: `button[type="button"]` com `aria-label="Stop generation"`.
- Modos: lista fixa `[{ value: "fast" }, { value: "think" }]`, títulos “Fast” e
  “Think” (descrições “Get answers fast”, “Handle complex tasks”), itens de um
  dropdown Radix (`menuitem`).
- Avisos de limite (i18n): “You have reached the quota for your current plan.”,
  “Login to unlock more messages and continue chatting.”, “This model is at full
  capacity right now”.

## Decisões de implementação

Arquivos: `src/providers/mistral.ts` (adaptador), `mistral-browser.ts`
(captura no navegador e inspeção da página) e `mistral-protocol.ts` (modos,
erros e decodificador). O padrão é o do ChatGPT: o próprio frontend monta e
envia a requisição; o adaptador opera o compositor e lê uma cópia da resposta.

- **Modelos:** `mistral/fast` e `mistral/think`, os valores originais do seletor
  de modo. Só são anunciados os modos presentes no menu da conta (ou o modo
  atual do botão). Sem o controle de modo, o catálogo fica vazio; não há
  fallback para IDs da API comercial (`mistral-large-latest` etc.). Contexto
  desconhecido: `contextLength: 0`, origem `unknown`, sem `max_output_tokens`.
- **Seleção de modo:** abre o botão de modo, clica no item cujo título
  corresponde e confere o modo exibido depois; se o site não aplicar, a chamada
  falha (400) em vez de usar outro modo. `reasoning_effort` diferente de `none`
  é recusado: use `mistral/think`. Só mensagens de texto são aceitas.
- **Login válido:** página em `chat.mistral.ai`, sem desafio, sem `"session":null`
  no payload RSC, sem botões `Sign in`/`Sign up` visíveis e com o editor visível.
  Visitante ou botão de login → `login_required` (401). Desafio Cloudflare →
  indisponível (503). Nenhum dado de sessão sai do navegador; a avaliação devolve
  apenas booleanos. Antes de cada geração o chat é recarregado em `/chat`, de modo
  que a expiração aparece no payload novo.
- **Termos de uso:** se o diálogo de termos estiver aberto, a geração falha com
  401 pedindo para aceitar na tela de login. O proxy nunca aceita termos sozinho.
- **Login pelo painel:** `manualLoginConfirmation` ativo. **Conectar** abre o
  Chromium humano do worker em `https://chat.mistral.ai/chat`; o usuário clica em
  Sign in, autentica em `auth.mistral.ai` e clica em **Concluir login**. O
  adaptador fecha o navegador humano, reabre a automação no mesmo perfil, valida
  e salva a sessão. Confirmação antecipada mantém o login aberto e mostra erro.
- **Envio:** foco no editor, preenchimento, clique em `Send` (aguarda até 5 s
  ficar habilitado) ou Enter no editor se o botão não aparecer. O clique usa
  `noWaitAfter`: a mudança para `/chat/<id>` não é tratada como conclusão.
  Mensagem já despachada nunca é reenviada automaticamente.
- **Captura:** instalada antes dos scripts do site, substitui `fetch` apenas para
  POST da mesma origem. Reivindica a resposta cujo corpo contém o prompt ativo
  (comparação com espaços normalizados) ou, se o prompt já foi visto numa
  mutação JSON anterior, a requisição seguinte para `/api/chat`. Telemetria
  (`/api/trpc/event.*`) e respostas JSON bem-sucedidas passam intactas. Corpo de
  erro é lido de forma limitada e só o código (`[A-Za-z_]`) é guardado.
- **Decodificador:** segue o formato do bundle (acima). Emite apenas texto de
  mensagens com `role: "assistant"`; ignora `thinking`, ferramentas internas,
  referências e o código 0. Código 6 → erro; 8 → fim; fim do corpo com texto
  também conclui, como no frontend. Texto revisado já transmitido, patch
  inválido, caminhos `__proto__`, linhas malformadas (HTML de desafio) ou
  resposta sem texto falham explicitamente.
- **Cancelamento:** aborta a requisição capturada e clica em `Stop generation`
  quando visível; a fila é liberada mesmo se o cliente não consumir a resposta.
- **Limites:** 429 ou códigos de limite → `rate_limited` com `Retry-After`
  (mínimo de 60 s), sem apagar o login. Se nenhuma requisição for capturada em
  30 s e a página mostrar aviso de cota/capacidade, o erro é 429; caso contrário,
  502 sem reenvio.

## Camadas alteradas

| Área | Alteração |
| --- | --- |
| Identidade | `ProviderId`, `isProviderId`, prefixo `mistral/` e factory do registro |
| Perfil | `MISTRAL_PROFILE_DIR` (padrão `mistral_profile`), `.gitignore`, `.dockerignore`, `.env.example`, `scripts/test.js` |
| Banco | `providers` inclui `mistral`; `ensureAccounts`; migração 6 cria uma conta Mistral por usuário |
| Provisionamento | `mistral` aceito; conta não reutiliza o ID legado do DeepSeek |
| Gateway/painel | Nome “Mistral”, confirmação manual, texto de ajuda e fallback em `public/panel.js` |
| API | Validação de texto/`reasoning_effort`, `max_output_tokens` omitido, descrição OpenAPI |
| Erros e logs | Nome, URL de ajuda e “Concluir login” em `api-error.ts`; mensagens do guard; provedor aceito nos logs do navegador |
| Restauração | `deploy/restore-profile.sh` aceita `mistral`; o backup já enumera todas as contas |
| Rede | Squid: `.mistral.ai` (chat, auth, v2.auth observados); `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com` para SSO (documentados, não observados). Google e `.challenges.cloudflare.com` já estavam liberados |

**Migração:** a restrição `provider_accounts_provider_check` é recriada a cada
execução pelo bloco da migração 5. Ela passou a ser gerada a partir da lista
`providers`; com a lista fixa antiga, a segunda execução do `migrate` falhava ao
encontrar contas Mistral. Ao mesclar outros provedores, basta acrescentar o ID
em `providers` e um bloco de inserção com versão própria (a numeração 6 pode
precisar de ajuste na mesclagem).

## Testes executados

`npm run build` passou. `src/mistral.test.ts` (9 testes, todos aprovados) cobre:

- catálogo, roteamento, rótulos do menu e argumentos do navegador de login;
- stream no formato do bundle: patches do assistente, mensagem do usuário e
  código 0 ignorados, Unicode e linhas fragmentados, CRLF, `__context__`,
  código desconhecido, `bootstrap`, `test`/`append`, fim pelo corpo;
- falhas: JSON inválido, revisão de texto, resposta vazia, HTML de desafio,
  `__proto__`, operação desconhecida, erro 6 e limite;
- ferramenta decodificada pelo parser compartilhado;
- inspeção de página: visitante, conta, diálogo de termos, desafio e cota;
- captura no navegador: telemetria ignorada, `/api/chat` sem prompt ignorado,
  mutação JSON com o prompt seguida de `/api/chat`, cancelamento real;
- frontend simulado a partir do HTML capturado: login, catálogo `fast`/`think`,
  troca de modo, envio por botão e por Enter, `/v1/models`, `/v1/chat/completions`
  normal e SSE com histórico de ferramenta (prompt serializado conferido),
  cancelamento sem consumo, 429 com prazo e login preservado, expiração;
- confirmação manual antecipada recusada e reaberta, sessão de visitante
  recusada, sucesso com sessão salva e reutilização do navegador.

Testes compartilhados ajustados: `production.test.ts` (quatro contas por
usuário, card “Mistral” com confirmação manual) e `provider-migration.test.ts`
(quatro contas, migração repetida). Os testes de ChatGPT, produção, painel,
migração e compatibilidade de ferramentas passaram junto com os de Mistral.

`npm test` completo: 131 testes, 127 aprovados, 2 ignorados, 1 falha e 1
cancelamento, ambos em `src/diagnostic-flow.test.ts` (DeepSeek, limite fixo de
30 s, com a máquina carregada por outras suítes em paralelo). A mesma falha
ocorreu na execução de referência antes das alterações; executado isoladamente,
o arquivo passou (3/3, 21,8 s).

Script opcional para o ambiente real: `npx tsx scripts/smoke-mistral.ts`
(usa `DSP_API_KEY` ou `.cache/mistral-api-key.txt`; exige `mistral/fast` em
`/v1/models`, envia uma mensagem normal e outra SSE e grava
`.cache/mistral-live-api-result.json`).

## Pendente de validação com conta real

Nada abaixo foi verificado:

1. Login pelo painel (e-mail/senha; Apple, Google e Microsoft no Chromium do
   worker) e se o egress precisa de outros domínios de SSO.
2. Critério de login: confirmar que a conta autenticada **não** tem
   `"session":null` no payload RSC nem botões `Sign in`/`Sign up`, e que a sessão
   expirada volta a mostrá-los após recarregar `/chat`.
3. Compositor autenticado: botão `Send` habilitado após preencher, Enter como
   alternativa, `Stop generation` durante a geração e ausência de diálogos
   (termos, novidades, onboarding) que bloqueiem o editor.
4. Menu de modos para contas Free/Pro (rótulos, `role` dos itens, eventual
   controle desabilitado) e se o campo `model` do `/api/chat` corresponde ao modo.
5. Formato real do stream autenticado: `role` nos patches do assistente,
   `contentChunks` de texto, presença de `8:` ao final e forma do erro `6:`.
6. Envio normal e SSE pelo worker e pelo gateway com chave `dsp_`.
7. Ciclo completo de ferramenta de IDE (chamada, execução pelo cliente,
   continuação com `role: "tool"`), conforme o roteiro do guia.
8. Mensagens de limite e cota reais (HTTP 429/códigos) e a indicação no painel.
9. Comportamento com o desafio Cloudflare no worker e com `/api/chat/resume`
   (retomada após queda de rede não é tratada; a geração falha sem reenvio).
# Atualização dos testes autenticados — 2026-11-06

O site redirecionou `/chat` para `/work` (Vibe Work). O compositor recolhido
mostra “Digite / para acesso rápido”; após o clique, o editor é
`.rich-text-editor.ProseMirror[contenteditable=true]`. O adaptador espera a
hidratação e repete apenas a abertura do editor quando o nó é substituído.
O botão do modelo usa aria-label “Selecionar modelo” e texto “Rápido”.

Foi observado envio real `POST /api/chat` com resposta `TESTE_CORRECAO_OK`.
Somente `contentChunks` do tipo `text` são encaminhados; o campo agregado
`content` pode misturar raciocínio interno e não serve como fallback. As
correções de hidratação e isolamento do texto possuem testes de regressão.
