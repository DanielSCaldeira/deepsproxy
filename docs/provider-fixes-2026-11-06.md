# Correções após os testes reais de provedores — 2026-11-06

O contrato compartilhado continua sendo OpenAI: `messages`, `tools`,
`tool_choice`, `tool_calls` e mensagens `role: tool`, como no DeepSeek.
Cada frontend envia sua própria mensagem; o proxy não inventa credenciais nem
troca um modelo indisponível por outro silenciosamente.

## Correções implementadas

- Sessões: preservar o perfil nativo mais recente, reparar exports antigos de
  IndexedDB com backup e salvar corretamente chaves/valores `0`, `false`, vazio
  e nulo. Uma exportação incompleta não substitui o snapshot anterior.
- Navegação: lidar com hidratação que substitui editores e recusar cookies
  opcionais quando o banner impede a interação. Verificação humana do ChatGPT
  é reportada explicitamente, preservando a sessão.
- Claude: acompanhar a resposta do transporte RPC atual, ignorando respostas
  antigas e esperando o término da nova, sem reenviar a mensagem. Obter o texto
  original pela ação Copiar: a tipografia do Markdown transformava as aspas do
  JSON de ferramentas e causava `invalid_tool_call`.
- Grok: acompanhar a resposta das server actions atuais e excluir modos que
  exigem plano pago. A captura da ação Copiar também preserva o Markdown e o
  JSON originais. Fast e Build foram observados na conta de teste.
- Mistral: abrir o compositor recolhido de `/work`, reconhecer o seletor
  localizado e encaminhar apenas chunks de resposta, sem o texto agregado
  que pode incluir raciocínio interno.
- Perplexity: interpretar respostas em workflow e seus patches; omitir o
  rodapé de fontes quando não houver citações para preservar respostas exatas.
- Copilot: adicionar envio pelo editor Microsoft 365 e captura do socket
  nativo com correlação por prompt/invocationId. O teste simulado passa; o
  envio real nessa conta permanece pendente porque o site não despachou a mensagem.
- Transporte: processar frames finais válidos antes de tratar um cancelamento
  tardio do leitor do frontend como erro.
- Supervisão: uma consulta de status atrasada não substitui o estado de um
  navegador novo; liberar o navegador não permite que uma recuperação antiga
  o inicie novamente.
- Chaves: revogar uma chave interrompe apenas as requisições feitas com ela.
  Outras chaves do mesmo usuário mantêm suas chamadas.

## Validação automatizada

`npm run build` e `npm test`: 216 testes, 214 aprovados, 0 falhas e 2 ignorados.
As regressões usam navegadores reais com frontends controlados; não substituem
a validação de autenticação e disponibilidade do site externo.

As imagens de gateway, provisioner e worker foram reconstruídas e o laboratório
local `http://localhost:3440` foi atualizado. Os perfis e o banco foram preservados.

## Evidências reais

Chamadas pelos adaptadores corrigidos retornaram `TESTE_CORRECAO_OK` em Claude,
Grok, Meta, Mistral e Perplexity. O Grok expôs Fast e Build; modos pagos não
foram anunciados. Os detalhes privados de diagnóstico ficam fora do Git.

As evidências do gateway após a atualização são gravadas em
`.cache/fix-gateway-native.json` e `.cache/fix-gateway-shared.json`.
Esses testes exigem argumentos válidos, `finish_reason: tool_calls`, execução
local de fixture e retorno exato de um valor aleatório recebido por `role: tool`.

## Revalidação após reconstruir o laboratório — 2026-11-07

Suíte local: 217 testes, 215 aprovados, 0 falhas e 2 ignorados. O timeout
anterior em `diagnostic-flow.test.ts` não se repetiu: ele ocorreu durante um
build Docker simultâneo.

Smoke real pelo gateway (`text` e `required`, JSON), com as imagens atuais:

| Provedor | Resultado |
| --- | --- |
| Claude | aprovado em `text` e `required` |
| Meta | 5 de 6 aprovados; `meta/auto required` falhou uma vez ("did not start a response") |
| Grok | `grok/fast text` aprovado; os demais casos foram bloqueados pelo limite de uso da conta (HTTP 429) |
| Mistral | **falha**: o raciocínio do modelo chega como chunk `text` e vaza na resposta; `required` gera um tool call inválido |
| Perplexity | **falha** em todos os modelos: o banner de cookies (`role="dialog"`, não modal) bloqueia o seletor de modelo, e o handler "Recusar opcionais" não encontra o botão real |

## Correções após a revalidação — 2026-11-07

- Perplexity: o banner de cookies é aceito ("Entendi"), porque "Recusar
  opcionais" não o fecha; o handler genérico de recusa não é instalado nesse
  site. O seletor de modelo espera a hidratação. A oferta de assinatura que um
  modelo pago abre no plano gratuito é fechada, e modelos pagos que o site
  recusa ou troca deixam de ser anunciados.
- Mistral: o prompt termina com regras de saída explícitas, num parágrafo sem
  marcadores (o editor rich text transforma "- " em lista e quebrava a
  correlação). O raciocínio deixou de vazar no caso `text`.
- Ernie: o chat funciona como visitante; o login Baidu é opcional. Respostas de
  visitante são válidas, um bloqueio antigo de `login_required` é limpo, e a
  abertura do menu de modelos tolera a animação do painel.
- Copilot Microsoft 365: o texto entra pelo tratamento de colagem do editor,
  o envio é confirmado pelo esvaziamento da caixa (com Enter de reserva), a
  correlação ignora marcadores invisíveis e o erro informa o estado da página.
  O helper de captura não usa funções nomeadas, que quebram no navegador.

Smoke real após essas correções:

| Provedor | Resultado |
| --- | --- |
| Perplexity | `auto` aprovado em `text`; modelos pagos recusados com mensagem de plano pago |
| Mistral | `text` aprovado; `required` recebe HTTP 500 do próprio site |
| Ernie | `smartMode required` aprovado como visitante; a correção do menu de modelos ainda não passou pelo laboratório |
| Copilot | o prompt continua na caixa após Enviar; em investigação pela tela remota |

## Pendências externas

DeepSeek, Qwen e Kimi apresentaram login pendente nos diagnósticos.
ChatGPT exibiu verificação humana. O limite de uso do QuillBot e os modos
pagos de outros sites não podem ser removidos pelo proxy.

Use **Conectar** no card do site, conclua o login ou a verificação na tela
remota e clique em **Concluir login**. A correção de sessão evita reaplicar
um snapshot antigo sobre os tokens recém-renovados.

O Copilot Microsoft 365 continua sem comprovação de envio real; testes
simulados aprovados não significam aprovação dessa integração de ponta a ponta.
