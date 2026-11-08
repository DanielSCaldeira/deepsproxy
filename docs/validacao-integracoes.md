# Validação das integrações para o Zed Agent (2026-11-07)

Objetivo: saber quais provedores do proxy já devolvem respostas no formato que o
**Zed Agent** precisa para criar código e executar tarefas (tool calls OpenAI,
streaming e ciclo de retorno das ferramentas), sem precisar repetir os testes.

- Matriz completa, gerada automaticamente: [validacao-integracoes-resultados.md](validacao-integracoes-resultados.md)
- Evidência sanitizada (códigos HTTP, tools executadas, tempos): [evidence/integrations-2026-11-07.json](evidence/integrations-2026-11-07.json)
- Arquivos privados de origem (requisições e respostas completas) ficam em `.cache/` e não são versionados.

## Resumo: o que já funciona

Legenda: ✅ aprovado para o Zed · 🟡 funciona com ressalvas · ❌ não usar com o Zed hoje ·
⛔ bloqueado por pendência da conta (exige ação no painel).

| Provedor / modelo testado | Zed (replay) | API com tools | Situação |
| --- | --- | --- | --- |
| Claude — `claude/auto` | ✅ | 10/10 | Aprovado. Criou os arquivos, rodou os testes e respondeu em 3 turnos (~60 s/turno). |
| NVIDIA — `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b` | ✅ (e Zed real ✅) | 12/12 | Aprovado. Único modelo validado também no Zed de verdade (7/7 testes executados pelo próprio Zed). |
| Kimi — `kimi/k28-instant` | ❌ | 11/12 | Com o prompt do Zed, executou a tarefa no **sandbox do próprio site** (`/mnt/agents/output/`) em vez de devolver tool calls; nada foi criado no workspace e vazaram marcadores `<REF>` (ver achado 2). |
| Grok — `grok/fast` | ❌ | 3 ✅ antes de travar | Com o prompt do Zed, respondeu "criado e verificado", com saída de testes, **sem nenhuma tool call**; nenhum arquivo existe. A saída parece vir da execução de código do próprio grok.com (ver achado 2). |
| Meta — `meta/auto` | ❌ | 8/12 | Com o prompt do Zed, o site não iniciou a resposta (502), o mesmo sintoma de `forced` na API (ver achado 3). |
| ChatGPT — `chatgpt/auto` | ❌ | 10/10 | Passa na API com prompts curtos, mas **falha com prompts multilinha**, que é o caso de toda requisição do Zed (ver achado 1). |
| Cohere — `command-a-03-2025`, `c4ai-aya-vision-32b`, `command-a-translate-08-2025` | não testado | 10/10 | 🟡 Esses três passam na API; `cohere/auto` e `command-a-reasoning` dão 502 com tools; `aya-expanse` e `command-r` prefixam a resposta (`**Final Answer:**`). |
| Ernie — `ernie/smartMode` | ❌ | 10/12 | O site limita a entrada a 20 000 caracteres; a primeira requisição do Zed tem ~45 000. Serve para clientes com prompts menores. |
| Perplexity — `perplexity/auto` | não testado | 4/12 | ❌ Só texto: o modelo se recusa a usar as tools ou devolve tool call inválida. |
| OpenRouter — modelos `:free` | não testado | só texto | ❌ HTTP 400 com tools ou 429 (limite gratuito). |
| NVIDIA — `deepseek-ai/deepseek-v4.1-flash` | não testado | 1/12 | ❌ `tool_choice` não anunciado no catálogo e 502 de transporte. |
| Gemini — `gemini/auto` | não testado | 0/2 | ⛔ Um modal do site cobre a página e intercepta os cliques (ver achado 5). Passava 10/10 em 2026-11-06. |
| Copilot — `copilot/auto` | não testado | 0/2 | ❌ Pendência conhecida: o site não despacha a mensagem pelo socket do chat. |
| Qwen — `qwen/qwen3.7-plus` | não testado | 0/2 | ⛔ Desafio anti-bot da Alibaba (`_____tmd_____`) intercepta o envio; nem um prompt trivial responde. |
| DeepSeek | não testado | — | ⛔ `login_required`: refazer o login pela tela remota. |
| Mistral | não testado | — | ⛔ Sessão indisponível (não autenticada). |
| QuillBot | não testado | — | ⛔ "Verificação do site pendente no navegador". |

Para usar hoje no Zed: **Claude** e **NVIDIA Nemotron**. Os demais passam (total ou parcialmente) na matriz da API, que usa 2 tools pequenas, mas falham com o prompt real do Zed (~45 mil caracteres, 16 tools). Aprovação na API **não** garante uso no Zed.

## Como foi testado

Três camadas, da mais barata à mais fiel:

1. **Matriz da API** (`scripts/smoke-all-providers.ts`): chamadas reais ao gateway local
   com chave temporária. Cada modelo roda 6 cenários, em JSON e em streaming:
   - `text`: resposta só de texto;
   - `auto`: `tool_choice: "auto"`; o modelo precisa decidir chamar `read_file`;
   - `required`: `tool_choice: "required"`;
   - `forced`: `tool_choice` apontando para `read_file`;
   - `multiple`: duas tools na mesma resposta (`read_file` e `echo_text`);
   - `none`: tools presentes, mas `tool_choice: "none"`.

   Nos cenários com tool, o executor faz o papel do cliente: executa a tool localmente,
   devolve o resultado e exige que a resposta final traga exatamente o valor lido do
   arquivo, com `finish_reason` correto, `[DONE]` no SSE e sem marcadores internos vazando.
   **"Bloqueado" significa que o cenário não foi executado:** após duas falhas seguidas
   de transporte ou de sessão, os cenários restantes do modelo são pulados.

2. **Replay do protocolo do Zed** (`scripts/zed-replay.ts`): reenvia o system prompt real
   do Zed (~17 mil caracteres), as 16 tools reais e os parâmetros que o Zed usa
   (`stream`, `stream_options`, `max_tokens: 4096`, `temperature: 1`), todos capturados de
   uma sessão real do Zed. O harness faz o loop do agente: interpreta o SSE como o Zed,
   executa `read_file`, `list_directory`, `create_directory`, `write_file`, `edit_file`,
   `find_path`, `grep` e `terminal` (só comandos `node`, sem shell) numa pasta descartável
   e devolve os resultados no formato do Zed. Tarefa: criar `<provedor>/sum.mjs` e
   `<provedor>/sum.test.mjs` com `node:test` e rodar os testes. **Aprova quando:** os
   arquivos foram criados por tool call; os testes rodaram pelo terminal; o harness roda
   `node --test` de forma independente e passa; a resposta final não vaza marcadores;
   `finish_reason=stop`; e não houve 4xx/5xx. A primeira requisição tem ~45 mil caracteres
   depois de serializada pelo proxy, e a conversa cresce até ~60 mil.

3. **Zed real** (`scripts/zed-validation-bridge.ts`): ponte gravadora só em loopback entre
   o Zed e o gateway. Feito com o NVIDIA Nemotron, que criou os arquivos, rodou os testes
   no terminal do Zed e aprovou 7/7. O replay foi calibrado contra essa sessão (mesmas tools
   usadas e testes aprovados).

## Achados que pedem correção no proxy

1. **ChatGPT: prompt multilinha quebra o preenchimento do editor.** `editor.fill()` falha
   ("interaction failed during filling editor") com qualquer texto de muitas linhas: 8 mil
   caracteres em ~107 linhas falham, enquanto 45 mil caracteres numa linha só passam. O smoke
   não pegava porque usa prompts curtos. Toda requisição do Zed é multilinha (system prompt,
   código, resultados de tools). O mesmo método funciona no Claude. Próximo passo: capturar o
   erro original do Playwright (hoje engolido pelo `catch` genérico) e trocar a forma de
   inserir o texto (por exemplo, `ClipboardEvent` de colagem, como no adaptador do Copilot).
2. **Kimi e Grok: as ferramentas nativas do site sequestram a execução.** Com o prompt do
   Zed, o Kimi rodou a tarefa no sandbox do próprio site (`/mnt/agents/output/`), e o Grok
   respondeu com uma saída de testes plausível, sem nenhuma tool call. Em ambos, nada foi
   criado no workspace do Zed, e o Kimi ainda vazou marcadores `<REF>file✦sandbox:…</REF>`.
   Na matriz da API (tarefa pequena, 2 tools) os dois emitiam tool calls normalmente. Para um
   agente, este é o modo de falha mais perigoso: a resposta afirma que o trabalho foi feito. O
   adaptador precisa desativar as ferramentas, o agente ou a execução de código do site (ou
   escolher um modo sem elas) e tratar marcadores como `<REF>` como vazamento.
3. **Meta AI: texto da interface vaza na resposta e a tool não é emitida em `auto`.** O
   conteúdo capturado inclui o rótulo "Mostrar raciocínio" da página, e o modelo descreve
   que vai chamar a ferramenta em vez de chamá-la. Em `forced`, o site não inicia a resposta (502).
4. **Grok: clique no seletor de modelo trava de forma intermitente.** O botão
   `#model-select-trigger` é encontrado e clicado, mas a página não responde em 5 s. Os 3
   primeiros cenários passaram.
5. **Gemini: modal do site não é fechado.** Um `cdk-overlay-dark-backdrop` intercepta os
   cliques, e o adaptador não tem rotina para dispensar avisos ou novidades do site.
6. **Ernie: linha de modelo instável.** `[data-testid="chat-mode-model-row"]` é recriada
   durante a animação (2 de 12 cenários). Independentemente disso, o limite de 20 000
   caracteres do site impede o uso com o Zed.
7. **Cohere:** `cohere/auto` e `command-a-reasoning` dão 502 nas requisições com tools;
   `aya-expanse` e `command-r` às vezes prefixam a resposta final (`**Final Answer:**`,
   `final-answer:`). Os modelos `command-a-03-2025`, `c4ai-aya-vision-32b` e
   `command-a-translate-08-2025` passam 10/10.

Limitações dos sites ou modelos, não do proxy: Perplexity se recusa a usar tools;
OpenRouter `:free` responde 400 ou 429 com tools; `deepseek-v4.1-flash` (NVIDIA) não anuncia
`tool_choice`; Ernie limita a entrada a 20 000 caracteres.

## Pendências das contas do laboratório (ação no painel)

Abra a tela remota da conta no painel e resolva:

- **DeepSeek:** refazer o login (`login_required`).
- **Mistral:** sessão não autenticada; entrar de novo.
- **QuillBot:** concluir a verificação do site.
- **Qwen:** resolver o desafio anti-bot (slider da Alibaba) que aparece ao enviar.
- **Gemini:** fechar o modal aberto na página (até o adaptador fazer isso sozinho).

Depois disso, repita só esses provedores (veja "Como repetir").

## Incidente durante a validação

Por volta das 21:00 (horário de Brasília) o Docker Desktop parou por completo. O Postgres
do laboratório subiu em modo de recuperação ("not properly shut down"), e as rodadas em
andamento foram perdidas. O ambiente foi levantado de novo com
`docker compose --env-file .cache/proxy-ia-live.env -f compose.live.yml up -d --wait`,
sem reconstruir imagens, e as rodadas foram refeitas. Os resultados de ChatGPT, Claude e
Cohere na API são de antes da queda; os demais, de depois. A imagem do worker em uso
(`deepsproxy-worker:live`, 2026-11-07 00:24) contém as correções do commit `473f027`.

## Quando é preciso retestar

Não é preciso repetir o que está ✅ enquanto o código e o site não mudarem. Reteste um
provedor quando:

- o adaptador dele (`src/providers/<id>*.ts`), `src/routes/serialization.ts` ou o
  transporte compartilhado mudar. O relatório guarda `revision` e `fingerprint` do código
  testado, e `DSP_TEST_RESUME=1` recusa retomar um relatório de outro código;
- o site mudar a interface (falhas de seletor, clique ou editor);
- a conta voltar de uma pendência (login, verificação, desafio).

## Como repetir

Pré-requisitos: laboratório no ar (`npm run live`, ou o `docker compose ... up -d --wait`
acima) e `.cache/proxy-ia-live-admin.json` com o login local. Os scripts criam chaves
temporárias e as revogam ao terminar. Se um processo for interrompido à força, revogue as
chaves "Temporary…" ou "Teste completo de provedores" pelo painel.

```bash
# Matriz da API para provedores e modelos escolhidos (relatório novo)
DSP_REPORT=.cache/zed-validation-YYYY-MM-DD \
DSP_TEST_PROVIDERS=kimi,grok DSP_TEST_MODELS=kimi/k28-instant,grok/fast \
npx tsx scripts/smoke-all-providers.ts
# Opcional: DSP_TEST_CONTINUE_ON_502=1 executa todos os cenários mesmo após falhas 5xx repetidas.

# Replay do protocolo do Zed (precisa da captura .cache/zed-agent-validation/http-evidence.json)
npx tsx scripts/zed-replay.ts claude/auto kimi/k28-instant

# Regenera a matriz pública (fontes da mais antiga para a mais nova)
npx tsx scripts/report-integrations.ts .cache/zed-validation-free-2026-11-07.json \
  .cache/zed-validation-nvidia-fixed-2026-11-07.json .cache/zed-validation-2026-11-07.json \
  .cache/zed-validation-rep-2026-11-07.json .cache/zed-validation-rep2-2026-11-07.json
```

Para refazer a captura do Zed real: rode `npx tsx scripts/zed-validation-bridge.ts`, aponte
temporariamente um provedor `openai_compatible` do Zed para `http://127.0.0.1:3451/v1`,
execute a tarefa e restaure o `settings.json` do Zed depois. A ponte revoga a própria chave
ao receber Ctrl+C ou após 2 horas.

## Configuração do Zed

Use o formato `language_models.openai_compatible` com os modelos aprovados. Valores usados
na validação (conservadores):

```json
{
  "language_models": {
    "openai_compatible": {
      "proxy-ia": {
        "api_url": "http://localhost:3440/v1",
        "available_models": [
          {
            "name": "claude/auto",
            "display_name": "Proxy IA · Claude",
            "max_tokens": 32000,
            "max_output_tokens": 4096,
            "capabilities": { "tools": true, "images": false, "parallel_tool_calls": false,
              "prompt_cache_key": false, "chat_completions": true, "max_tokens_parameter": true }
          }
        ]
      }
    }
  }
}
```

A chave `dsp_` é criada no painel e informada em **Agent: Open Settings → LLM Providers**.
Nunca a coloque no `settings.json`. Para produção, troque `api_url` pelo endereço público do
gateway. Cada turno de um provedor web leva de 30 a 90 s, porque o proxy opera o site como
uma pessoa e respeita pausas entre ações; prefira tarefas curtas e objetivas.
