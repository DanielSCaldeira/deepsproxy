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
- **Compressão de contexto** automática quando o histórico excede o limite detectado do modelo
- **Telemetria de context window persistida** — descobre o limite real do modelo na primeira execução e relembra entre restarts
- **Concorrência segura**: mutex serializa o uso da página Playwright para múltiplas requests simultâneas
- **Fail-closed por padrão**: sem `API_KEY` o servidor faz bind apenas em `127.0.0.1` (e recusa subir se `BIND_HOST` for público)
- **Logs estruturados com sanitização** de headers sensíveis (`Authorization`, `Cookie`, PoW)

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
    ├── compression.ts       # Truncamento progressivo de histórico
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
# Mock de Playwright já é ligado pelo próprio teste
npx tsx --test src/advanced.test.ts

# Tests do bootstrap (mock via env)
TEST_MOCK_PLAYWRIGHT=true npx tsx --test src/index.test.ts
```

O teste de integração real (`Chat Completions endpoint with deepseek-v4-flash-thinking`) requer um perfil logado e conectividade com `chat.deepseek.com`.

---

## ⚠️ Disclaimer

Este projeto automatiza uma UI web de terceiros e usa flags de Chromium que mascaram a automação. Isso **viola os Termos de Serviço do DeepSeek** e pode levar à suspensão da sua conta (o código inclusive detecta esse estado e retorna `403 deepseek_account_suspended`).

Use estritamente para **estudo, pesquisa pessoal ou ambientes de testes próprios**. Para qualquer uso minimamente sério, use a **API oficial paga do DeepSeek** — toda a arquitetura deste projeto (tool calling, agentic loop, OpenAI compat, schema validation) é reaproveitável trocando apenas o transport.

Você é responsável pelo seu uso. Sem garantia de funcionamento — a UI do DeepSeek muda frequentemente.

---

## 📄 Licença

ISC. Veja [LICENSE](LICENSE).
