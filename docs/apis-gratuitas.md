# APIs gratuitas: NVIDIA e OpenRouter

As conexões API são independentes das conexões web e não iniciam navegadores.
O cliente continua usando `/v1` e a chave `dsp_`. Não há habilitação de modelos
pagos nesta entrega. O adaptador web DeepSeek existente permanece disponível;
a API oficial paga DeepSeek não foi adicionada.

## Configuração

1. Gerar um segredo exclusivo com
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Configurar `PROVIDER_CREDENTIALS_KEY` no ambiente do gateway. O Compose de
   produção repassa a variável. O laboratório `scripts/live-test.js` gera e
   preserva esse segredo em seu arquivo privado de ambiente.
3. Reconstruir e reiniciar o gateway. A migração 7 adiciona `provider_credentials`
   sem alterar contas, perfis ou chaves públicas existentes.
4. No painel, abrir **APIs gratuitas**, cadastrar a chave e selecionar um modelo.
   **Validar geração gratuita** faz uma chamada curta que consome cota. O cadastro
   sozinho não prova acesso à inferência. Após validar, é possível criar uma
   chave `dsp_` mesmo sem conectar nenhum chat web.

Sem segredo de cifragem, os chats web continuam funcionando e o cadastro de
credenciais API fica indisponível. Nunca substituir o segredo em uma instalação
com credenciais salvas: elas não poderão ser decifradas com outro segredo.
Guardar o segredo separadamente do backup do banco. Para uma troca de segredo,
remover as credenciais pelo painel e recadastrá-las após a troca; esta versão
não fornece rotação automática entre versões de chave.

As credenciais são cifradas com AES-256-GCM, nonce aleatório e associação
autenticada a usuário/provedor/versão. As rotas privadas exigem sessão e CSRF.
O painel exibe somente os quatro últimos caracteres; remover uma chave aqui
não a revoga no provedor. Nenhum segredo deve ser incluído em evidências ou Git.

## Obter chaves e conhecer limites

- OpenRouter: criar conta, abrir [API Keys](https://openrouter.ai/keys) e criar
  uma chave. Não é preciso comprar créditos para as variantes `:free`.
  [Condições e cotas oficiais](https://openrouter.ai/collections/free-models).
- NVIDIA: entrar em [API Catalog](https://build.nvidia.com/), concluir cadastro
  de desenvolvedor se solicitado e usar **Get API Key** em um Free Endpoint.
  [Gestão de chaves](https://build.nvidia.com/settings/api-keys).
  Usar a chave da API hospedada, não a chave NGC de download de containers.

OpenRouter: consulta de cota pelo painel usa `/api/v1/key`, sem inventar um
contador quando o provedor não o informa. NVIDIA: o acesso é para desenvolvimento
e depende das permissões e da disponibilidade de cada endpoint. 401/403 exigem
verificar a credencial; 429 preserva a chave e respeita `Retry-After`.

## Política de custo e transporte

- OpenRouter: catálogo atualizado a cada cinco minutos, somente variantes
  `:free` ou `openrouter/free`, com todos os preços retornados iguais a zero.
  Modelos sem metadados suficientes ficam bloqueados. O roteador gratuito não
  garante modelo fixo. Cada chamada impõe teto zero de preço de entrada/saída.
- NVIDIA: lista explícita revisada em `src/api-providers/free-api.ts`, cruzada
  com `/models` e a confirmação de Free Endpoint na página oficial. A página é
  consultada durante a atualização do catálogo, não em cada geração.
- Catálogo vencido sem atualização válida bloqueia novos envios. Não há fallback
  para serviço pago, plugins tarifados ou ferramentas executadas no servidor.
- Parâmetros fora da lista aceita são recusados, inclusive `provider`, `models`,
  `plugins` e `route`. Só são aceitas ferramentas nativas do tipo `function`,
  executadas pelo cliente. Recursos anunciados dependem do modelo.
- Texto, JSON, SSE e ferramentas nativas são preservados; imagens, arquivos,
  áudio e Responses não integram este MVP. Não há resumo automático nem retry
  de geração. O limite de contexto usa uma estimativa conservadora em bytes
  quando conhecido; isso pode recusar alguns pedidos que o tokenizador aceitaria.
- Há uma fila limitada e um cooldown por usuário/provedor. A troca/exclusão da
  chave e a revogação da `dsp_` cancelam chamadas correspondentes.
- Os endpoints de saída são fixos, HTTPS e sem redirecionamento. No Compose,
  o gateway usa sua rede `edge`, que já tem saída; o Squid dos navegadores não
  transporta essas chamadas. Em instalações com firewall externo, liberar
  `openrouter.ai`, `integrate.api.nvidia.com` e `build.nvidia.com` para o gateway.

IDs públicos: `openrouter/<id-original>` e `nvidia/<id-original>`; apenas o
primeiro prefixo é removido ao encaminhar. Exemplo do roteador:
`openrouter/openrouter/free` → `openrouter/free`.

## Rotas privadas e testes

- `GET /api/me/provider-credentials`: metadados mascarados das chaves do usuário.
- `GET|PUT|DELETE /api/me/provider-credentials/:provider`: consulta/cadastro/remoção;
  PUT recebe `{ "apiKey": "..." }`.
- `POST /api/me/provider-credentials/:provider/models`: força atualização do catálogo.
- `POST /api/me/provider-credentials/:provider/validate`: recebe `{ "model": "..." }`
  e confirma uma geração gratuita.
- `GET /api/me/provider-credentials/openrouter/limits`: cota diária, quando informada.

Testes controlados: `node scripts/test.js src/free-api.test.ts src/free-api-ui.test.ts
src/production.test.ts src/production-ui.test.ts` (executar em uma linha).
Build: `npm run build`.

Smoke real local: `npx tsx scripts/smoke-free-apis.ts --smoke`. Usa as credenciais
já salvas e a autenticação privada do laboratório em `.cache/`, cria uma chave
`dsp_` temporária e a revoga no fim. Testa texto, SSE e ciclo de ferramenta com
valor local aleatório. O resultado imprime apenas status e confirmações, sem
chaves ou conversas. O script consome a cota gratuita; testar pelo gateway não
equivale a testar dentro de uma IDE real.

## Evidências da entrega — 2026-11-07

- Laboratório local atualizado em `http://localhost:3440`, com backup PostgreSQL
  anterior à migração, segredo de cifragem persistido e gateway saudável.
  As duas credenciais fornecidas foram cadastradas na conta administrativa local;
  a consulta ao banco confirmou registros cifrados e geração validada em ambas.
- NVIDIA: `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b` confirmou texto JSON,
  streaming com `[DONE]`, chamada nativa de ferramenta e continuação com o valor
  aleatório devolvido pelo cliente, todos com HTTP 200.
- OpenRouter: `openrouter/openrouter/free` confirmou texto JSON, streaming e
  chamada nativa de ferramenta com HTTP 200. A continuação recebeu HTTP 429;
  não foi considerada validada. O proxy preservou a credencial e respeitou o
  limite, sem fallback pago. Em outra seleção explícita, um modelo gratuito
  anunciou ferramentas no catálogo mas recusou a chamada com HTTP 404; o proxy
  não substituiu o modelo. O catálogo não é garantia de disponibilidade.
- Os metadados nativos de raciocínio recebidos em respostas com ferramentas são
  aceitos no histórico da continuação, incluindo `reasoning_content` da NVIDIA
  e `reasoning`/`reasoning_details` do OpenRouter.
- Resultado sanitizado em `.cache/free-api-live-result.json`. Nenhuma chave
  temporária de smoke permaneceu ativa. Não foi testado dentro de IDE real.
- Painel real: chaves mascaradas, catálogo gratuito, ausência de erros JavaScript
  e largura móvel de 390 px sem transbordamento.
- `npm run build` aprovado; testes específicos de política, gateway, cifragem e
  painel aprovados. A suíte completa registrou 223 aprovações, 2 ignorados,
  1 timeout e 1 cancelamento de limpeza no diagnóstico de navegador. A repetição
  isolada de `src/diagnostic-flow.test.ts` aprovou os 3 cenários. Após o ajuste de
  metadados, o build e os testes específicos foram executados novamente e passaram.
