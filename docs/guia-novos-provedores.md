# Guia para integrar novos sites ao Proxy IA

Este guia orienta a inclusão de um site de chat no proxy, desde a inspeção do
frontend até a validação com agentes de IDE. Ele documenta o processo usado nas
integrações DeepSeek, Qwen e ChatGPT. Os detalhes de cada site devem ser
confirmados novamente: seletores, endpoints e modelos podem mudar.

Nos exemplos, `novo` é o identificador do provedor a implementar. Substitua-o
pelo identificador definitivo antes de executar comandos ou escrever código.

## 1. Entenda o caminho existente

```text
IDE / cliente OpenAI compatível
  → gateway /v1: chave dsp_, usuário, conta, fila e roteamento por modelo
  → API autenticada do worker da conta
  → preparo compartilhado do histórico e das ferramentas
  → adaptador do site: autenticação, navegador, transporte e decodificação
  → ProviderEvent
  → parser compartilhado: resposta OpenAI ou SSE para o cliente
```

Cada worker pertence a uma conta/provedor, com perfil e rede próprios. O modo
local executa um provedor por processo; o gateway multiusuário encaminha cada
modelo para a conta correspondente do usuário autenticado.

Reutilize o que já existe. O adaptador recebe o prompt preparado e devolve
eventos do provedor; ele não deve recriar a serialização das IDEs, o resumo de
contexto ou o protocolo de ferramentas.

| Responsabilidade | Referência no projeto |
| --- | --- |
| Contrato do adaptador, eventos, modelos e status | [types.ts](../src/providers/types.ts) |
| Identificação e criação dos adaptadores | `src/providers/catalog.ts` e `src/providers/registry.ts` |
| Histórico, orçamento de contexto e orquestração | `src/routes/chat.ts`, `src/utils/context-summary.ts` e `src/utils/compression.ts` |
| Mensagens OpenAI → prompt para o site | [serialization.ts](../src/routes/serialization.ts) |
| Eventos do provedor → resposta OpenAI e ferramentas | `src/routes/stream.ts` e `src/routes/tool-parser.ts` |
| Sessão e exclusividade do perfil | `src/services/session-store.ts` |
| Fila de geração, bloqueios, pausas e cancelamento | `src/services/generation-guard.ts` e `src/services/action-pacing.ts` |
| Navegador e login manual | `src/services/browser.ts` e `src/services/interactive-browser.ts` |
| Contas, API pública, workers e painel | `src/production/` e `public/panel.js` |

## 2. Inspecione o site autenticado antes de implementar

Comece com uma conta de teste e execute manualmente o fluxo completo: abrir o
chat, entrar, iniciar uma conversa, escrever, enviar, receber, parar a geração
e selecionar um modelo. Registre data, idioma, plano da conta e comportamento
observado. Uma página pública ou um frontend simulado não comprova o fluxo
autenticado.

Capture o HTML relevante ao compositor e aos controles, não apenas a página
inicial. Compare estes momentos:

1. HTML inicial, antes da inicialização do JavaScript.
2. Campo após receber foco e após a hidratação do frontend.
3. Campo preenchido, quando o botão de envio fica habilitado.
4. Geração em andamento, botão de parada e resposta concluída.
5. Menu de modelos e eventuais avisos de limite de uso.

Registre `role`, `aria-label`, `contenteditable`, `data-testid`, tipo do botão,
visibilidade, estado habilitado e formulário associado. Prefira seletores
semânticos e escopados ao compositor; classes geradas e IDs transitórios são
frágeis. Considere idiomas e variantes realmente observados na interface.

O ChatGPT, por exemplo, apresentou um `textarea#pending-home-input` inicial.
Após foco, o frontend o substituiu por um `div[contenteditable="true"]` com
`role="textbox"`, sem o ID antigo, dentro de `form[data-chatgpt-composer]`.
O envio passou a ser um botão `type="submit"` com `aria-label="Enviar"`.
Esperar apenas o seletor antigo impedia o envio, embora o login estivesse válido.

Depois da substituição de um elemento, obtenha novamente o editor ativo antes
de preencher. Verifique controles visíveis e editáveis; um elemento oculto
compatível com um seletor antigo não deve ganhar prioridade.

### Observe a rede junto com o HTML

Identifique qual ação dispara a conversa e qual requisição contém o prompt.
Separe preparação, autenticação, catálogo, telemetria e geração. Registre método,
caminho, tipo da resposta e exemplos sanitizados de eventos. Observe também
mudanças de URL após o envio e o sinal confiável de conclusão.

Quando o frontend já prepara headers, desafios e requisições, prefira operar
seus controles e capturar a resposta da conversa correspondente. Outros
transportes podem usar o padrão de requisição pelo contexto do navegador já
empregado pelo projeto, desde que isso seja confirmado para o novo site.
Não presuma que o protocolo de outro provedor seja intercambiável.

Correlacione a captura com o prompt ativo. Não capture uma requisição de
preparação ou outra conversa por coincidência de URL. Se o editor normalizar
espaços, normalize apenas a comparação de correlação, preservando o texto enviado.

Um título como “Um momento…” ou HTML de desafio não representa uma resposta
do modelo. Uma inspeção headless que encontra um desafio não prova que o
navegador autenticado usado pelo worker esteja no mesmo estado. Não automatize
a resolução de CAPTCHA; mantenha a etapa humana no fluxo de login.

### Preserve o ambiente durante a inspeção

Use `.cache/` para evidências locais e mantenha cookies, tokens, perfis e
conteúdo privado fora do Git e dos logs. Não inclua scripts de hidratação com
dados de autenticação em fixtures; extraia um HTML mínimo sanitizado.

Não abra dois donos do mesmo perfil. Uma inspeção isolada pode usar uma cópia
do perfil, sem escrever no original, mantendo sandbox e proxy de saída.
Considere limites de memória, processos e CPU antes de abrir outro navegador
no worker. Remova os recursos temporários ao terminar, preservando o volume da conta.

## 3. Implemente o adaptador dentro do contrato comum

Crie `src/providers/novo.ts`. Separe transporte/instrumentação e decodificação
em arquivos próprios quando isso permitir testar o protocolo sem acessar o site.
A interface canônica é `ProviderAdapter`, em `src/providers/types.ts`.

| Método | Comportamento esperado |
| --- | --- |
| `initialize` | Inicializar uma vez, reutilizar o navegador ativo e restaurar a sessão apropriada. |
| `connect` | Abrir o fluxo de autenticação do site. |
| `confirmLogin` | Verificar autenticação real; não considerar só a existência de arquivos do perfil. |
| `finishLogin`, quando necessário | Encerrar a etapa humana, validar e salvar a sessão; preservar a possibilidade de tentar novamente em caso de falha. |
| `status` | Informar estado da conta, autenticação, sessão salva e instante da verificação. |
| `models` | Anunciar somente modelos disponíveis e selecionáveis para a conta. |
| `generate` | Receber o prompt preparado, respeitar `AbortSignal` e devolver `AsyncIterable<ProviderEvent>`. |
| `close` | Cancelar recursos ativos e liberar o navegador e o perfil. |
| `getActivePage` / `isReady` | Permitir que o worker e seu healthcheck identifiquem o navegador disponível. |

### Autenticação e persistência

Use `createSessionStore` e o bloqueio do perfil. `PROVIDER_PROFILE_DIR` tem
precedência sobre o diretório específico do provedor; no worker, o perfil fica
em `/profile`. No desenvolvimento, use um diretório exclusivo e inclua-o em
`.gitignore` e `.dockerignore`.

Use a evidência de autenticação do próprio site. Um editor visível pode também
existir para visitantes; um snapshot salvo pode estar expirado. Evite trazer
tokens para Node quando a validação puder devolver apenas um resultado booleano
a partir do navegador.

No login manual, não deixe o navegador humano e a automação escreverem no
perfil ao mesmo tempo. Aguarde o encerramento e a gravação do perfil antes da
transição. Preserve o marcador de login interativo para não restaurar um
snapshot antigo sobre um perfil recém-autenticado. Mantenha compatíveis as
opções de armazenamento, idioma e chaveiro dos dois navegadores.

Para fluxos com confirmação, marque a capacidade `manualLoginConfirmation` e
mostre **Concluir login** no painel. Só encerre a etapa remota após confirmar
autenticação e sessão salva. Tentativas antecipadas devem apresentar erro e
permitir continuar o login. Após sucesso, force uma consulta nova de status,
mesmo se uma consulta periódica anterior ainda estiver em andamento.

Separe autenticação de disponibilidade: uma conta pode estar autenticada e
com sessão salva, mas limitada ou suspensa. Um 429 não deve apagar o login;
uma autenticação bem-sucedida não deve limpar uma suspensão conhecida.

### Modelos e recursos anunciados

Use IDs com namespace, como `novo/<id-observado>`, preservando os IDs existentes
dos outros provedores. Consulte o catálogo da conta e o menu real. Um catálogo
de API comercial não comprova a disponibilidade do mesmo modelo no site.

Se houver `novo/auto`, documente que significa a seleção padrão do site, sem
prometer um modelo subjacente específico. Uma seleção explícita indisponível
deve falhar, em vez de trocar silenciosamente de modelo.

Quando a janela de contexto não for conhecida, use a convenção existente de
`contextLength: 0` e origem `unknown`; o preparo usa o orçamento compartilhado.
Não invente contexto, limite de saída, suporte multimodal ou intensidades de
raciocínio. Rejeite recursos não suportados na fronteira da API.

### Geração, decodificação e cancelamento

Use `GenerationGuard`, as pausas comuns e a exclusividade da página. A posse
da geração deve cobrir captura, envio, leitura completa e limpeza. O cancelamento
do cliente precisa parar a geração/captura e liberar a fila, inclusive se ele
não consumir o corpo da resposta.

O decoder específico do site deve emitir os tipos existentes de `ProviderEvent`:
conteúdo, raciocínio quando efetivamente disponibilizado, uso e finalização.
Não exponha raciocínio privado nem implemente um segundo emissor OpenAI dentro
do adaptador.

Teste snapshots cumulativos, deltas e seus canais, Unicode fragmentado,
fim de stream, erros e dados malformados. Não duplique texto ao receber snapshots
sucessivos e não misture canais ou mensagens internas com a resposta final.

Quando o clique de envio iniciar navegação, não trate o carregamento da nova
URL como conclusão da geração. No caso confirmado do ChatGPT, o clique usa
`noWaitAfter: true` e a captura determina o fim da resposta. Aplique isso somente
com captura e ciclo de vida adequados ao novo site.

Registre a etapa de uma falha, sem incluir o prompt em mensagens de erro.
Um timeout após o clique pode ocorrer depois do envio real: confira a rede
antes de tentar novamente. Não reenvie automaticamente uma mensagem cujo
despacho já possa ter ocorrido. Respeite `Retry-After` e os bloqueios persistidos.

## 4. Registre o provedor em todas as camadas

Adicionar uma classe não basta. Revise os pontos abaixo e atualize os testes
correspondentes. Uma busca pelas identidades atuais ajuda a encontrar listas
fechadas e condicionais específicas:

```powershell
rg -n 'deepseek|qwen|chatgpt|ProviderId|manualLoginConfirmation' src public deploy scripts .env.example .gitignore .dockerignore
```

| Área | O que revisar |
| --- | --- |
| Identidade e roteamento | `ProviderId`, validação de `PROVIDER`, resolução do prefixo do modelo e factory do registro. |
| Banco de dados | Restrição de provedor, lista de provedores, `ensureAccounts` e criação de conta para usuários existentes e novos. |
| Migração | Nova etapa compatível com o esquema atual, reaplicação segura e preservação de contas, IDs, chaves e estados anteriores. |
| Provisionamento | Lista de provedores aceitos, proprietário, conta, labels e contrato de compatibilidade do worker. Não reutilizar a identidade especial legada do DeepSeek para o novo provedor. |
| Gateway e painel | Nome, card, status, catálogo, login manual/automático, confirmação, recuperação e desconexão da conta correta. |
| Perfil e testes | Diretório padrão, variáveis de ambiente, arquivos ignorados e isolamento em `scripts/test.js`. |
| Erros e diagnóstico | Nomes, URLs de ajuda, códigos por provedor, categorias e listas de sanitização em logs. |
| API e capacidades | Documentação OpenAPI, validação de entrada e limites reais do adaptador. |
| Backup/restauração | Manifesto com conta, usuário e provedor; validação do novo identificador na restauração. |
| Rede e imagens | Domínios observados, políticas do navegador e imagens runtime, worker e egress afetadas. |

No Squid, acrescente somente destinos observados que sejam necessários ao
fluxo. Diferencie uma dependência necessária de uma requisição opcional de
telemetria. Mantenha o bloqueio de destinos privados e a rede interna de cada
conta. Verifique ACLs redundantes: `.example.invalid` já abrange o domínio base
e seus subdomínios; esse endereço é apenas um exemplo, não um destino a liberar.
Valide a configuração com `squid -k parse` na imagem/container correspondente.

As migrações e a restauração devem continuar aceitando os provedores antigos.
Teste com pelo menos dois usuários e dois provedores, garantindo que conectar,
recuperar ou desconectar uma conta não altere as outras.

## 5. Preserve o padrão dos agentes de IDE

Existem dois formatos, em camadas diferentes:

- **IDE ↔ proxy:** JSON compatível com OpenAI, com `messages`, `tools`,
  `tool_choice`, respostas `choices` e, em streaming, deltas SSE.
- **Proxy ↔ site:** prompt textual produzido pelo serializador compartilhado.
  O site não precisa receber o envelope JSON completo da IDE.

O padrão textual já existe em `src/routes/serialization.ts`:

```text
[instruções de sistema recebidas do cliente]
Tools: [definições de ferramentas em JSON compacto]
[instruções compartilhadas para solicitar execução pelo cliente IDE]
User: pedido do usuário
Assistant: <tool_call>{"name":"read_file","arguments":{"path":"arquivo-teste.txt"}}</tool_call>
Tool Response (call_exemplo): resultado da leitura
```

Os blocos acima ilustram um histórico com ferramenta. Na primeira requisição,
as linhas de chamada anterior e resultado ainda não existem. Sem `tools` na
requisição, o serializador não acrescenta um catálogo de ferramentas. Isso
explica por que um teste de pergunta simples não demonstra o protocolo completo.

Use `serializeOpenAIMessages` e `appendToolInstructions` pelo fluxo de
`src/routes/chat.ts`. Preserve instruções de sistema, histórico útil, chamadas
anteriores e resultados; não reintroduza raciocínio anterior do assistente.
O parser compartilhado converte `<tool_call>` em `message.tool_calls` ou
`delta.tool_calls`, aplica `tool_choice` e define `finish_reason: "tool_calls"`.

O **cliente** executa a ferramenta. O site deve solicitar sua execução no
formato existente e esperar o resultado. Se responder que não dispõe de uma
ferramenta da IDE, confira o prompt serializado e essa distinção antes de
modificar o parser. No ChatGPT, foi necessário esclarecer essa responsabilidade
na instrução comum, mantendo os mesmos marcadores e esquemas.

## 6. Valide em camadas, incluindo um ciclo real de ferramenta

### Testes automatizados

Use perfis temporários. Ao registrar o provedor, acrescente o diretório de
teste em `scripts/test.js`; não execute testes sobre a sessão real.

| Camada | Casos mínimos |
| --- | --- |
| Protocolo | Unicode e SSE fragmentados, snapshots/deltas, finalização, erros e conteúdo inválido. |
| Frontend controlado | Campo inicial substituído após foco, editor ativo sem ID, controles antigos ocultos, envio habilitado após digitar e captura da conversa certa. |
| Autenticação | Confirmação antecipada recusada, login válido salvo, transição de navegador, expiração e reutilização do perfil. |
| Orquestração | Cancelamento antes/depois do envio, consumidor que não lê o corpo, fila liberada e ausência de reenvio indevido. |
| Ferramentas | Prompt comum efetivamente recebido pelo frontend, argumentos preservados, escolha obrigatória/proibida e erros estruturados para chamadas inválidas. |
| Produção/painel | Migração repetida, isolamento de usuário/provedor, confirmação visível em desktop e celular, status atualizado e erro visível após desconexão remota. |

Após criar `src/novo.test.ts`, execute os testes pertinentes e a suíte exigida
pelo projeto. Exemplos a partir da raiz:

```powershell
npm run build
node scripts/test.js src/novo.test.ts src/provider-migration.test.ts src/production.test.ts src/production-ui.test.ts src/tool-compatibility.test.ts
npm test
```

### Ambiente e envio reais

Suba o laboratório com `npm run live` e abra `http://localhost:3440`. Autentique
a conta no painel e conclua o login, quando exigido. Confirme estado conectado,
sessão salva e presença do modelo em `GET /v1/models`.

Envie uma mensagem normal e outra com `stream: true`. Verifique status HTTP,
texto, campos OpenAI, deltas válidos, finalização e `[DONE]`. Não considere
somente HTTP 200: um stream pode conter um evento de erro após abrir a resposta.

Depois simule um cliente IDE usando o mesmo endpoint e serializador. Exemplo
de primeira requisição a `POST /v1/chat/completions`:

```json
{
  "model": "novo/<modelo-anunciado>",
  "stream": true,
  "messages": [
    {"role": "system", "content": "Você é um agente de IDE. Solicite a leitura pela ferramenta fornecida. Após receber o resultado, responda com o valor de TEST_VALUE, sem inventá-lo."},
    {"role": "user", "content": "Leia arquivo-teste.txt e informe TEST_VALUE."}
  ],
  "tools": [{
    "type": "function",
    "function": {
      "name": "read_file",
      "description": "Lê um arquivo disponibilizado pelo cliente IDE.",
      "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string", "enum": ["arquivo-teste.txt"]}},
        "required": ["path"],
        "additionalProperties": false
      }
    }
  }],
  "tool_choice": {"type": "function", "function": {"name": "read_file"}}
}
```

O roteiro completo é:

1. Crie no cliente um arquivo de teste com `TEST_VALUE` aleatório. Não inclua
   esse valor na primeira requisição.
2. Envie a requisição e reconstrua os deltas de `tool_calls`. Verifique nome,
   argumentos, ID, `finish_reason: "tool_calls"` e `[DONE]`.
3. Execute no cliente apenas a leitura esperada, validando o caminho do arquivo.
4. Reenvie o histórico original e acrescente a mensagem do assistente com
   `tool_calls` e a mensagem `role: "tool"` com o resultado. Use exatamente o
   `tool_call_id` recebido, sem criar outro ID.
5. Na continuação, use `tool_choice: "none"` e `stream: false`. Verifique
   `choices[0].message.content`, `finish_reason: "stop"` e o valor aleatório
   lido, demonstrando que o resultado da ferramenta foi preservado.
6. Faça também as variações sem streaming na chamada e com streaming na
   continuação, além de `tool_choice: "auto"` e ferramentas inválidas.

Envie chamadas sequencialmente e mantenha os prazos e pausas normais da
integração. Em scripts PowerShell, preserve UTF-8 ao transmitir mensagens por
stdin; não interprete uma saudação corrompida por encoding como erro do modelo.

### Declare exatamente o que foi testado

| Evidência | O que comprova |
| --- | --- |
| Fixture e testes unitários | Comportamento sob o HTML/protocolo simulado. |
| API HTTP autenticada do worker com site real | Adaptador, serialização comum e respostas reais. |
| Gateway `/v1` com chave `dsp_` | Também autenticação pública, usuário, roteamento, conta e fila do gateway. |
| Zed/Continue configurado e usado de fato | Compatibilidade com a requisição e o comportamento desse cliente específico. |

Uma simulação de cliente IDE não é um teste do aplicativo Zed. Uma conta Plus
não valida uma conta Free. Um teste de texto não valida ferramentas. Registre
essas diferenças e mantenha pendentes as camadas que não foram executadas.

## 7. Publique e mantenha evidências úteis

Antes de aplicar migrações ou recriar componentes, faça backup do banco e dos
perfis conforme o [guia de produção](../deploy/README.md). Perfis devem ser
copiados com seus navegadores parados. Não use comandos que removam volumes
para atualizar a aplicação.

Reconstrua as imagens afetadas e recrie os componentes necessários. Atualizar
apenas o gateway não atualiza o código dos workers já existentes. Preserve os
perfis, recrie os workers com a imagem correta e confira healthcheck, sessão e
catálogo após a troca. Se houver atualização do egress, valide também sua ACL.

Uma cópia temporária do JavaScript compilado para uma imagem existente exige
compatibilidade verificada entre dependências, Playwright e Chromium. Registre
o procedimento; ele não substitui o Dockerfile oficial como caminho de build.

Registre em `docs/<provedor>-integration.md`:

- Site, data, idioma, plano da conta, modelos observados e recursos suportados.
- Evidências de HTML e transporte, diferenças entre variantes e critérios de login.
- Componentes alterados, migração, imagens aplicadas e preservação dos perfis.
- Comandos executados, resultados de testes e limitações ainda abertas.
- No teste real: requisição sanitizada, resposta efetiva, status HTTP, duração,
  finalização SSE e ciclo de ferramenta, indicando por qual camada passou.

Não registre credenciais, dados reais do usuário ou snapshots de perfil no
commit. Use dados sintéticos nos exemplos. As evidências privadas ficam fora
do Git; o documento versionado deve explicar o resultado sem depender delas.

Antes do commit, revise o diff e os arquivos staged. Inclua somente os arquivos
da tarefa e mantenha mudanças preexistentes fora do commit quando não fizerem
parte da entrega. Um guia ou teste aprovado não deve afirmar que toda a
integração está validada se ainda falta passar pelo gateway ou pelo cliente IDE.
