# Proxy IA

Um único projeto para conectar contas DeepSeek, Qwen e ChatGPT a clientes compatíveis com
OpenAI. O painel multiusuário apresenta **Minhas contas**, com login, recuperação
e desconexão independentes para cada serviço. Cada usuário usa a mesma URL `/v1`
e chave `dsp_` nos aplicativos; o ID do modelo determina o provedor.

O [histórico do diagnóstico de login](docs/diagnostico-login-2026-11-05.md)
registra as alterações, o que funcionou, as tentativas que falharam, as
evidências dos testes e a validação real que ainda está pendente.

## APIs gratuitas

O painel também aceita chaves NVIDIA e OpenRouter, cifradas por usuário.
Somente endpoints gratuitos confirmados são anunciados e aceitos pelo servidor;
modelos pagos, plugins tarifados e fallback pago ficam bloqueados.
Veja [configuração, limites e testes](docs/apis-gratuitas.md).

## ChatGPT web

No painel **Minhas contas**, use o card **ChatGPT**, faça login manualmente na
tela remota e clique em **Concluir login**. O perfil e o worker são exclusivos
da conta. A autenticação e a geração com uma conta Free real ainda precisam
ser confirmadas no teste manual.

O modelo `chatgpt/auto` usa a seleção automática disponível no site. Outros IDs
`chatgpt/<id>` só são anunciados quando aparecem no catálogo da conta e podem
ser selecionados no menu. Consulte `GET /v1/models`; o catálogo da API OpenAI
não é usado como catálogo do site. A seleção específica não troca de modelo
silenciosamente.

A integração cobre texto, streaming e ferramentas executadas pelo cliente.
Arquivos, imagens, voz e controle de `reasoning_effort` não estão disponíveis.
A janela de contexto desconhecida é anunciada como `0`, com origem `unknown`;
o preparo do histórico usa o orçamento estimado compartilhado do proxy.
A contagem de tokens do proxy é uma estimativa, não uma medição do site.
Limites de uso preservam o login e adiam a geração.

No modo local, configure `PROVIDER=chatgpt` e, opcionalmente,
`CHATGPT_PROFILE_DIR`. O diretório padrão é `chatgpt_profile`;
`PROVIDER_PROFILE_DIR` tem precedência. O painel é o fluxo recomendado de login.

O [registro da integração](docs/chatgpt-integration.md) distingue os testes
controlados da validação real pendente e documenta o protocolo consultado.

## Meta AI web

No card **Meta AI**, entre na tela remota com Facebook, Instagram ou conta Meta
e clique em **Concluir login**. O uso anônimo do site não é aceito: o proxy
exige a conta autenticada. `meta/auto` mantém o modo selecionado no site;
`meta/think_*` só aparece quando o menu de modos da conta o oferece. A resposta
é entregue ao final da geração. No modo local, use `PROVIDER=meta` e,
opcionalmente, `META_PROFILE_DIR` (padrão `meta_profile`). Veja o
[registro da integração](docs/meta-integration.md) e as validações pendentes.

## Provedores e código compartilhado

As [correções e evidências da rodada de 2026-11-06](docs/provider-fixes-2026-11-06.md)
registram o que foi validado, os ajustes de sessão/transporte e as pendências
de autenticação ou disponibilidade dos sites.

Para testar todas as contas do laboratório local com chamadas reais, execute
`npx tsx scripts/smoke-all-providers.ts`. O executor consulta o catálogo de cada
conta e verifica texto, streaming, `tool_choice` e o ciclo de retorno de ferramenta
no mesmo contrato OpenAI utilizado pelo DeepSeek. Ele usa a sessão local de
`.cache/proxy-ia-live-session.json` ou as credenciais locais de
`.cache/proxy-ia-live-admin.json`, cria uma chave temporária e a revoga ao terminar.
As ferramentas de teste executam somente funções locais com dados controlados.

Os resultados ficam em `.cache/all-providers-live-result.json` e `.md`, distinguindo
aprovação, falha e bloqueio. Login pendente e falhas repetidas de transporte
bloqueiam os cenários dependentes sem interromper os outros sites. Os navegadores
de teste são liberados entre contas, preservando os perfis. Use
`DSP_TEST_PROVIDERS=chatgpt,qwen` para limitar os sites, `DSP_TEST_RESUME=1` para
retomar os resultados após uma interrupção e `DSP_API_BASE` para outro endereço local.
Uma interrupção forçada pode exigir revogar a chave temporária pelo painel.
Para repetir cenários bloqueados, combine `DSP_TEST_RESUME=1` com
`DSP_TEST_RETRY_BLOCKED=1`. Os filtros `DSP_TEST_CASES` (por exemplo,
`text,required`), `DSP_TEST_MODELS` (IDs separados por vírgulas) e
`DSP_TEST_STREAMS` (`json` ou `stream`) permitem uma rodada
direcionada. `DSP_TEST_CONTINUE_ON_502=1` permite sondar os demais modelos após
erros 502 repetidos; bloqueios de autenticação e limites de uso continuam
interrompendo os cenários dependentes.

Para adicionar outro site ao proxy, siga o [guia de novos provedores](docs/guia-novos-provedores.md).
O status de cada site planejado está no [roadmap de provedores](docs/roadmap-provedores.md).

Os adaptadores em `src/providers` cuidam somente da autenticação, transporte,
catálogo e decodificação próprios do serviço. Histórico, resumo, ferramentas,
emissão OpenAI/SSE, cancelamento e persistência de sessão são compartilhados.
Cada worker executa uma conta/provedor com perfil e rede exclusivos.

O suporte Qwen usa como referência somente o protocolo necessário do
[qwenproxy](https://github.com/pedrofariasx/qwenproxy/tree/e599886dfa2b199364e03c7bffd76ff746183972).
A atribuição ISC está em `src/providers/QWEN-NOTICE`. Esta integração cobre texto,
streaming e chamadas de ferramentas, sem importar o painel ou a gestão de
contas do projeto de referência. O cliente executa as ferramentas e devolve seus
resultados no histórico, como já ocorre no DeepSeek.

Os modelos DeepSeek mantêm seus IDs. Os modelos Qwen aparecem como
`qwen/<id-original>` após autenticar a conta e consultar seu catálogo. Consulte
`GET /v1/models` para obter os IDs disponíveis. Para Qwen, `reasoning_effort: none`
desativa o raciocínio (padrão); `low`, `medium`, `high`, `xhigh` e `max` ativam o
modo de pensamento. Essas opções são um controle de ativação, sem garantia de
intensidades distintas. O orçamento inicial de contexto Qwen é conservador e
limitado pelo catálogo quando ele informa uma janela menor.

No modo local, execute um provedor por processo. No PowerShell:

```powershell
# DeepSeek continua sendo o padrão.
$env:PROVIDER = 'qwen'
$env:PORT = '3001'
npm start
```

O perfil Qwen padrão é `qwen_profile`; `QWEN_PROFILE_DIR` permite alterá-lo.
`PROVIDER_PROFILE_DIR` tem precedência sobre os diretórios específicos.

O login das contas (DeepSeek e Qwen) acontece **dentro do painel**: rode
`make live`, abra http://localhost:3440, clique em **Conectar** no card do
serviço e entre na tela remota que abre no próprio site. No DeepSeek, conclua
o login manualmente e clique em **Concluir login** quando o chat estiver aberto.
O navegador de login roda no worker do servidor; sua sessão permanece no volume
privado da conta e é validada antes de liberar a API. A antiga janela externa
(`npm run login` / `make login`) foi removida.

O nome público e o pacote agora são Proxy IA / `proxy-ia`. Identificadores
operacionais `deepsproxy`, variáveis `DEEPSPROXY_*`, chaves `dsp_`, nomes das
imagens e IDs dos provedores já configurados foram preservados para manter as
instalações existentes. As seções abaixo descrevem principalmente o adaptador
DeepSeek e suas políticas atuais.

Para publicar com painel multiusuário, login remoto no DeepSeek e chaves
individuais, siga o [guia de produção](deploy/README.md). Cada usuário acompanha
o status da própria conta pelo site. O modo local abaixo continua disponível.

Proxy local compatível com a API OpenAI que roteia requisições para o DeepSeek via automação de navegador (Playwright). Esta é uma fork endurecida do projeto original com foco em concorrência, segurança e operabilidade.

[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.64-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## ✨ Recursos

- **OpenAI API compatible**: `/v1/chat/completions` (stream e non-stream) + `/v1/models`
- **Tool calling**: parser tolerante de `<tool_call>` em JSON/XML estilo Hermes e conversão de DSML do DeepSeek para `tool_calls`, em stream e non-stream
- **Entrada compacta**: preserva instruções e contexto útil do cliente, omite raciocínio anterior e envia catálogo de ferramentas em JSON compacto
- **Pausas internas aleatórias**: uma geração por vez, incluindo resumos e retries. Após conclusão, falha ou cancelamento, sorteia uma nova pausa uniforme de **15 a 30 segundos** antes da próxima geração. Ajuste `DEEPSPROXY_REQUEST_DELAY_MIN_MS` e `DEEPSPROXY_REQUEST_DELAY_MAX_MS` no `.env`. Além disso, cada ação de navegador aguarda **10 a 15 segundos**, configuráveis por `DEEPSPROXY_ACTION_DELAY_MIN_MS` e `DEEPSPROXY_ACTION_DELAY_MAX_MS`. Cada par pode ser desativado com ambos os valores em `0`. As pausas reduzem a frequência das ações; não garantem ausência de bloqueios pelo serviço.
- **Interrupção após bloqueios**: suspensão e login pendente interrompem tentativas e bloqueiam novos envios antes de navegação ou resumo. A pausa restante e o bloqueio persistem em `<profile>/.generation-state.json`. Para retomar, use **Conectar** ou **Reconectar conta** no card do serviço no painel e conclua a autenticação na tela remota; a data exibida pelo DeepSeek não dispara retomada automática. HTTP 429 respeita `Retry-After`, mesmo quando exige mais de 30 segundos. `/api/status` informa `deepseek.block`, `deepseek.nextAllowedAt`, `deepseek.busy` e `deepseek.queued`.
- **Controle de ferramentas**: respeita `tool_choice`; DSML inválido sem chamadas válidas retorna `invalid_tool_call` (HTTP 502 ou evento de erro SSE), sem executar comandos incompletos. A recuperação XML/Hermes existente permanece compatível.
- **Streaming SSE** correto, com extração de `reasoning_content` para modelos thinking
- **Resumo automático de contexto**: preserva decisões e pendências das mensagens antigas, mantém os turnos recentes e usa compressão como fallback
- **Cache de resumo em memória** por prefixo do histórico, com expiração e limite de tamanho; sem persistir conteúdo da conversa em disco
- **Telemetria de context window persistida** — descobre o limite real do modelo na primeira execução e relembra entre restarts
- **Concorrência segura**: mutex serializa o uso da página Playwright para múltiplas requests simultâneas
- **Fail-closed por padrão**: sem `API_KEY` o servidor faz bind apenas em `127.0.0.1` (e recusa subir se `BIND_HOST` for público)
- **Logs estruturados com sanitização** de headers sensíveis (`Authorization`, `Cookie`, PoW)

O resumo é acionado por padrão quando o prompt chega a 72% do limite detectado. O proxy faz uma chamada interna para resumir turnos antigos antes da resposta, preserva as mensagens `system` e mantém o turno recente completo. Se o resumo falhar, a compressão atual continua como fallback. O cache é volátil, limitado e expira após 30 minutos; o conteúdo da conversa não é salvo em disco. A troca de sessão no chat web é interna: para o usuário e para o cliente OpenAI-compatível, a conversa deve continuar sem aviso de nova sessão, preservando o resumo e os turnos recentes.

---

## 🏗️ Arquitetura

```
src/
├── index.ts                 # Bootstrap Hono + auth middleware + bind policy
├── routes/
│   ├── chat.ts              # Orquestração de retry/stream/non-stream
│   ├── serialization.ts     # OpenAI messages → prompt textual
│   ├── tool-parser.ts       # Parser <tool_call> (JSON e XML/parameter)
│   └── stream.ts            # Parse do stream DeepSeek → chunks OpenAI
├── services/
│   ├── playwright.ts        # BrowserContext + mutex + captura PoW
│   ├── deepseek.ts          # Cliente HTTP DeepSeek (headers de versão via env)
│   └── telemetry.ts         # Detecção/persistência do context window
├── tools/
│   ├── registry.ts, executor.ts, schema.ts, types.ts
├── runtime/
│   ├── engine.ts, types.ts  # State machine agentic loop
└── utils/
    ├── logger.ts            # Logger central com redactor de headers
    ├── mutex.ts             # Lock cooperativo simples
    ├── compression.ts       # Compressão/truncamento de fallback
    ├── context-summary.ts   # Resumo automático e cache temporário por prefixo
    ├── json.ts              # Parser JSON tolerante a respostas LLM
    └── types.ts             # Tipos OpenAI
```

---

## 🚀 Início rápido

```bash
git clone <repo>
cd deepsproxy
npm install
npx playwright install chromium

# Ambiente completo com painel e login das contas (http://localhost:3440)
make live

# Proxy local com a sessão já salva no perfil
PORT=3000 npm start
```

Abra `http://127.0.0.1:3000/` para consultar o status do servidor, a autenticação no DeepSeek e a sessão salva. A página atualiza automaticamente a cada 15 segundos. Se houver `API_KEY`, informe a chave na página para consultar os detalhes.

No painel (`make live` ou a instalação de produção), o navegador e a sessão ficam no servidor, em `/profile` no volume exclusivo de cada conta. No DeepSeek, o botão **Concluir login** encerra o navegador manual, abre a mesma sessão na API e só libera as chamadas após confirmar o acesso ao chat. Uma confirmação antecipada mantém o fluxo de login disponível. O computador de quem abre o painel pode ser diferente da máquina que executa os serviços.

O processo independente `npm start` usa seu próprio perfil, por padrão `deepseek_profile` dentro do projeto. Ele não compartilha automaticamente a sessão dos workers Docker. Preserve o perfil para reutilizar cookies, armazenamento local e IndexedDB após reiniciar. O provedor pode expirar ou revogar a sessão. A API reserva o perfil para evitar uso simultâneo; `PLAYWRIGHT_HEADLESS=false` mantém seu navegador local visível.

DeepSeek usa o Chromium padrão do Playwright, sem plugins que alterem as APIs JavaScript ou a identificação do navegador. O idioma do navegador e dos frames de login é `pt-BR`. Qwen mantém sua integração existente com `playwright-extra`. Para usar o Google Chrome instalado no ambiente, configure `PLAYWRIGHT_CHANNEL=chrome`. Os workers Docker incluem Chromium e mantêm esse padrão. A aprovação dos desafios de login depende do provedor.

O proxy fica em `http://127.0.0.1:3000/v1/chat/completions`. Teste com qualquer SDK OpenAI:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Oi"}],
    "stream": true
  }'
```

---

## Diagnóstico de perda de login

No uso local, o proxy grava automaticamente `logs/deepsproxy-diagnostic.log`, inclusive quando iniciado em segundo plano pelo Zed. O arquivo é criado no primeiro evento; caminhos relativos partem da raiz do projeto. Reinicie o proxy após atualizar o código para começar a coleta. O log independe de `LOG_LEVEL` e da saída do console.

Cada linha é um objeto JSON com horário UTC, processo, `runId` e evento. `requestId` acompanha uma chamada do cliente; `operationId` distingue a resposta principal dos resumos internos (`operation: summary`), e `attempt` identifica as tentativas. Eventos do navegador fora de uma chamada podem não ter `requestId`.

Para investigar, use o Zed normalmente até o problema reaparecer e procure a sequência anterior à falha: `session.transition` e seu `reason`, `browser.navigation` com rota `login`, status de `upstream.response` e `browser.network_response`, `capture.failed` e `browser.closed`. O aborto `capture.intentional_abort` faz parte da captura de PoW. Um status 401/403/429 isolado não determina expiração, suspensão ou bloqueio; compare os demais sinais. `request.finished` encerra a chamada, enquanto `stream.finished` encerra a leitura do upstream.

O arquivo aceita apenas campos de diagnóstico predefinidos: durações, contagens, status, categorias fixas e presença de credenciais como booleanos. Não grava conversas, IDs reais dos chats, credenciais, corpos de erro, conteúdo da página ou URLs completas. Os logs de console existentes continuam com seu comportamento atual.

Ao atingir 10 MB, o arquivo é rotacionado para `deepsproxy-diagnostic.1.log`, mantendo até três anteriores, aproximadamente 40 MB no total. Esses arquivos são ignorados pelo Git. Erros de disco ou uma fila cheia geram aviso no console e podem perder eventos, sem interromper o proxy.

Configure no `.env` se necessário:

```dotenv
# Desativar o diagnóstico persistente:
DEEPSPROXY_DIAGNOSTICS=0
# Ou escolher outro destino:
DEEPSPROXY_DIAGNOSTICS_FILE=logs/deepsproxy-diagnostic.log
```

Em workers e testes automatizados o diagnóstico fica desativado por padrão; `DEEPSPROXY_DIAGNOSTICS=1` permite ativá-lo explicitamente. Esta instrumentação preserva a política atual de login, pausas e repetição de chamadas. A causa da perda de login será avaliada após capturar uma ocorrência real.

## Logs do console e da rede do navegador

O DeepSeek e o Qwen registram automaticamente o console de todas as abas,
erros JavaScript, requisições, respostas HTTP, durações e falhas de rede. Cada
requisição tem um `networkRequestId` para correlacionar os eventos.

No uso local, os arquivos ficam em `logs/browser-deepseek.log` e
`logs/browser-qwen.log`. Nos workers Docker, ficam em
`/profile/browser-diagnostic.log`, no volume persistente de cada conta, e também
aparecem nos logs do container. Para acompanhar o ambiente local completo:

```powershell
npm run live:worker-logs
```

O formato é JSON por linha, com horário UTC, provedor, navegador e aba. Não são
gravados cabeçalhos nem corpos das requisições ou respostas. Na resposta de
verificação do hCaptcha, apenas os booleanos `success`/`pass` e códigos de erro
reconhecidos são extraídos para o evento `browser.captcha_result`; respostas
do usuário, imagens, dados do desafio e tokens não são gravados. HTTP 200 por
si só não confirma a aprovação do CAPTCHA. As URLs perdem
query string, fragmento, credenciais e identificadores reconhecidos. O texto do
console é limitado a 2.048 caracteres e tem remoção de padrões de credenciais,
e-mails e campos de conteúdo; argumentos estruturados não são serializados.

Cada arquivo tem limite de 10 MB e três backups. Falhas de gravação não
interrompem o navegador. Use `DEEPSPROXY_BROWSER_LOG=0` para desativar ou
`DEEPSPROXY_BROWSER_LOG_FILE` para escolher o arquivo de destino. A captura é
desativada por padrão nos testes automatizados.

## Configuracao da extensao Continue

Este repositorio inclui um arquivo pronto para a extensao Continue:

```txt
continue.config.yaml
```

Instalacao automatica:

```bash
make continue-config
```

O comando cria a pasta `.continue` no diretorio do usuario, faz backup de um `config.yaml` existente e copia `continue.config.yaml` para o local correto.

Passo a passo manual:

1. Abra o arquivo `continue.config.yaml` deste repositorio.
2. Copie todo o conteudo do arquivo.
3. Abra o arquivo de configuracao global do Continue:

```txt
Windows: C:\Users\SEU_USUARIO\.continue\config.yaml
macOS:   /Users/SEU_USUARIO/.continue/config.yaml
Linux:   /home/SEU_USUARIO/.continue/config.yaml
```

4. Cole o conteudo copiado em `config.yaml`.
5. Salve o arquivo.
6. No VS Code, execute `Developer: Reload Window`.
7. No Continue, selecione `LOCALHOST:3000 - Proxy IA Flash`.

Use `LOCALHOST:3000 - Proxy IA Thinking` apenas quando quiser raciocinio explicito. Esse modelo costuma demorar mais para aparecer na extensao porque primeiro envia chunks em `reasoning_content` e depois envia a resposta final em `content`.

Se o Proxy IA estiver usando uma porta diferente de `3000`, ajuste `apiBase` no arquivo do Continue. Exemplo para porta `8080`:

```yaml
apiBase: http://127.0.0.1:8080/v1
```

Se voce definiu `API_KEY` no Proxy IA, troque `apiKey: local` pela mesma chave.

---

## Configuração do Zed

O projeto inclui `.zed/settings.json` com o provedor OpenAI compatível `deepsproxy-local`, configurado para `http://127.0.0.1:3000/v1` e os modelos Flash e Thinking. Dependendo da versão do Zed, adicione esse provedor em **Agent: Open Settings → LLM Providers → Add Provider → OpenAI** com nome `deepsproxy-local`, URL `http://127.0.0.1:3000/v1`, IDs `deepseek-v4-flash` e `deepseek-v4-flash-thinking` e janela conservadora de contexto `512000` para Flash e Thinking. O valor `max_tokens` define a janela de contexto do modelo no Zed. O teste pela interface web respondeu com entradas de até 2,56 milhões de caracteres; a entrada de 5,12 milhões foi recusada com aviso de 49% acima do limite. Como o site não expõe a contagem exata de tokens, o projeto usa `512000` como margem conservadora. Para iniciar a API, use o atalho global `Ctrl+Alt+D` ou abra o seletor de tarefas com `Ctrl+Shift+R` e execute `Proxy IA: Start local API`. A tarefa inicia o servidor em segundo plano ou detecta se ele já está ativo; depois selecione o provedor/modelo no painel Agent. O Zed não oferece um botão de extensão customizado nem inicia tarefas automaticamente ao selecionar um modelo.

O arquivo também define `agent.tool_permissions.default` como `allow`, aprovando automaticamente as ferramentas do Agent Panel neste projeto. Isso reduz os avisos de confirmação; use apenas em um workspace confiável. Essa opção não dá permissões adicionais ao sistema operacional nem configura agentes externos.

Para iniciar o proxy, conecte a conta pelo painel (`make live`) e execute `npm start`. O Zed exige uma credencial para habilitar provedores OpenAI compatíveis, mesmo quando o proxy local não valida chave. Para o provedor `deepsproxy-local`, defina a variável de usuário `DEEPSPROXY_LOCAL_API_KEY=local` ou informe `local` em **Agent: Open Settings → LLM Providers**. Sem `API_KEY` no Proxy IA, esse valor fictício é aceito pelo proxy, que permanece restrito ao loopback. Se você definir `API_KEY` no Proxy IA, use essa mesma chave em vez de `local`. Não coloque segredos em `settings.json`.

A configuração usa o formato `language_models.openai_compatible` documentado pelo Zed para endpoints compatíveis com a API OpenAI.

---

## 🔐 Política de bind e auth

Diferente do original, este fork **falha fechado** quando `API_KEY` não está definida.

| `API_KEY` | `BIND_HOST` | Comportamento |
|-----------|-------------|---------------|
| definida  | qualquer    | Sobe normalmente; toda request precisa de `Authorization: Bearer <key>` ou `X-API-Key`. |
| **não definida** | não definido | Sobe em `127.0.0.1` com aviso loud no log. |
| **não definida** | `127.0.0.1` ou `localhost` | Sobe em loopback com aviso loud. |
| **não definida** | `0.0.0.0` ou IP público | **Recusa subir** (`exit 2`). |

Geração rápida de chave:

```bash
openssl rand -hex 32
```

---

## ⚙️ Variáveis de ambiente

Veja `.env.example` para a lista completa. As mais relevantes:

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `BIND_HOST` | `127.0.0.1` (sem API_KEY) ou `0.0.0.0` | Host de bind |
| `API_KEY` | — | Chave obrigatória se `BIND_HOST` for público |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PLAYWRIGHT_HEADLESS` | `true` | `false` apenas para debugging |
| `PLAYWRIGHT_CHANNEL` | `chromium` | `chrome` para usar Google Chrome instalado; vale para DeepSeek e Qwen |
| `DEEPSEEK_PROFILE_DIR` | `deepseek_profile` | Pasta do perfil persistente do Chromium |
| `DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS` | `8000` | Tempo limite p/ aparecer o input do chat |
| `DEEPSPROXY_POW_TIMEOUT_MS` | `30000` | Tempo limite p/ capturar PoW |
| `DEEPSPROXY_REQUEST_DELAY_MIN_MS` | `15000` | Menor pausa entre gerações, contada após encerramento |
| `DEEPSPROXY_REQUEST_DELAY_MAX_MS` | `30000` | Maior pausa sorteada entre gerações |
| `DEEPSPROXY_ACTION_DELAY_MIN_MS` | `10000` | Menor pausa antes de cada ação do navegador |
| `DEEPSPROXY_ACTION_DELAY_MAX_MS` | `15000` | Maior pausa antes de cada ação do navegador |
| `DEEPSPROXY_MAX_ATTEMPTS` | `1` | Total de tentativas por pedido (1–10); autenticação, suspensão e timeout de PoW não têm retry |
| `DEEPSPROXY_RETRY_DELAY_MS` | `1000` | Backoff entre tentativas |
| `DEEPSPROXY_SUMMARY_TRIGGER_RATIO` | `0.72` | Fração do limite detectado que dispara resumo automático (entre `0.5` e `0.9`) |
| `DEEPSPROXY_TELEMETRY_FILE` | `<profile>/.telemetry.json` | Onde a telemetria persiste |
| `DEEPSPROXY_DISABLE_TELEMETRY_PERSIST` | `0` | `1` desliga a persistência |
| `DEEPSEEK_APP_VERSION` | `2.0.0` | Header `x-app-version` enviado ao DeepSeek |
| `DEEPSEEK_CLIENT_VERSION` | igual a `APP_VERSION` | Header `x-client-version` |
| `DEEPSEEK_CLIENT_LOCALE` | `pt_BR` | Header `x-client-locale` |
| `DEEPSEEK_ACCEPT_LANGUAGE` | `pt-BR,...` | Header `accept-language` |
| `DEEPSEEK_USER_AGENT` | User agent nativo do Chromium | Sobrescrita opcional do user agent do DeepSeek |

O limite de contexto divulgado por `/v1/models` é configurado ou estimado (`context_limit_source: configured_or_estimated`). O piso de 512 mil tokens do Flash não é uma capacidade comprovada a cada envio. Falhas de rede, autenticação e suspensão não reduzem a estimativa. Em streaming, a telemetria só registra sucesso após concluir o processamento da resposta.

Erros de `/v1/chat/completions` mantêm `error.message`, `error.type` e `error.code` e incluem `error.original_message` (quando disponível), `error.user_action` e `error.help_url` (quando há um site a acessar). A própria `message` contém o erro, a orientação e o link para clientes que exibem apenas esse campo. Suspensões também informam `suspended_until` quando a data foi capturada; limites de frequência incluem `retry_at`. O aviso original da suspensão é preservado após reinício. O login deve ser concluído na tela remota do painel (botão Conectar): abrir o site em outro navegador não autentica o proxy. Falhas depois do início do streaming são enviadas como um evento SSE `data: {"error": ...}`, seguido de `[DONE]`.

Se aparecer `Porta já ocupada`, encerre a outra instância do proxy ou altere `PORT`; não inicie uma segunda instância sobre a mesma porta ou perfil.

---

## 🛡️ Hardening — o que mudou em relação ao original

| Problema no original | Como foi resolvido aqui |
|---|---|
| Singleton `activePage` global — duas requests simultâneas se atropelavam | `Mutex` em `utils/mutex.ts` serializa o acesso ao Playwright (`getDeepSeekHeaders` agora é seguro sob concorrência) |
| `API_KEY` opcional silenciosa — proxy ficava aberto se a env vazasse | Bind padrão em loopback sem API_KEY; recusa subir em IP público sem ela |
| Telemetria em `globalThis` perdida a cada restart | Persistida em `<profile>/.telemetry.json` com escrita atômica e debounce de 1s |
| `chat.ts` com 715 linhas misturando tudo | Quebrado em `serialization.ts` + `tool-parser.ts` + `stream.ts` + `chat.ts` (orquestração apenas) |
| `console.log` espalhado, risco de logar `cookie`/`authorization` | Logger central em `utils/logger.ts` com `redactHeaders()`; nenhum `console.log` direto fora desse módulo |
| `x-app-version: 2.0.0` hardcoded | Configurável via `DEEPSEEK_APP_VERSION` / `DEEPSEEK_CLIENT_VERSION` |
| `start-deepsproxy.sh` com paths absolutos `/root/.hermes/...` específicos do autor | Removido — use `npm start` ou `docker compose up` |
| Cabeçalhos `Author/Created/Last Modified` mentirosos em todo arquivo | Removidos; o git já cuida disso |
| `version: '3.8'` no docker-compose (obsoleto) | Removido; expõe apenas em loopback por padrão |

---

## 🐳 Docker

O `docker-compose.yml` exige `API_KEY` no environment do host (ou em um `.env` ao lado), e expõe a porta apenas em `127.0.0.1` por padrão.

```bash
API_KEY=$(openssl rand -hex 32) docker compose up -d
docker compose logs -f
```

---

## 🧪 Testes

```bash
# Testes unitários e de rota, sem login ou chamadas reais ao DeepSeek
npm test

# Simula dois turnos reais, usando o histórico completo como o Continue
npm run test:live-context
```

O teste `test:live-context` exige que a API esteja rodando em `http://127.0.0.1:3000` e que o perfil DeepSeek esteja autenticado. Ele envia dois turnos em streaming e confirma se o segundo recupera uma decisão antiga via resumo automático. Para outro endereço ou modelo, use `DEEPSPROXY_API_BASE` ou `DEEPSPROXY_LIVE_TEST_MODEL`. O teste de integração em `src/index.test.ts` também fica desativado por padrão; habilite-o explicitamente com `DEEPSPROXY_RUN_LIVE_TESTS=1`.

---

## ⚠️ Disclaimer

Este projeto automatiza uma UI web de terceiros e usa flags de Chromium que mascaram a automação. Isso **viola os Termos de Serviço do DeepSeek** e pode levar à suspensão da sua conta (o código inclusive detecta esse estado e retorna `403 deepseek_account_suspended`).

Use estritamente para **estudo, pesquisa pessoal ou ambientes de testes próprios**. Para qualquer uso minimamente sério, use a **API oficial paga do DeepSeek** — toda a arquitetura deste projeto (tool calling, agentic loop, OpenAI compat, schema validation) é reaproveitável trocando apenas o transport.

Você é responsável pelo seu uso. Sem garantia de funcionamento — a UI do DeepSeek muda frequentemente.

---

## 📄 Licença

ISC. Veja [LICENSE](LICENSE).
