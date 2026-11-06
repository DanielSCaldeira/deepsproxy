# Integração ChatGPT web — 2026-11-05

O adaptador foi acrescentado ao código, painel, provisionamento, migrações e
backup/restauração. Em 2026-11-06, o envio real autenticado retornou HTTP 200
com `TESTE_CHATGPT_OK` após a atualização dos seletores do compositor.
A conta observada no frontend é Plus; uma conta Free real continua pendente.

## Protocolo de agentes de IDE — 2026-11-06

O ChatGPT usa o serializador compartilhado em `src/routes/serialization.ts`,
com instruções de sistema, `Tools:`, `User:`, `Assistant:`, `<tool_call>` e
`Tool Response`. O envelope JSON OpenAI permanece entre cliente e proxy;
o site recebe o texto serializado, como nas demais integrações.

O primeiro teste real com ferramenta obrigatória retornou `invalid_tool_call`.
Uma consulta com escolha automática mostrou o ChatGPT respondendo que não
tinha acesso a `read_file`. Foi esclarecido na instrução compartilhada que
o cliente IDE executa as ferramentas, mantendo os mesmos marcadores e esquemas.
Também foi removida a espera de navegação após o clique de envio: a captura
da conversa determina a conclusão, inclusive quando o site muda para `/c/...`.
Falhas de interação agora identificam a etapa, sem incluir conteúdo ou tokens.

A simulação real de um cliente IDE passou no worker atualizado:

1. Requisição com `system`, `user`, definição JSON Schema de `read_file`,
   ferramenta obrigatória e streaming retornou HTTP 200 em 49,0 segundos,
   `tool_calls` com os argumentos corretos, `finish_reason: "tool_calls"` e `[DONE]`.
2. O cliente leu um arquivo temporário de teste e enviou o resultado em uma
   mensagem `role: "tool"` com o mesmo `tool_call_id`.
3. A continuação retornou HTTP 200 em 69,6 segundos, `finish_reason: "stop"`
   e o valor aleatório do arquivo: `zed-chatgpt-276da19509b8`.

Requisições, prompts calculados pelo serializador compartilhado e respostas
completas, sem credenciais, estão em `.cache/chatgpt-agent-protocol-result.json`.
Build e 21 testes de ChatGPT e compatibilidade de ferramentas passaram.
Esse teste simula um cliente IDE pela API HTTP do worker; não executa o Zed
nem valida uma chave `dsp_` pelo gateway.

## HTML real e envio por interação — 2026-11-06

O primeiro teste no worker retornou HTTP 502 após 41,9 segundos. A inspeção
autenticada identificou duas etapas do compositor atual:

- HTML inicial: `textarea#pending-home-input`, rótulo “Pergunte ao ChatGPT”.
- Após foco/hidratação: `form[data-chatgpt-composer]` contendo um
  `div[contenteditable="true"][role="textbox"]`, sem `#prompt-textarea`.
- Envio em português: botão `type="submit"` com `aria-label="Enviar"`,
  habilitado pelo frontend após preencher o editor ativo.

O adaptador agora foca o campo inicial, aguarda o editor ativo, preenche e
clica no envio; os seletores anteriores continuam aceitos. A captura observa
a requisição que o próprio frontend envia para `/backend-api/f/conversation`.
O HTML do compositor fica em `.cache/chatgpt-composer-real.html`; snapshots
locais da inspeção ficam em `.cache/chatgpt-dom-hydrated.json`.

Build e nove testes do adaptador passaram, incluindo a substituição do campo
inicial por um editor sem ID, botão de envio desabilitado até digitar e
controles antigos ocultos. O envio normal real foi validado pela rota `/v1`
em um processo de diagnóstico com cópia do perfil, retornando HTTP 200 e
`TESTE_CHATGPT_OK` em 57,7 segundos. A imagem `deepsproxy-worker:live` foi
atualizada e o worker voltou com autenticação e sessão salva confirmadas.
Esse teste não valida a autenticação por chave `dsp_` no gateway.
O teste SSE via HTTP na API autenticada do worker atualizado retornou HTTP 200,
`TESTE_CHATGPT_STREAM_OK`, quatro eventos e `[DONE]` em 49,5 segundos.

## Confirmação de login no painel — 2026-11-06

O usuário relatou ausência do botão de conclusão e status desatualizado após
entrar no ChatGPT. A inspeção do ambiente encontrou uma operação `connect`
concluída, nenhuma operação `finish` e status `login_required`, sem sessão salva.
O código servido previa o botão; a causa visual original não foi reproduzida
no navegador do usuário porque o controle do navegador foi interrompido.

O painel agora atualiza a visibilidade de **Concluir login** quando os dados
da conta mudam, mantém a confirmação manual para ChatGPT e DeepSeek quando
essa capacidade não está presente em um snapshot antigo e oferece a mesma
ação no card durante o login. A barra da tela remota não encolhe no celular.
Após concluir, a consulta de status aguarda qualquer consulta anterior e busca
um snapshot novo. Erros de confirmação continuam visíveis após desconexão VNC.

Build e 30 testes relacionados passaram. O teste de interface cobre botão
visível no celular, mudança de capacidade com a tela aberta, confirmação
recusada após desconexão e confirmação bem-sucedida com consulta antiga em
andamento. O gateway local foi atualizado e seu healthcheck passou; os perfis
dos provedores foram preservados.

Para validar a API real, concluir o login no painel e executar:

```powershell
# Fornecer DSP_API_KEY no ambiente ou salvar a chave em .cache/chatgpt-api-key.txt.
npx tsx scripts/smoke-chatgpt.ts
```

O script consulta `/v1/models`, exige `chatgpt/auto` e envia uma mensagem normal
e outra em SSE, com prazo de 120 segundos por chamada e sem reenvio automático.
Verifica os textos de teste e o marcador `[DONE]`; grava requisições sem
credenciais, respostas, status e duração em `.cache/chatgpt-live-api-result.json`.
O teste completo pelo gateway com chave `dsp_` continua pendente até haver uma
chave disponível; os envios reais direto pela rota do worker foram validados acima.

## Ambiente local atualizado

O ambiente `http://localhost:3440/` foi atualizado após a implementação.
Gateway, provisioner e egress foram reiniciados com a aplicação nova; a migração
criou duas contas ChatGPT, preservando as duas contas DeepSeek e as duas Qwen.
O backup anterior à atualização está em `.cache/before-chatgpt-20261105.dump`.

O download completo do Chromium estava lento. A imagem local do worker foi
atualizada copiando a aplicação compilada para a imagem existente, após verificar
que ambas usam Playwright 1.64.1 e Chromium v1248. O procedimento temporário está
em `.cache/chatgpt-worker-update.Dockerfile`; a imagem resultante é
`deepsproxy-worker:live`. O Dockerfile principal permanece disponível para
reconstruções completas.

A implantação identificou uma duplicação de `chatgpt.com` e `.chatgpt.com` na ACL
do Squid. A entrada foi corrigida para `.chatgpt.com`, que cobre ambos os casos,
e `squid -k parse` passou. O gateway respondeu ao healthcheck. Recarregar o
painel com Ctrl+F5 carrega o JavaScript novo e o card ChatGPT.

## Transporte observado

Foram consultados o HTML público de `https://chatgpt.com/` e seus próprios
bundles de JavaScript. As cópias temporárias ficam em `.cache/chatgpt-source`,
fora do Git. Nenhum cookie ou token dessas consultas foi incorporado ao código.

- `390575.bf3b37f322.js` e `7078.648d8d0cdc.js`: endpoint `/api/auth/session`.
- `956483.cef0e7206c.js`: requisição `/models`, preparação
  `/f/conversation/prepare`, mensagens com `author`, `content.parts` e
  `message_stream_complete`.
- `7078.648d8d0cdc.js`: transporte `/f/conversation` do frontend.
- `418851.acaf68c777.js`: `delta_encoding` v1, canais independentes e herança
  de `channel`, `path` e `op`, abreviados como `c`, `p` e `o`; `v` não herda.
  Operações observadas: add, replace, remove, append, truncate e patch.

O frontend envia a mensagem e calcula seus próprios headers. A instrumentação
clona apenas a resposta da requisição de conversa que corresponde ao prompt
ativo; ignora a preparação e as demais requisições. A leitura incremental
acontece no navegador. Tokens não são copiados para o processo Node.

O código depende dos seletores do editor, envio e menu de modelos. Esses
seletores e o formato efetivo da conta precisam ser confirmados no teste real.
Transporte diferente de fetch/SSE deve falhar explicitamente, sem reenviar a
mensagem automaticamente ou interpretar HTML de desafio como resposta.

## O que foi verificado e limitações

Validação final: `npm run build` passou. A execução completa de `npm test`
terminou com **119 testes aprovados, 2 ignorados e nenhuma falha** (121 no total).
O log local está em `.cache/chatgpt-full-final.log`. Os testes de navegador usam
perfis temporários, incluindo o novo diretório isolado de ChatGPT.

- Build TypeScript e testes de migração repetida, painel e roteamento entre
  três provedores passaram durante a implementação.
- Testes controlados cobrem snapshots, deltas, Unicode fragmentado, erros,
  ferramentas, seleção de modelo, cancelamento e geração via frontend simulado.
- A consulta HTTP pública com curl permitiu ler os bundles; a tentativa com
  urllib retornou HTTP 403. Isso não foi interpretado como bloqueio de conta.
- A navegação pública com Playwright não apresentou controles utilizáveis.
  Não foi realizada autenticação nem geração real nessa tentativa.
- O catálogo pode ficar vazio quando o menu não confirmar a disponibilidade
  do modelo. Não há fallback para IDs da API OpenAI.
- `chatgpt/auto` representa o modo automático/default do site quando disponível.
  Nenhum modelo subjacente específico é prometido nesse modo.
- Não há suporte a arquivos, imagens, voz, raciocínio privado ou intensidades
  artificiais de raciocínio. Ferramentas continuam executadas pelo cliente.

## Validação manual pendente

Nos testes controlados, a passagem pela API `/v1` também confirmou resposta
normal, SSE e preservação do resultado de ferramenta no histórico. O teste de
painel cobre os três provedores, confirmação manual do ChatGPT e indicação de
limite de uso com sessão salva. A revisão visual do painel móvel não encontrou
estouro horizontal.

Durante a implementação, o teste pela API identificou que um editor rico pode
normalizar parágrafos vazios antes do envio. A correlação da captura passou a
comparar o texto com normalização de espaços, sem reescrever a mensagem enviada.
Também foram corrigidos a reutilização do navegador após confirmar o login e
o encerramento da requisição quando o cliente cancela sem consumir a resposta.

### Roteiro na conta real

1. Atualizar as imagens de aplicação, worker e egress no ambiente de teste.
2. No card ChatGPT, conectar e autenticar manualmente uma conta Free.
3. Tentar concluir antes de autenticar e verificar que o navegador de login
   continua disponível; depois concluir com a conta autenticada.
4. Consultar `/v1/models`; enviar texto normal e streaming para `chatgpt/auto`.
5. Fazer um ciclo de ferramenta: chamada, execução pelo cliente e resposta
   com o resultado incluído no histórico.
6. Cancelar uma geração e verificar a liberação da fila; reiniciar o worker e
   confirmar que a sessão permanece válida.
7. Se houver limite de uso, verificar a indicação separada de login ativo e
   limite, com prazo de retomada quando o site o informar.

Registrar aqui os resultados e ajustes observados antes de afirmar que a
integração está validada em uma conta real. Este roteiro original antecede a
validação autenticada de 2026-11-06 descrita no início deste documento.
