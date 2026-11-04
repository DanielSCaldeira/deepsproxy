# Produção

Para revisar as telas localmente antes de publicar, execute `npm run preview` e
abra http://127.0.0.1:3300. A faixa superior permite alternar entre usuário,
administração, login, configuração inicial e convite, além dos estados da conta.
A prévia usa somente dados fictícios em memória, incluindo a tela remota
ilustrativa; não acessa o DeepSeek, PostgreSQL nem Docker.

O modo de produção é separado do modo local. O painel usa PostgreSQL e cada
usuário possui um contêiner de navegador, uma rede privada e um volume de perfil
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
DeepsProxy persiste cookies e armazenamento do navegador no volume privado, sem
registrá-los em logs. O administrador da VPS continua tendo acesso técnico ao
disco; os perfis e os backups devem receber a mesma proteção de credenciais.

Não copie o perfil de desenvolvimento para a VPS. Não há importação automática
de contas ou da antiga chave `local`. `npm start` e `npm run login` continuam
disponíveis para o modo local; `npm run build && npm run start:production` é o
gateway, que exige os serviços internos do Compose.

## Status individual e operação pelo painel

Cada usuário vê somente seu próprio estado: conectada, login necessário,
suspensa pelo DeepSeek, ainda não conectada ou indisponível. O painel também
mostra sessão salva, data da verificação, fila e estado do navegador.

Navegadores ociosos são desligados após 15 minutos. O último estado verificado
da conta é preservado em PostgreSQL e identificado como histórico no painel. A
próxima chamada inicia o navegador automaticamente. No máximo cinco ficam ativos
por padrão (`MAX_ACTIVE_BROWSERS`); capacidade cheia retorna 503 e `Retry-After`.
Há uma chamada em execução e até três em espera por usuário, com espera máxima
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
falha de pull não deve derrubar a stack em execução. Workers antigos com label
`dsp.managed=worker` continuam sendo recriados pelo provisionador sob demanda.

## Validação

`npm test` inclui PostgreSQL em WebAssembly (PGlite), autenticação, convite,
revogação, isolamento entre usuários, status individual, tickets remotos,
streaming e filas. O teste usa contêineres simulados e não faz login no DeepSeek.

Antes de liberar produção, homologue na VPS: dois usuários com contas distintas,
login completo (incluindo desafios), chaves no Zed/Continue, streaming, expiração
de login, queda e retomada do navegador, cinco navegadores ativos, bloqueio de
redes privadas, suspensão por ociosidade, backup e restauração. A disponibilidade
e a validade da sessão também dependem do DeepSeek.
