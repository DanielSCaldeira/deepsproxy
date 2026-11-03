# DeepsProxy

Proxy local compatível com a API OpenAI que roteia requisições para o DeepSeek via automação de navegador (Playwright). Esta é uma fork endurecida do projeto original com foco em concorrência, segurança e operabilidade.

[![TypeScript](https://img.shields.io/badge/TypeScript-5+-blue)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-4-green)](https://hono.dev/)
[![Playwright](https://img.shields.io/badge/Playwright-1.59-blueviolet)](https://playwright.dev/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

---

## ✨ Recursos

- **OpenAI API compatible**: `/v1/chat/completions` (stream e non-stream) + `/v1/models`
- **Tool calling**: parser tolerante de `<tool_call>` em JSON e formato XML estilo Hermes
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
├── login.ts                 # Sessão headed para login interativo
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

# 1) Fazer login (abre browser real, você loga manualmente)
npm run login

# 2) Subir o proxy
PORT=3000 npm start
```

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
7. No Continue, selecione `LOCALHOST:3000 - DeepsProxy Flash`.

Use `LOCALHOST:3000 - DeepsProxy Thinking` apenas quando quiser raciocinio explicito. Esse modelo costuma demorar mais para aparecer na extensao porque primeiro envia chunks em `reasoning_content` e depois envia a resposta final em `content`.

Se o DeepsProxy estiver usando uma porta diferente de `3000`, ajuste `apiBase` no arquivo do Continue. Exemplo para porta `8080`:

```yaml
apiBase: http://127.0.0.1:8080/v1
```

Se voce definiu `API_KEY` no DeepsProxy, troque `apiKey: local` pela mesma chave.

---

## Configuração do Zed

O projeto inclui `.zed/settings.json` com o provedor OpenAI compatível `deepsproxy-local`, configurado para `http://127.0.0.1:3000/v1` e os modelos Flash e Thinking. Dependendo da versão do Zed, adicione esse provedor em **Agent: Open Settings → LLM Providers → Add Provider → OpenAI** com nome `deepsproxy-local`, URL `http://127.0.0.1:3000/v1`, IDs `deepseek-v4-flash` e `deepseek-v4-flash-thinking` e janela conservadora de contexto `512000` para Flash e Thinking. O valor `max_tokens` define a janela de contexto do modelo no Zed. O teste pela interface web respondeu com entradas de até 2,56 milhões de caracteres; a entrada de 5,12 milhões foi recusada com aviso de 49% acima do limite. Como o site não expõe a contagem exata de tokens, o projeto usa `512000` como margem conservadora. Para iniciar a API, use o atalho global `Ctrl+Alt+D` ou abra o seletor de tarefas com `Ctrl+Shift+R` e execute `DeepsProxy: Start local API`. A tarefa inicia o servidor em segundo plano ou detecta se ele já está ativo; depois selecione o provedor/modelo no painel Agent. O Zed não oferece um botão de extensão customizado nem inicia tarefas automaticamente ao selecionar um modelo.

O arquivo também define `agent.tool_permissions.default` como `allow`, aprovando automaticamente as ferramentas do Agent Panel neste projeto. Isso reduz os avisos de confirmação; use apenas em um workspace confiável. Essa opção não dá permissões adicionais ao sistema operacional nem configura agentes externos.

Para iniciar o proxy, faça login uma vez com `npm run login` e execute `npm start`. O Zed exige uma credencial para habilitar provedores OpenAI compatíveis, mesmo quando o proxy local não valida chave. Para o provedor `deepsproxy-local`, defina a variável de usuário `DEEPSPROXY_LOCAL_API_KEY=local` ou informe `local` em **Agent: Open Settings → LLM Providers**. Sem `API_KEY` no DeepsProxy, esse valor fictício é aceito pelo proxy, que permanece restrito ao loopback. Se você definir `API_KEY` no DeepsProxy, use essa mesma chave em vez de `local`. Não coloque segredos em `settings.json`.

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
| `DEEPSEEK_PROFILE_DIR` | `deepseek_profile` | Pasta do perfil persistente do Chromium |
| `DEEPSPROXY_CHAT_INPUT_TIMEOUT_MS` | `8000` | Tempo limite p/ aparecer o input do chat |
| `DEEPSPROXY_POW_TIMEOUT_MS` | `30000` | Tempo limite p/ capturar PoW |
| `DEEPSPROXY_MAX_ATTEMPTS` | `3` | Retries por request |
| `DEEPSPROXY_RETRY_DELAY_MS` | `1000` | Backoff entre tentativas |
| `DEEPSPROXY_SUMMARY_TRIGGER_RATIO` | `0.72` | Fração do limite detectado que dispara resumo automático (entre `0.5` e `0.9`) |
| `DEEPSPROXY_TELEMETRY_FILE` | `<profile>/.telemetry.json` | Onde a telemetria persiste |
| `DEEPSPROXY_DISABLE_TELEMETRY_PERSIST` | `0` | `1` desliga a persistência |
| `DEEPSEEK_APP_VERSION` | `2.0.0` | Header `x-app-version` enviado ao DeepSeek |
| `DEEPSEEK_CLIENT_VERSION` | igual a `APP_VERSION` | Header `x-client-version` |
| `DEEPSEEK_CLIENT_LOCALE` | `pt_BR` | Header `x-client-locale` |
| `DEEPSEEK_ACCEPT_LANGUAGE` | `pt-BR,...` | Header `accept-language` |
| `DEEPSEEK_USER_AGENT` | Chrome 130 desktop | UA do Chromium embarcado |

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
