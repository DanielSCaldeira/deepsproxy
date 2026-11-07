# Plano: centralizar APIs oficiais no Proxy IA

Pesquisa em 2026-11-07. Status: planejamento; nenhuma integração nova implementada,
chave criada ou chamada autenticada executada nesta etapa.

Decisão posterior do usuário: somente modelos gratuitos, sem habilitação paga.
A API oficial paga DeepSeek fica fora da entrega. O registro da implementação
e os procedimentos atuais estão em [apis-gratuitas.md](apis-gratuitas.md);
as opções pagas discutidas abaixo são apenas o levantamento original.

## 1. O que pode ser usado gratuitamente

| Opção | Resultado da pesquisa | Decisão |
| --- | --- | --- |
| DeepSeek Web | O projeto já possui o adaptador `deepseek`, com sessão de navegador. Isso não concede acesso gratuito à API oficial. | Preservar o fluxo atual e identificá-lo como conexão web. |
| DeepSeek API oficial | A documentação publica cobrança por tokens de entrada e saída. Eventuais promoções não constituem um plano gratuito permanente. | Opcional, separado como `deepseek-api`, desativado no modo somente gratuito. |
| NVIDIA API Catalog | O catálogo oferece APIs serverless gratuitas para desenvolvimento e identifica modelos como `Free Endpoint`. Nem todo modelo listado possui endpoint gratuito ativo. | Adicionar `nvidia` usando a API hospedada, sem baixar NIM nem executar GPU local. |
| OpenRouter | Variantes `:free` podem ser usadas sem comprar créditos. Outros modelos de preço zero podem exigir conta com saldo. | Adicionar `openrouter`, priorizando variantes `:free` e o roteador gratuito. |

O OpenRouter informa 20 requisições/minuto e 50/dia para variantes gratuitas,
com aumento para 1.000/dia após compra de US$ 10 em créditos. Tentativas com
falha também contam. A compra é opcional e não faz parte do caminho sem gastos.
Consultar a cota efetiva por `GET /api/v1/key`; não tratar esses números como
garantia permanente nem multiplicar chaves para tentar aumentar a cota.

Na NVIDIA, não fixar promessas de créditos, RPM ou gratuidade ilimitada:
confirmar os termos e a disponibilidade do endpoint escolhido. O acesso
gratuito de desenvolvimento não deve ser apresentado como SLA de produção.
Exemplo da importância do catálogo atualizado: a página antiga de DeepSeek R1
consultada já marca seu Free Endpoint como Deprecated.

Fontes oficiais:

- [DeepSeek: primeira chamada](https://api-docs.deepseek.com/).
- [DeepSeek: preços por tokens](https://api-docs.deepseek.com/quick_start/pricing/?model_version=DeepSeek-V4-Pro-0813).
- [NVIDIA: catálogo e Free Endpoints](https://build.nvidia.com/explore/discover).
- [NVIDIA: acesso gratuito para prototipação e criação de chave](https://forums.developer.nvidia.com/t/nvidia-nim-faq/300317).
- [NVIDIA: exemplo oficial de API hospedada e troca de chave](https://docs.nvidia.com/nemo/microservices/25.4.0/troubleshooting/guardrails.html).
- [NVIDIA: R1 com endpoint gratuito descontinuado](https://build.nvidia.com/deepseek-ai/deepseek-r1).
- [OpenRouter: modelos gratuitos e cotas](https://openrouter.ai/collections/free-models).
- [OpenRouter: limites e consulta da chave](https://openrouter.ai/docs/api_reference/limits).
- [OpenRouter: autenticação](https://openrouter.ai/docs/api_reference/authentication).
- [OpenRouter: contrato Chat Completions](https://openrouter.ai/docs/api_reference/overview).
- [OpenRouter: seleção automática gratuita](https://openrouter.ai/openrouter/free).

## 2. O que o usuário precisa fazer para obter as chaves

### OpenRouter — primeira integração recomendada

1. Criar conta em [openrouter.ai](https://openrouter.ai/).
2. Abrir [API Keys](https://openrouter.ai/keys), selecionar criação de chave
   e dar um nome, por exemplo `Proxy IA`.
3. Copiar a chave exibida e guardá-la em um gerenciador de senhas.
4. Para o uso sem gastos, não é necessário comprar créditos. Escolher variantes
   `:free` na [lista de modelos](https://openrouter.ai/collections/free-models).
5. Quando a integração estiver pronta, colar a chave no card OpenRouter do
   painel e usar **Validar chave**. Manter **Somente gratuitos** ativado.

Uma chave atende vários modelos. Limite de crédito da chave não é saldo
oferecido gratuitamente: a proteção principal no Proxy IA será a restrição
dos modelos e recursos que podem gerar cobrança.

### NVIDIA — API hospedada

1. Criar conta/entrar em [build.nvidia.com](https://build.nvidia.com/).
2. Concluir a adesão ao NVIDIA Developer Program e as verificações que a
   plataforma solicitar, se aparecerem no cadastro.
3. Escolher um modelo com **Free Endpoint** ativo. Na área de uso da API,
   selecionar **Get API Key** e gerar a chave para os endpoints hospedados.
   A gestão também é acessível em
   [API Keys](https://build.nvidia.com/settings/api-keys).
4. Conferir permissões e expiração apresentadas na criação e copiar a chave.
   Usar a chave da API hospedada, sem seguir o fluxo NGC de download de imagens.
5. Quando a integração estiver pronta, informar a chave no card NVIDIA e
   validar com uma geração curta em modelo gratuito selecionado.

Se aparecer 401/403, verificar chave, expiração e acesso ao endpoint. Consultar
o exemplo da API na página atual do modelo. Listar modelos com sucesso, sozinho,
não comprova permissão para gerar respostas. Nenhuma GPU local será necessária.

### DeepSeek oficial — somente se quiser acesso pago

1. Entrar em [platform.deepseek.com](https://platform.deepseek.com/).
2. Abrir a área de API Keys e criar uma chave.
3. Verificar saldo, preços e eventual crédito promocional no painel antes de usar.
4. Cadastrar futuramente em **DeepSeek API**, distinto do card DeepSeek Web.

Não é preciso criar essa chave para continuar usando a conexão web existente.
As chaves dos provedores serão cadastradas apenas no painel privado; o cliente
de IDE continuará usando a chave `dsp_` emitida pelo Proxy IA.

## 3. Arquitetura proposta

O projeto é TypeScript/Hono, com gateway multiusuário, PostgreSQL e workers de
navegador. Hoje `ProviderAdapter.generate()` recebe um prompt textual;
`src/routes/chat.ts` serializa mensagens e acrescenta instruções de ferramentas.
`ProviderEvent` não representa deltas nativos de `tool_calls`. Assim, simplesmente
adicionar três classes ao registro atual perderia recursos das APIs oficiais.

Introduzir dois tipos de conexão explícitos: `web_session` e `api_key`.
Reaproveitar autenticação pública, usuários, chave `dsp_`, painel e autorização;
adicionar um serviço de transporte HTTP para conexões API, chamado pelo gateway.
As conexões web continuam no caminho dos workers atuais.

Fluxo proposto:

```text
IDE → /v1 + dsp_ → autenticação/usuário → catálogo autorizado → modelo
  → web_session → fila + worker atual → chat web
  → api_key → política de custo + limite por conta → transporte HTTP → API oficial
```

O serviço HTTP deve operar dentro da política de rede de produção: liberar
somente os hosts oficiais necessários na saída do serviço responsável. Não
provisionar Chromium/noVNC para credenciais API, nem consumir vagas de
`MAX_ACTIVE_BROWSERS`. Validar a conectividade real no Compose antes da entrega.

| Provedor novo | Base URL | ID público no Proxy IA |
| --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/<id-original>` |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `nvidia/<id-original>` |
| `deepseek-api` | `https://api.deepseek.com` | `deepseek-api/<id-original>` |

Enviar `POST <base>/chat/completions`; remover apenas o primeiro namespace ao
encaminhar. Exemplo: `openrouter/openrouter/free` envia `openrouter/free`.
Os exemplos são convenções propostas, não modelos já disponíveis no projeto.
Não reutilizar IDs DeepSeek web para a API, pois o mesmo nome não garante a
mesma versão, contexto ou recursos.

O transporte HTTP preservará `messages`, papéis, `tool_calls`, `tool_call_id`,
`tools`, `tool_choice`, parâmetros suportados, respostas JSON e SSE. Não enviar
esses pedidos para o serializador textual, parser Hermes/DSML ou telemetria
estimada do navegador. Preservar `usage` nativo quando disponível e declarar
ausência quando não houver. Validar parâmetros e capacidades por modelo;
normalizar diferenças de reasoning sem prometer comportamento uniforme.

MVP: texto, ferramentas nativas e streaming. Imagens, áudio, arquivos,
embeddings e a rota Responses ficam fora desta primeira entrega, mesmo quando
um provedor os oferece. Rejeitar entradas incompatíveis de forma explícita.
Não resumir automaticamente histórico com chamadas adicionais no MVP; validar
contexto e informar excesso, preservando o custo e a previsibilidade.

## 4. Credenciais e isolamento entre usuários

- Criar uma tabela `provider_credentials` vinculada a `provider_accounts`,
  mantendo uma conexão por usuário/provedor no MVP, conforme a restrição atual.
- Guardar a chave cifrada com AES-256-GCM, nonce exclusivo, tag e versão da
  chave mestra; associar usuário/conta/provedor como dados autenticados.
  A chave precisa ser recuperável para chamar o upstream: hash não basta.
- Introduzir segredo de cifragem dedicado, separado do `WORKER_MASTER_SECRET`,
  fora do banco e do Git; documentar backup e rotação. Nunca iniciar com chave
  mestra ausente quando houver conexões API habilitadas.
- Expor somente prefixo mascarado, estado, última validação e expiração conhecida.
  Não devolver a chave completa após cadastro, nem incluí-la em logs, URLs,
  localStorage, auditoria ou mensagens de erro.
- Proteger cadastro/alteração/exclusão com sessão, CSRF e propriedade da conta.
  Chaves upstream não poderão ser fornecidas pelo cliente público em `/v1`.
- Troca/exclusão invalida caches e cancela requisições da conexão. Excluir no
  Proxy IA não revoga a chave no provedor; mostrar link para revogação externa.
- Fixar endpoints por provedor e bloquear redirecionamentos para outros hosts.
  Não oferecer URL arbitrária neste MVP.

## 5. Catálogo, custo e limites

**OpenRouter:** consultar `/models`, recursos e preços atuais com cache curto
(proposta: 5 minutos). No modo gratuito, permitir inicialmente variantes `:free`
com custos aplicáveis iguais a zero e o `openrouter/free` documentado. Outros
modelos de preço zero, que podem exigir saldo, ficam para uma etapa posterior.
Desabilitar plugins pagos, ferramentas de servidor, fallback pago e parâmetros
que contornem a seleção permitida. Preço desconhecido ou cache vencido sem
possibilidade de atualização bloqueia novo envio no modo gratuito.

`openrouter/free` escolhe entre modelos disponíveis; não promete DeepSeek nem
identidade estável. Para tarefas que exigem modelo fixo, selecionar ID explícito.
Só oferecer um DeepSeek gratuito se ele constar no catálogo vigente.

**NVIDIA:** cruzar `/models` com uma allowlist mantida a partir dos Free Endpoints
oficiais ativos, registrando fonte e data. Não presumir que `/models` informa
preço, contexto ou suporte a ferramentas. Confirmar recursos na documentação de
cada endpoint e removê-lo da seleção quando descontinuado. Onde não houver
metadados estruturados, usar manutenção explícita, sem scraping em cada chamada.

**DeepSeek API:** habilitação paga explícita, separada do modo gratuito.
Consultar o catálogo oficial e aplicar os recursos documentados por modelo.

Publicar em `/v1/models` somente conexões habilitadas do usuário e modelos
permitidos pela política. Guardar origem/data dos metadados; contexto e limite
desconhecidos não devem ser inventados. Conferir novamente a política no envio.

Criar controle de concorrência/cooldown por conta API, independente do mutex e
das pausas de navegador. Honrar `Retry-After`, tratar 401, 403, 402, 429, 5xx,
timeout e cancelamento separadamente. Uma cota esgotada não apaga a chave.
Não repetir geração após início da saída SSE; limitar novas tentativas antes
da saída para evitar consumo excessivo de cotas e duplicação de cobranças.
Nunca trocar provedor ou modelo sem configuração explícita do usuário.

O painel mostrará **Configurar chave**, **Validar**, **Atualizar modelos**,
**Substituir chave**, **Remover** e **Como obter chave**, com rótulos claros:
gratuito com limites, desenvolvimento ou pago. Cota restante somente quando
informada pelo upstream; estimativas locais serão identificadas como estimativas.
O teste de geração será explícito, curto e consumirá a cota da conta.

## 6. Roteiro executável

| Etapa | Trabalho e arquivos previstos | Critério de conclusão |
| --- | --- | --- |
| 1 — contratos | Criar registro comum de conexões web/API e tipos de catálogo; revisar `src/providers/types.ts`, `catalog.ts`, `registry.ts`, `src/production/database.ts` e dependências do provisionamento. | Todos os provedores existentes continuam roteados como web; nenhum API exige navegador. |
| 2 — credenciais | Migração aditiva, serviço de cifragem e configuração em `src/production/config.ts`, rotas privadas em `gateway.ts`, exemplos de ambiente sem valores reais. | Cadastro, atualização, exclusão e reinício preservam isolamento e sigilo; backup/rotação documentados. |
| 3 — transporte | Criar `src/api-providers/` com cliente HTTP, catálogo, política de custo e contratos próprios; integrar o ramo API de `gateway.ts`. | JSON, SSE, cancelamento e ferramentas preservados sem serialização textual; saída de rede funcional no Compose. |
| 4 — OpenRouter | Implementar adaptador, consulta de limites e política somente gratuitos. | Chave sem créditos permite teste em variante disponível; modelos/recursos pagos são recusados. |
| 5 — painel | Alterar `public/panel.js` e `src/production/panel.ts`; incluir guias e estados das conexões API. | Usuário conecta a API e usa a mesma URL `/v1` e chave `dsp_`; a criação de `dsp_` aceita uma conexão API válida. |
| 6 — NVIDIA | Implementar adaptador e catálogo verificado de endpoints hospedados gratuitos. | Geração curta passa com chave real; endpoint listado sem acesso não aparece como validado; nenhum browser é iniciado. |
| 7 — DeepSeek API opcional | Adaptador oficial, catálogo e consentimento de uso pago. | Modelo tem namespace separado; modo gratuito impede seu envio. Pode ser entregue depois do MVP. |
| 8 — entrega | Testes, README, guias de operação e smoke tests via gateway com `dsp_`. | Evidências distinguem mocks, conta real e cliente IDE; rollback e pendências documentados. |

Ordem recomendada: base compartilhada → OpenRouter e painel → NVIDIA →
DeepSeek API opcional. O adaptador DeepSeek Web já cobre a primeira opção
citada pelo usuário e não precisa ser duplicado.

## 7. Verificação e aceite

1. Testar duas identidades: nenhuma lista, chave, requisição ou ação de usuário A
   pode acessar conexões de B. Cobrir CSRF, chave inválida e segredo mascarado.
2. Testar cifragem, falha com chave mestra incorreta e substituição/exclusão
   durante geração; verificar ausência de segredos em logs e respostas.
3. Mockar HTTP/SSE com eventos divididos entre chunks, Unicode, deltas de
   ferramentas, múltiplas chamadas, `finish_reason`, `usage`, `[DONE]`, erros após
   HTTP 200 e desconexão do cliente. Preservar cancelamento até o upstream.
4. Testar catálogo alterando preço/removendo modelo, cache expirado, plugins e
   fallback pagos, contexto excedido, 401/402/403/429/5xx e `Retry-After`.
5. Testar migração sobre banco existente, reinício e autenticação de `dsp_`
   quando apenas uma conexão API estiver ativa. Confirmar que contas API não
   entram nas filas de login, status de navegador ou restauração de workers.
6. Executar `npm run build` e testes apropriados ao contrato, gateway e painel;
   verificar regressões do roteamento e login dos provedores web.
7. Com as chaves cadastradas pelo usuário, testar cada API pelo gateway:
   texto JSON, streaming e ciclo completo de ferramenta executada no cliente.
   Fazer um teste no cliente IDE alvo. Registrar modelo, data, status, duração,
   conclusão SSE e quota/custo quando informado, sem conteúdo privado.

Não considerar uma integração validada apenas por responder a `/models`.
Nenhuma chave real foi usada nesta pesquisa. A implementação e a validação
com contas reais constituem a próxima etapa.
