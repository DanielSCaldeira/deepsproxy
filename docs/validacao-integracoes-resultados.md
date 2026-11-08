# Matriz de validação das integrações

Gerado em 2026-11-08T02:26:58.407Z por `scripts/report-integrations.ts`. Leitura e conclusões: [validacao-integracoes.md](validacao-integracoes.md).

Resultados de chamadas reais ao gateway local. Aprovação na API não comprova execução no Zed; veja a seção do replay abaixo. Os arquivos privados de origem (`.cache/`) não são publicados.

## API (cenários por modelo)

| Provedor | Modelo | Aprovados | Falhas | Bloqueados | Não suportados | Pendentes | Motivos |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| nvidia | nvidia/deepseek-ai/deepseek-v4.1-flash | 1 | 2 | 8 | 1 | 0 | http_502, http_400, not_advertised |
| nvidia | nvidia/nvidia/nemotron-3.5-lightning-30b-a3b | 12 | 0 | 0 | 0 | 0 |  |
| openrouter | openrouter/recursive/flint-v1.0:free | 1 | 1 | 10 | 0 | 0 | http_400 |
| openrouter | openrouter/xingchen-agi/xing4.0-29b-a4b:free | 0 | 0 | 12 | 0 | 0 | http_429 |
| openrouter | openrouter/dots-studio/dots-3-note-preview:free | 0 | 0 | 12 | 0 | 0 | http_429 |
| openrouter | openrouter/cohere/north-mini-code:free | 0 | 0 | 12 | 0 | 0 | http_429 |
| openrouter | openrouter/google/gemma-4-26b-a4b-it:free | 0 | 0 | 12 | 0 | 0 | http_429 |
| openrouter | openrouter/google/gemma-4-31b-it:free | 0 | 0 | 12 | 0 | 0 | http_429 |
| openrouter | openrouter/openrouter/free | 1 | 2 | 9 | 0 | 0 | http_400, http_429 |
| chatgpt | chatgpt/auto | 10 | 0 | 0 | 0 | 0 |  |
| claude | claude/auto | 10 | 0 | 0 | 0 | 0 |  |
| cohere | cohere/auto | 1 | 2 | 9 | 0 | 0 | http_502 |
| cohere | cohere/c4ai-aya-expanse-32b | 6 | 4 | 0 | 0 | 0 | unexpected_answer |
| cohere | cohere/c4ai-aya-vision-32b | 10 | 0 | 0 | 0 | 0 |  |
| cohere | cohere/command-a-03-2025 | 10 | 0 | 0 | 0 | 0 |  |
| cohere | cohere/command-a-reasoning-08-2025 | 1 | 2 | 7 | 0 | 0 | http_502 |
| cohere | cohere/command-a-translate-08-2025 | 10 | 0 | 0 | 0 | 0 |  |
| cohere | cohere/command-r-08-2024 | 3 | 1 | 0 | 0 | 1 | unexpected_answer |
| copilot | copilot/auto | 0 | 2 | 10 | 0 | 0 | http_502 |
| deepseek | deepseek-v4-flash | 0 | 0 | 12 | 0 | 0 | other |
| ernie | ernie/smartMode | 10 | 2 | 0 | 0 | 0 | http_500 |
| gemini | gemini/auto | 0 | 2 | 10 | 0 | 0 | http_502, http_500 |
| grok | grok/fast | 3 | 2 | 7 | 0 | 0 | http_502, http_500 |
| kimi | kimi/k28-instant | 11 | 1 | 0 | 0 | 0 | other |
| meta | meta/auto | 8 | 4 | 0 | 0 | 0 | unexpected_answer, http_502 |
| mistral | mistral/fast | 0 | 0 | 12 | 0 | 0 | other |
| perplexity | perplexity/auto | 4 | 8 | 0 | 0 | 0 | unexpected_answer, http_502, other |
| quillbot | quillbot/chat | 0 | 0 | 12 | 0 | 0 | other |
| qwen | qwen/qwen3.7-plus | 0 | 2 | 10 | 0 | 0 | timeout |

## Zed Agent (replay do protocolo)

Tarefa: criar `<provedor>/sum.mjs` e `<provedor>/sum.test.mjs` com as tools do Zed e rodar os testes pelo terminal. O teste independente roda `node --test` no arquivo criado.

| Modelo | Resultado | Turnos | Tools usadas | Execuções de teste pelo agente | Teste independente | Motivo |
| --- | --- | ---: | --- | ---: | --- | --- |
| nvidia/nvidia/nemotron-3.5-lightning-30b-a3b | passed | 6 | list_directory×1, create_directory×1, write_file×2, terminal×1 | 1 | ok (6 pass) |  |
| claude/auto | passed | 3 | write_file×2, terminal×1 | 1 | ok (3 pass) |  |
| chatgpt/auto | failed | 0 |  | 0 | — | http_502 |
| ernie/smartMode | failed | 0 |  | 0 | — | http_413 |
| grok/fast | failed | 1 |  | 0 | arquivo ausente | files not created through tool calls; tests not run through the terminal tool; independent node --test failed |
| meta/auto | failed | 0 |  | 0 | — | http_502 |
| kimi/k28-instant | failed | 1 |  | 0 | arquivo ausente | files not created through tool calls; tests not run through the terminal tool; independent node --test failed |

Detalhes por cenário (códigos HTTP, tools executadas pelo cliente, tempos) no [JSON sanitizado](evidence/integrations-2026-11-07.json). Cada resultado conserva a origem; rodadas posteriores substituem somente o mesmo modelo/cenário.
