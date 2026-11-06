# Integração Baidu Ernie Bot (文心助手)

Registro da integração do provedor `ernie` (modelos `ernie/<id-original>`),
feita em 2026-11-06 seguindo o [guia de novos provedores](guia-novos-provedores.md).

**Estado: parcial.** O adaptador, o login pelo painel e o registro em todas as
camadas estão implementados e cobertos por testes com HTML/SSE simulados a
partir de capturas reais. **Nenhum envio autenticado foi feito**: não havia
conta Baidu disponível e a tarefa proibia login. O envio real e o ciclo de
ferramenta continuam pendentes (ver [Pendências](#pendências-que-exigem-conta-real)).

## URL escolhida

| Candidata | Resultado observado (2026-11-06, headless, sem login) |
| --- | --- |
| `https://yiyan.baidu.com/` | HTTP 302 para `https://wenxin.baidu.com/?enter_type=yiyan_site`. |
| `https://ernie.baidu.com/` | Site institucional do modelo (`/zh/`): notícias ERNIE 5.5 Flash Base / 5.1, links de API (Qianfan) e Hugging Face. Não tem chat. |
| `https://wenxin.baidu.com/` | **Chat atual** — título “百度文心助手 - 办公学习一站解决”, compositor e histórico. |

O adaptador usa `https://wenxin.baidu.com/` como origem. A API de conversa fica
em outro host: `POST https://chat.baidu.com/aichat/api/conversation` (CORS com
credenciais; o frontend tem `https://chat-ws.baidu.com/aichat/api/conversation`
como URL de contingência).

## Elementos identificados

Capturas sanitizadas ficam em `.cache/ernie/` (fora do Git): HTML inicial e
hidratado, capturas de tela, rede e bundles públicos de `ms.bdstatic.com`.
A interface é em chinês e quase não tem `aria-label`; os IDs e `data-testid`
abaixo são os ganchos mais estáveis observados.

| Função | Seletor / sinal | Verificado |
| --- | --- | --- |
| Campo | `#chat-textarea` (`textarea.ci-textarea`, `maxlength="20000"`, dentro de `#ci-main`) | Sim (preenchido e enviado como visitante) |
| Enviar | `#ci-main .ci-submit-button:has(#ci-submit-button-ai)` (um `span` com `img`, sem papel/rótulo). Enter também envia | Sim (clique e Enter) |
| Parar | O mesmo `span` passa a conter `img.ci-submit-pause` durante a geração | Sim (presença); clique não testado |
| Modo | `button[data-testid="chat-mode-selector"]` abre `[role=menu][aria-label="选择回答模式"]` com `menuitemradio[data-chat-mode="fast"]` (对话) e `task` (工作任务) | Sim |
| Modelo | `[data-testid="chat-mode-model-row"]` abre `[role=menu][aria-label="选择模型"]` com `button[role=menuitemradio][data-model-name]` e `aria-checked` | Sim (visitante) |
| Resposta | Após o envio a URL muda para `/search/<id>?enter_type=chat_url`; o texto é renderizado em blocos markdown. O adaptador lê a resposta da rede, não do DOM | Sim |
| Logout | `.chat-aside-user-mask.unlogin` (“请登录”), botão “登录” no topo e “登录同步历史对话” | Sim |
| Login | `<script name="aiTabFrameBaseData">` no HTML de `/` contém `userInfo.isUserLogin` (`0` para visitante) | Só o valor de visitante |
| Desafio | Redirecionamento para `wappass.baidu.com/static/captcha/tuxing_v2.html` (“百度安全验证”, girar imagem) | Sim, após o 2º envio como visitante |

Modelos no menu (visitante): `smartMode` (“自动”, padrão) e `ERINE-5.1`
(“文心 5.1”; a grafia `ERINE` é a do site). São anunciados como
`ernie/smartMode` e `ernie/ERINE-5.1` somente quando aparecem no menu da conta;
sem menu, só `ernie/smartMode`. `ernie/smartMode` significa a seleção automática
do site, sem garantia do modelo subjacente (a captura mostrou
`answer_model: SEARCH_LIGHTNING` em `speedInfo`). Contexto desconhecido:
`contextLength: 0`, sem `max_output_tokens`.

### Protocolo da conversa

Requisição (sanitizada) enviada pelo frontend:

```json
{"message":{"inputMethod":"chat_search","query":[{"type":"TEXT","data":{"text":{"query":"<prompt>","extData":"{}"}}}],
  "searchInfo":{"usedModel":{"modelName":"smartMode","modelFunction":{"deepSearch":"0","thinkMode":"0"}},"capsuleSelectMode":"fast",
  "chatParams":{"chat_token":"<gerado pelo frontend>"}},"anti_ext":{"...":"..."}},"setype":"csaitab","rank":1}
```

Cabeçalhos relevantes: `X-Chat-Message` (query truncada, `anti_ext`, `modelName`),
`accept: text/event-stream`. Como há `chat_token` e `anti_ext` gerados pelo
frontend, o adaptador **não** monta a requisição: ele opera o compositor e
captura a resposta da requisição correspondente (padrão ChatGPT).

Resposta `text/event-stream` (observada):

```text
event:basedata   {"status":0,"user":{"isUserLogin":false,...},"lid":"…","chatHitKunlun":""}
event:ping
event:message    {"status":0,"data":{"message":{"metaData":{"state":"waiting-resp","endTurn":false},…}},"seq_id":0}
event:message    … generator.component "thinkingSteps" (reasoningContentArr, noReasoning:true)
event:message    … generator.component "markdown-yiyan", data.value "收到"   ← texto da resposta
event:message    … state "generate-complete", endTurn false                    ← fim do texto
event:message    … component "questionClosely" (sugestões de continuação)
event:message    … state "generate-complete", endTurn true                     ← fim do turno
```

Decisões do decoder (`src/providers/ernie-protocol.ts`):

- Texto: `generator.data.value` de `markdown-yiyan` (e `ai-markdown`/`markdown`,
  vistos no bundle), tratado como **delta**. O bundle acumula esses pacotes com
  `content += data.content`; a captura real tinha um só pacote de texto.
- Raciocínio: só de `thinkingSteps` quando `noReasoning !== true`, tratado como
  snapshot do array (não verificado com o modelo de raciocínio).
- Conclusão: `state === "generate-complete"` com `endTurn === true`; sem texto,
  é erro. Sugestões (`questionClosely`), referências e passos de busca são ignorados.
- `status !== 0` é erro. Observado: `status: 1005` com `hints.parts[].type = "kunlunHint"`
  (“抱歉，出了点小问题，请稍后重试”) junto de `chatHitKunlun: "kunlun_popup"`,
  seguido do desafio 百度安全验证. `1004` (tópico apagado) também é erro.
- `basedata.user.isUserLogin` falso durante a geração indica sessão expirada (401).
- Eventos `reconnect`/`task` (retomada por checkpoint, tarefas longas) não são suportados.

## Implementação

- `src/providers/ernie.ts`: adaptador no contrato de `types.ts`, mesmo ciclo do
  ChatGPT (`InteractiveBrowser`, `finishLogin`, `GenerationGuard`, pausas,
  exclusividade da página, cancelamento pelo botão de parar e pela captura).
  A cada geração abre `https://wenxin.baidu.com/`, garante o modo 对话, seleciona
  o modelo pelo menu, preenche `#chat-textarea` e clica em enviar com `noWaitAfter`.
- `src/providers/ernie-browser.ts`: script de inicialização que intercepta só o
  `POST https://*.baidu.com/aichat/api/conversation` cujo `message.query[].data.text.query`
  corresponde ao prompt ativo (espaços normalizados só na comparação) e exige
  `usedModel.modelName` igual ao solicitado; caso contrário, erro de modelo.
- Validação do login: `fetch('/')` dentro do navegador e leitura de
  `aiTabFrameBaseData.userInfo.isUserLogin`; só o booleano sai do Chromium.
  Redirecionamento para `wappass`/`passport` vira estado `unavailable` (503).
- Prompt maior que 20.000 caracteres (limite `maxlength` do campo) é rejeitado
  com 413 antes de tocar o site, para nunca enviar texto truncado. O orçamento
  compartilhado tem mínimo de 8.000 tokens (28.000 caracteres), por isso o
  limite não foi expresso como `contextLength`.
- Somente texto: conteúdo não textual e `reasoning_effort` diferente de `none`
  são recusados na API (`src/routes/chat.ts`).

### Camadas registradas

`types.ts`, `catalog.ts`, `registry.ts`, `session-store.ts` (`ERNIE_PROFILE_DIR`,
padrão `ernie_profile`), `generation-guard.ts`, `browser-logging.ts`,
`api-error.ts` (ajuda `https://wenxin.baidu.com/`, conta Baidu, Concluir login),
`index.ts` (sem `max_output_tokens` inventado), `routes/chat.ts`, `openapi.ts`,
`production/database.ts` (restrição com `ernie` e migração 6, que cria a conta
para usuários existentes; `ensureAccounts` para novos), `provisioner.ts`,
`gateway.ts` (nome “Ernie” e `manualLoginConfirmation`), `public/panel.js`
(botão Concluir login), `deploy/restore-profile.sh`, `deploy/squid.conf`,
`deploy/README.md`, `.gitignore`, `.dockerignore`, `.env.example`,
`scripts/test.js` e `scripts/smoke-ernie.ts`.

Observações para a mesclagem com outros provedores: as migrações são
reexecutadas a cada início, então a restrição `provider_accounts_provider_check`
da migração 5 precisa listar todos os provedores; o número de migração (6)
pode colidir com outros ramos. `production.test.ts` passou a usar
`maxWorkers: 6` para comportar o worker extra.

O egress libera `.baidu.com`, `ms.bdstatic.com`, `psstatic.cdn.bcebos.com` e
`aisearch.cdn.bcebos.com` (observados). `.baidu.com` é amplo, mas cobre chat,
API, passport, desafio (`wappass`, `hector`) e imagens (`gips*`). Hosts de
assets do passport não foram observados (não houve login) e podem faltar.
As fontes CJK vêm de `npx playwright install --with-deps` (inclui
`fonts-wqy-zenhei`), usado na imagem do worker — não verificado na imagem.

## O que foi verificado de fato

- Inspeção sem credenciais (headless, `zh-CN`): redirecionamento de `yiyan`,
  HTML do compositor, menu de modo/modelo, troca envio → parar, URL após envio.
- Um envio como visitante (“你好，请只回复两个字：收到”) com SSE completo
  capturado; um segundo envio recebeu `status 1005` (kunlun) e a página foi
  levada ao desafio 百度安全验证. O desafio não foi resolvido nem contornado e
  não houve outra tentativa.
- Login: só a página inicial e o estado de visitante. O formulário do passport
  não foi aberto (o desafio apareceu antes).
- Testes automatizados: `src/ernie.test.ts` (7 testes: catálogo/login/erros,
  SSE com deltas/CRLF/Unicode fragmentado, falhas explícitas, ferramentas pelo
  parser comum, captura no navegador com correlação e modelo, frontend simulado
  com login/menu/geração/ferramentas/cancelamento/expiração, confirmação manual)
  e ajustes em `production.test.ts` e `provider-migration.test.ts`.

## Pendências que exigem conta real

- [ ] Login Baidu pela tela remota (passport: SMS com telefone chinês, QR code
  pelo app Baidu ou senha; possíveis captchas) e confirmação de que
  `isUserLogin` passa a `1`/`true` no HTML e no `basedata`.
- [ ] Persistência da sessão no perfil após fechar o navegador humano
  (cookies `BDUSS`/`STOKEN` esperados — não verificado).
- [ ] Modelos do menu para conta autenticada (podem existir mais que os dois vistos).
- [ ] Envio real autenticado, resposta longa com vários pacotes `markdown-yiyan`
  (confirmar delta x snapshot), clique em parar e frequência do desafio
  百度安全验证/kunlun em conta logada.
- [ ] Ciclo completo de ferramenta pelo worker e pelo gateway `/v1` (seção 6 do guia).
- [ ] Hosts adicionais do egress para o passport; `squid -k parse` na imagem.
- [ ] Limites de uso da conta e mensagens correspondentes (nenhum aviso de limite observado).

## Checklist

- [x] Inspeção do HTML e da rede **sem login** (compositor, envio, parada, modelos)
- [ ] Inspeção autenticada
- [x] Adaptador em `src/providers/ernie*.ts`, seguindo `src/providers/types.ts`
- [x] `ProviderId` registrado em `types.ts`, `catalog.ts` e `registry.ts`
- [x] Painel, provisionamento, migrações e backup
- [x] Testes em `src/ernie.test.ts`, incluindo ferramentas pelo parser comum
- [ ] Envio real autenticado e ciclo completo de ferramenta pelo worker
- [x] Documentação (este arquivo)
