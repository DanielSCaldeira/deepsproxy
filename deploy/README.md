# Produção

Consulte também o [histórico do diagnóstico de login](../docs/diagnostico-login-2026-11-05.md),
com resultados positivos, tentativas sem sucesso e os limites das validações.

## Teste local com autenticação real

Com Docker Desktop iniciado, execute `npm run live` e abra
`http://localhost:3440`. Esse ambiente reutiliza os serviços de produção,
incluindo PostgreSQL, provisionador, egress e noVNC. Os dados e perfis ficam
isolados na instalação `proxy-ia-live`; cada conta autentica no serviço real.

Na primeira execução, o token de configuração está no campo `BOOTSTRAP_TOKEN`
de `.cache/proxy-ia-live.env`. Configure o acesso local ao painel, clique em
**Conectar** no DeepSeek ou Qwen e conclua senha, código e desafios diretamente
na tela remota. Não use a prévia em `3300` para esse teste: ela tem dados fictícios.

No DeepSeek, espere o chat abrir e clique em **Concluir login** no painel.
Se o provedor mostrar uma suspensão após o login, a confirmação salva a sessão
e o card mostra **Autenticada · conta bloqueada**, com o aviso e o prazo
informado. Os envios continuam interrompidos enquanto a conta estiver bloqueada.
Durante o login, um processo de Chromium no próprio worker recebe as interações
humanas pela tela remota. Após a confirmação, esse processo salva e fecha seu
perfil antes de a API abrir a mesma sessão e validá-la. O snapshot anterior
não sobrescreve esse novo acesso. O polling não conclui esse passo manual.
Qwen conserva a confirmação automática existente.

O login manual e a API usam a mesma configuração de armazenamento do Chromium.
O worker solicita o fechamento normal da janela e aguarda a saída do navegador
para garantir a gravação dos cookies antes de abrir o perfil na API.
Um marcador no volume preserva o perfil mais recente caso o worker reinicie
antes de concluir a validação; ele é removido após salvar a sessão validada.

Todo o fluxo funciona entre máquinas diferentes: o cliente só precisa acessar
o site, enquanto navegador, API e volumes privados ficam no servidor. Nenhum
perfil do Chrome do computador do cliente é necessário. Preserve os volumes
de cada conta nas atualizações e nos reinícios.

A imagem Chrome for Testing lê `browser-signin-policy.json` em
`/etc/opt/chrome_for_testing/policies/managed`. A política `BrowserSignin=0`
desativa o login no perfil do navegador, mantendo o login dos sites disponível.
O arquivo completo destinado ao Chrome/Chromium não é aplicado automaticamente
ao Chrome for Testing: essa variante causou timeout do canal Playwright no ensaio.

`npm run live:status` consulta os serviços. `npm run live:stop` para os serviços
e os navegadores desse laboratório preservando as sessões salvas. Ao iniciar
novamente, os mesmos perfis serão reutilizados.

Somente a porta `3440` no loopback é publicada. A exceção HTTP exige
`LOCAL_LIVE_TEST=1` e origem exatamente `http://localhost:<porta>`; produção
continua exigindo HTTPS. O navegador usa a mesma política de cookies Secure e
HttpOnly, aceita pelo Chromium em localhost. As páginas externas dos provedores
continuam usando HTTPS.

## Proxy IA com DeepSeek e Qwen

O painel **Minhas contas** lista os dois serviços. Cada usuário autentica uma
conta em cada serviço; ações e telas remotas pertencem à conta selecionada.
A URL pública e as chaves continuam únicas por usuário. Os IDs DeepSeek são
preservados; os modelos Qwen aparecem como `qwen/<id-original>` depois do login.
A listagem de modelos usa o catálogo salvo e não inicia navegadores.

Os endpoints novos são `GET /api/me/accounts`,
`GET /api/me/accounts/:provider/status`,
`POST /api/me/accounts/:provider/connection/:action` e
`POST /api/me/accounts/:provider/remote-ticket`, para `deepseek` e `qwen`.
As rotas anteriores permanecem aliases DeepSeek.

A migração cria uma conta por serviço para cada usuário. Para DeepSeek, o UUID
da conta é o UUID anterior do usuário: os volumes `dsp_profile_UUID`, sessões e
chaves existentes são preservados. Qwen começa com um perfil vazio. Há um
contêiner/rede/perfil por **conta de serviço**, podendo haver dois navegadores
por usuário; `MAX_ACTIVE_BROWSERS` continua sendo o teto global.

Para atualizar uma instalação existente, obtenha as novas imagens e os arquivos
de implantação deste commit e execute:

```sh
sh deploy/upgrade.sh
```

O script fecha novas entradas, aguarda até 180 segundos pelo encerramento do
gateway, faz backup do banco e perfis, remove workers/redes antigos preservando
volumes e atualiza os serviços. O gateway migra o banco e recria workers sob
demanda; workers com imagem ou contrato incompatível também são rejeitados na
inicialização. Se a atualização falhar, restaure banco e perfis do mesmo backup
antes de retornar à versão anterior. Não execute versões diferentes sobre o
mesmo perfil simultaneamente.

Os backups novos incluem `accounts.tsv` com conta, usuário, provedor e volume.
Mantenha o manifesto junto dos arquivos `.tar.gz`; `restore-profile.sh` o lê
automaticamente. Backups antigos sem manifesto são interpretados como DeepSeek.
A imagem usada na cópia é resolvida da configuração Compose, inclusive tags
GHCR; preserve as variáveis de imagem ao executar os scripts.

O egress inclui os hosts de chat/autenticação Qwen, os hosts de assets observados
(`assets.alicdn.com`, `g.alicdn.com`, `img.alicdn.com`, `o.alicdn.com`,
`d.alicdn.com`, `at.alicdn.com`, `alidt.alicdn.com`), os serviços auxiliares
`aplus.qwen.ai` e `ss.qwen.ai` e as dependências de verificação
`fourier.alibaba.com`, `fourier.taobao.com`, `sg-wum.alibaba.com` e
`*.tdum.alibaba.com`. Os subdomínios de `tdum.alibaba.com` usam nomes rotativos.
Logs do navegador confirmaram bloqueios HTTP 403 do proxy ao carregar esses recursos. Não se deve
liberar toda a internet para resolver falhas de carregamento: redes privadas e
destinos não listados continuam bloqueados. Homologue login e geração reais ao
atualizar as dependências do provedor.

O login opcional do Qwen pelo GitHub permite `github.com`,
`github.githubassets.com` e `avatars.githubusercontent.com`. Se o Chromium
mostrar `ERR_TUNNEL_CONNECTION_FAILED` durante o OAuth, consulte o log do
navegador e valide os destinos no Squid; não libere domínios genéricos ou redes
internas para contornar a falha.

O login Google também pode usar `accounts.google.com.br` no redirecionamento
regional `/accounts/SetSID`. Esse host é permitido explicitamente no egress;
`.google.com` não inclui domínios terminados em `.google.com.br`. A regra
mantém bloqueados destinos privados, portas não autorizadas e outros hosts.

Falhas de CONNECT agora aparecem nos logs do egress com domínio, porta e status,
sem caminhos, parâmetros de OAuth, cabeçalhos, cookies ou conteúdo TLS. A rotação
do Docker mantém dois arquivos de até 10 MB. Para acompanhar:

```sh
docker compose logs --tail=100 -f egress
```

O erro Chromium `-111` identifica uma falha de túnel pelo proxy. Correlacione a
tentativa com o host recusado; uma recusa de atualização ou autofill em segundo
plano não comprova a causa da falha de autenticação.

O CAPTCHA do login DeepSeek usa `hcaptcha.com` e seus subdomínios, incluindo
`js.hcaptcha.com`, `api.hcaptcha.com` e hosts de assets variáveis. A regra
`.hcaptcha.com` segue a [orientação do hCaptcha](https://docs.hcaptcha.com/#content-security-policy-settings)
para não fixar apenas um host de assets. Um bloqueio do script `1/api.js` causa
o aviso “Captcha failed to load”. O desafio continua exigindo resolução manual.

O login DeepSeek também solicita `fp-it-acc.portal101.cn/deviceprofile/v4`
e o SDK de `lf3-data.volccdn.com`, que solicita `gator.volces.com`. Os logs
mostraram bloqueios HTTP 403 do proxy; a lista permite apenas esses três hosts.
A liberação corrige o carregamento das dependências, mas a aprovação do
CAPTCHA continua dependendo do provedor. Não amplie a regra para todos os
subdomínios de `portal101.cn`, `volccdn.com` ou `volces.com`.

Antes de publicar, valide com contas de homologação: login em ambos os serviços,
geração, ferramentas, reinício e preservação do perfil DeepSeek. Os testes
automatizados interceptam a rede e não comprovam a disponibilidade das contas
nos serviços reais.

Para revisar as telas localmente antes de publicar, execute `npm run preview` e
abra http://127.0.0.1:3300. A faixa superior permite alternar entre usuário,
administração, login, configuração inicial e convite, além dos estados da conta.
A prévia usa somente dados fictícios em memória, incluindo a tela remota
ilustrativa; não acessa o DeepSeek, PostgreSQL nem Docker.

O modo de produção é separado do modo local. O painel usa PostgreSQL e cada
conta de serviço possui um contêiner de navegador, uma rede privada e um volume de perfil
exclusivos. O gateway público encaminha chamadas e telas somente ao proprietário.
O socket Docker fica exclusivamente no provisionador interno.

## Instalação inicial na VPS

Requisitos: Linux x86-64, Docker Engine com API 1.48 ou superior, Docker Compose,
DNS do domínio apontado para a VPS e portas 80/443 disponíveis. O Chromium exige
suporte a user namespaces e sandbox. Não desligue a sandbox para contornar falhas.
Para começar a homologação com cinco navegadores, reserve aproximadamente 12 GB
de RAM; o consumo real deve ser medido com sua carga. Cada navegador tem limite
de 1,5 GB, uma CPU e 256 processos.

1. Copie `.env.production.example` para `.env.production` e restrinja sua leitura
   ao operador. Defina `DOMAIN` e gere **quatro valores independentes** com
   `openssl rand -hex 32` para os campos de segredo. A senha PostgreSQL deve ser
   hexadecimal para uso direto na URL de conexão.
2. Construa as imagens e inicie os serviços:

   ```sh
   docker compose --env-file .env.production -f compose.production.yml --profile images build
   docker compose --env-file .env.production -f compose.production.yml up -d
   ```

3. Abra `https://SEU_DOMINIO`, informe `BOOTSTRAP_TOKEN`, email e uma senha de
   pelo menos 12 caracteres. O cadastro inicial é atômico e não pode ser repetido.
4. Gere convites na Administração e compartilhe os links. O usuário define a
   senha, abre **Conectar**, conclui o login DeepSeek e gera sua chave.

O segredo do DeepSeek é digitado diretamente na janela remota do provedor. O
Proxy IA persiste cookies e armazenamento do navegador no volume privado, sem
registrá-los em logs. O administrador da VPS continua tendo acesso técnico ao
disco; os perfis e os backups devem receber a mesma proteção de credenciais.

Não copie o perfil de desenvolvimento para a VPS. Não há importação automática
de contas ou da antiga chave `local`. `npm start` continua
disponível para o modo local (o login por janela externa foi removido; use o painel); `npm run build && npm run start:production` é o
gateway, que exige os serviços internos do Compose.

## Status individual e operação pelo painel

Cada usuário vê somente seu próprio estado: conectada, login necessário,
suspensa pelo DeepSeek, ainda não conectada ou indisponível. O painel também
mostra sessão salva, data da verificação, fila e estado do navegador.

Navegadores ociosos são desligados após 15 minutos. O último estado verificado
da conta é preservado em PostgreSQL e identificado como histórico no painel. A
próxima chamada inicia o navegador automaticamente. No máximo cinco ficam ativos
por padrão (`MAX_ACTIVE_BROWSERS`); capacidade cheia retorna 503 e `Retry-After`.
Há uma chamada em execução e até três em espera por conta de serviço, com espera máxima
de 120 segundos. A fila inclui a duração completa do streaming.

**Conectar** reserva o navegador para login e bloqueia novas chamadas até o fim
do login. Fechar a tela encerra o acesso remoto, sem apagar o perfil. O login
remoto tem limite de 30 minutos. Se a sessão DeepSeek expirar, o usuário entra
novamente pelo painel. **Recuperar navegador** recria o contêiner preservando o
perfil. **Desconectar conta** apaga o volume e exige novo login. Nenhuma dessas
ações reinicia a aplicação nem oferece execução livre de comandos.

O monitor verifica os serviços a cada cinco segundos e tenta recuperar falhas
de navegador até três vezes, com espera progressiva. Sessão expirada e suspensão
do provedor não são tratadas como falhas recuperáveis do processo.

As chaves `dsp_` são mostradas completas somente na criação e ficam armazenadas
como SHA-256. Usuários podem revogá-las. Bloquear uma conta invalida as sessões
do painel e interrompe conexões em uso. Redefinir a senha invalida sessões e
chaves anteriores. Sessões do painel duram 12 horas; convites e recuperação duram
24 horas e são de uso único. A administração não tem botão de visualização dos
navegadores de outros usuários.

## Rede, imagens e observabilidade

Somente Caddy publica portas. Workers não têm saída direta: usam Squid, com
bloqueio de redes privadas e permissão para domínios DeepSeek, Google e desafios
Cloudflare. Caso o provedor passe a exigir outro domínio, revise explicitamente
`deploy/squid.conf` e homologue o login antes de liberá-lo. Não amplie a regra
para permitir destinos internos. VNC não é publicado no host.

O monitor consulta a saúde da API interna e do navegador. O painel mostra
erros operacionais sem segredos. Logs podem ser consultados pelo operador com
`docker compose --env-file .env.production -f compose.production.yml logs`.
Workers têm rotação de logs de 2 arquivos de 10 MB. A auditoria guarda ações,
atores e horários, sem conteúdo de conversas. Retenção: auditoria 90 dias,
operações 30 dias e links expirados 7 dias; limpeza a cada hora.

O perfil seccomp em `deploy/seccomp.json` vem de
https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json
(Apache-2.0), acrescentando suporte aos namespaces usados pela sandbox. Ele é
versionado junto da aplicação. Revise e teste atualizações de imagens e do
Playwright como uma unidade; a construção instala o Chromium da versão exata
resolvida no lockfile.

Ao atualizar a dependência `playwright`, reconstrua a imagem `worker-image`:
copiar apenas `dist/` não atualiza o pacote nem os binários do navegador.
Os workers existentes precisam ser recriados com a imagem nova. No painel,
**Recuperar navegador** preserva o volume de perfil; **Conectar** inicia o
navegador atualizado. `npm run live` reconstrói as imagens do laboratório local.

## Backup e restauração

Execute `sh deploy/backup.sh` a partir da raiz do repositório. O script interrompe
o acesso durante a cópia, salva PostgreSQL e todos os perfis em `backups/` e
reinicia o gateway ao terminar. Os navegadores serão recriados sob demanda.
Proteja a pasta e copie o backup para armazenamento externo criptografado.
Guarde `.env.production` separadamente, em armazenamento protegido.

Para restaurar em uma instalação vazia, construa as imagens, inicie PostgreSQL,
egress e provisioner, mas mantenha gateway/Caddy parados. Restaure o banco:

```sh
docker compose --env-file .env.production -f compose.production.yml exec -T postgres \
  pg_restore -U deepsproxy -d deepsproxy --clean --if-exists < backups/DATA/database.dump
```

Para cada arquivo de perfil, execute
`sh deploy/restore-profile.sh backups/DATA/dsp_profile_UUID.tar.gz`. O script
valida o nome, recusa volumes existentes, cria os labels e extrai o perfil sem
rede, preservando uid/gid. Depois execute `up -d` no Compose.
Teste a restauração em uma VPS separada antes de depender dos backups.

Atualizações: faça backup, pare gateway/Caddy, reconstrua as imagens e remova
somente contêineres com label `dsp.managed=worker`, preservando volumes. Suba os
serviços novamente. Migrações são aplicadas antes de aceitar tráfego. Alterações
de esquema incompatíveis exigem restauração do backup para rollback.

## Integração e entrega contínuas

Os workflows ficam em `.github/workflows` e usam Node 24, a mesma versão das
imagens de produção.

- `ci.yml` roda em pull requests e em pushes para `main`: instala com `npm ci`,
  compila com `tsc`, executa `npm test` com `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  (o teste ao vivo é ignorado por padrão), valida os scripts em `deploy/` com
  `shellcheck`, resolve os três arquivos Compose com segredos fictícios e
  constrói as quatro imagens (`runtime`, `worker`, `egress` e a local) sem
  publicar.
- `cd.yml` publica no GHCR as imagens `deepsproxy-runtime`, `deepsproxy-worker`
  e `deepsproxy-egress`, sempre marcadas com o SHA do commit. Em `main` e em tags
  `v*` também aplica a tag móvel (`main` ou o nome da tag). O deploy só ocorre em
  push para `main`, push de tag `v*` ou execução manual com `deploy` marcado.
- Ao criar uma tag `v*`, o job `release` publica uma GitHub Release com a lista
  de mudanças desde a tag anterior (commits sem merge) e os nomes imutáveis das
  três imagens. Uma falha no release não bloqueia o deploy, e o deploy continua
  ocorrendo normalmente em `main` e em execuções manuais.
- `security.yml` roda `npm audit --audit-level=high`, o gitleaks e verificações
  de hardening: o Compose precisa falhar sem segredos e o `.dockerignore` precisa
  manter `.env`, `deepseek_profile` e `backups` fora das imagens.

O `compose.production.yml` lê `DEEPSPROXY_REGISTRY` e `DEEPSPROXY_IMAGE_TAG`, com
padrão vazio e `local`. Sem essas variáveis a VPS continua construindo as imagens
a partir do código; o pipeline define ambas para consumir as imagens publicadas,
sem reconstruir nada no servidor.

### Segredos e variáveis do repositório

Crie o environment `production` em Settings → Environments e configure:

| Nome | Tipo | Uso |
|---|---|---|
| `VPS_HOST` | secret | Host SSH da VPS |
| `VPS_USER` | secret | Usuário SSH com acesso ao Docker |
| `VPS_SSH_KEY` | secret | Chave privada dedicada ao deploy |
| `VPS_PATH` | secret | Diretório do repositório na VPS, com `.env.production` |
| `PRODUCTION_DOMAIN` | variable | Só para o link exibido no environment |

O deploy usa `GITHUB_TOKEN` para autenticar no GHCR e o remove ao terminar. A
VPS precisa apenas de Docker e Compose; o código é atualizado pelas imagens
publicadas. Faça o pull antes de recriar os serviços, como o workflow faz: uma
falha de pull não deve derrubar a stack em execução. Após o pull, o workflow
atualiza os arquivos Compose/deploy e executa `upgrade.sh`, incluindo backup e
remoção dos workers antigos com preservação dos perfis.

## Validação

`npm test` inclui PostgreSQL em WebAssembly (PGlite), autenticação, convite,
revogação, isolamento entre usuários, status individual, tickets remotos,
streaming e filas. O teste usa contêineres simulados e não faz login no DeepSeek.

Antes de liberar produção, homologue na VPS: dois usuários com contas distintas,
login completo (incluindo desafios), chaves no Zed/Continue, streaming, expiração
de login, queda e retomada do navegador, cinco navegadores ativos, bloqueio de
redes privadas, suspensão por ociosidade, backup e restauração. A disponibilidade
e a validade da sessão também dependem do DeepSeek.


## Conta ChatGPT

A migração 5 adiciona uma conta `chatgpt` por usuário, preservando os IDs,
volumes e chaves de DeepSeek e Qwen. O worker recebe `PROVIDER=chatgpt` e
`PROVIDER_PROFILE_DIR=/profile`; o volume continua identificado pela conta.
As rotas `/api/me/accounts/chatgpt/status`, `/connection/:action` e
`/remote-ticket` seguem os mesmos controles de autenticação e propriedade.

Reconstrua as imagens de aplicação/worker e de egress para incluir o adaptador
e a ACL do ChatGPT, usando o procedimento de atualização deste guia. O card
ChatGPT abre `https://chatgpt.com/` no navegador remoto; após o login manual,
clique em **Concluir login**. A sessão é validada antes de disponibilizar o
catálogo na API. A confirmação antecipada devolve o navegador para o login.

O backup já enumera todas as contas; a restauração passa a aceitar `chatgpt`.
Os destinos iniciais do proxy são `chatgpt.com`, seus subdomínios,
`auth.openai.com`, `auth0.openai.com`, `oaistatic.com` e `oaiusercontent.com`.
Dependências adicionais de login só devem ser acrescentadas após observar
falhas concretas. Os controles de saída para redes privadas continuam ativos.

Veja [o registro de validação](../docs/chatgpt-integration.md) antes de tratar
esta integração como validada com uma conta real.

## Conta Cohere

A migração 6 adiciona uma conta `cohere` por usuário, reconstruindo a restrição
de provedores a partir da lista completa e preservando as contas existentes.
O card **Cohere** abre `https://dashboard.cohere.com/playground/chat` no navegador
remoto (login por e-mail, Google ou GitHub); após entrar, clique em
**Concluir login**. A restauração aceita `cohere`. Os destinos acrescentados ao
egress são `dashboard.cohere.com`, `production.api.os.cohere.com` e
`api.cohere.com`. Veja [o registro da integração](../docs/cohere-integration.md):
o envio real com conta ainda não foi validado.
