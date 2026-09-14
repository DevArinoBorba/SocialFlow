# Operação centralizada no Coolify

## Publicação

Use um único recurso Docker Compose na VPS da agência, apontando para o repositório e o compose da raiz. Build local não equivale a deploy homologado. Defina no Coolify `APP_ENV=production`, `APP_URL=https://dominio-da-agencia`, senhas independentes de PostgreSQL/Redis/runtime e SESSION_SECRET aleatório. Nenhum segredo tem fallback de desenvolvimento. Configure domínio/TLS somente no serviço web, porta interna 3000. API, worker, PostgreSQL e Redis ficam na rede privada. Remova o mapeamento loopback web se o roteador do Coolify usar apenas a rede interna; nunca adicione portas públicas aos dados. O serviço web declara `expose: ["3000"]` no `compose.yaml` (e `EXPOSE 3000` no `Dockerfile`), o que permite ao Coolify gerar automaticamente as labels `traefik.http.routers...service` e `traefik.http.services...loadbalancer.server.port=3000` sem vincular a porta 3000 ao host, prevenindo conflitos com outras aplicações na VPS. Não configure domínio nos serviços internos.

O Coolify utiliza os healthchecks declarados no compose. Readiness consulta banco/Redis com timeout, e web consulta a API. Migration roda uma única vez antes de API/worker. Uma migration falha bloqueia a subida. API e worker devem usar role `socialflow_runtime`, sem superuser/BYPASSRLS e sem ownership das tabelas. Nunca substitua DATABASE_URL pela URL de migration para corrigir um erro de permissão.

Bootstrap de produção usa a ferramenta offline descrita abaixo. O seed de
desenvolvimento é proibido. A homologação continua NO-GO para clientes reais
até pipeline remota, provisionamento na VPS e recuperação externa demonstrados.

## Primeira organização e administrador

Após configurar os secrets de produção e aplicar migrations, o operador cria
um arquivo fora do repositório, legível pelo usuário do container, com uma senha
aleatória de 16 a 128 caracteres. Não colocar senha em argumentos, histórico ou
compose.yaml. Defina `BOOTSTRAP_PASSWORD_FILE` com seu caminho absoluto,
`BOOTSTRAP_EMAIL`, `BOOTSTRAP_NAME`, `BOOTSTRAP_ORGANIZATION` e
`ALLOW_INITIAL_BOOTSTRAP=true` em ambiente administrativo temporário. A senha
também pode ser injetada como `BOOTSTRAP_PASSWORD` em execução local da CLI;
o fluxo Docker usa arquivo montado como secret.

Execute no mesmo projeto Compose da instalação central (substitua socialflow
pelo nome real configurado no Coolify, sem criar instalação por cliente):

```sh
docker compose -p socialflow -f compose.yaml -f compose.bootstrap.yaml config --quiet
docker compose -p socialflow -f compose.yaml -f compose.bootstrap.yaml run --build --rm bootstrap
```

O arquivo adicional só entra nessa execução administrativa. O deploy normal
usa apenas compose.yaml; web/API/worker não recebem entradas de bootstrap nem
credenciais de migration. Não execute `compose config` sem `--quiet`, pois ele
expande secrets. Em produção use senhas independentes de banco/Redis com ao menos
24 caracteres e SESSION_SECRET aleatório com ao menos 32. O inicializador de
volume novo recusa senhas iguais de migration/runtime. Rotação de volume existente
continua sendo ação do operador, não ocorre automaticamente ao mudar env.

Sucesso gera somente `initial_bootstrap_completed`. A ferramenta cria um OWNER
organizacional, com senha no formato Better Auth, sem clientes de demonstração.
Ela não alega verificar o e-mail; o operador confirma a identidade por canal
administrativo. A senha é entregue ao proprietário pelo gerenciador de senhas.
Após login pelo domínio HTTPS, remova os inputs temporários e o arquivo de senha
segundo a política do gerenciador de secrets. Nunca reutilize essa ferramenta
para trocar senha, convidar equipe ou conceder privilégios em instalação existente.

Uma segunda execução (inclusive concorrente) falha sem alterar identidade,
senha ou vínculos. Em falha, confira inputs, conectividade e se a instalação já
possui User/Organization; não apague dados para forçar bootstrap. Execute
`pnpm test:foundation` antes de promover uma nova versão da ferramenta.

## Migrations e rollback

Migrations estão em `packages/db/prisma/migrations`. O primeiro SQL é gerado do
schema; o segundo adiciona RLS, grants e constraints; o terceiro corrige leitura
de auditoria após revogação. Prisma migrate deploy registra checksums e ignora
migrations já aplicadas. Revisar a sequência em qualquer mudança de schema.
A senha da role runtime é criada apenas na inicialização de volume vazio;
mudar env não muda senha no PostgreSQL existente. Rotacione por conexão de
operador com `ALTER ROLE` e atualize o secret coordenadamente, sem colocar senha
em logs ou histórico do terminal. API/worker recusam role privilegiada ao iniciar.

Rollback de aplicação: mantenha imagem/commit anterior e restaure apenas se compatível com o schema vigente. Mudança de banco incompatível pede migration corretiva ou restore. Não edite migrations já aplicadas, não execute reset e não use `down -v` em dados que devam ser preservados.

## Backup e restore

### Arquitetura de Backup Criptografado

O SocialFlow utiliza backup automatizado do PostgreSQL com criptografia assimétrica ponta a ponta e transmissão para armazenamento de objetos compatível com S3 (Cloudflare R2):

1. **Geração consistente**: Execução de `pg_dump -Fc` pelo usuário `socialflow_migration` dentro do container de banco de dados.
2. **Validação estrutural**: Verificação do catálogo do dump via `pg_restore -l` antes de qualquer transmissão.
3. **Criptografia assimétrica**: Criptografia usando a chave pública GPG (`SocialFlow Backup <security@oriumdigital.com.br>`) na VPS. A chave privada de recuperação **não existe na VPS**, ficando custodiada exclusivamente com o operador (Arino Borba, OWNER). A separação de custódia (VPS só decripta com a pública; só o operador decripta) foi demonstrada em ambiente de teste isolado — a alegação de cofre físico/MFA é atestada pelo operador e não verificável por este repositório.
4. **Integridade**: Geração do checksum SHA256 do artefato criptografado (`.sha256`).
5. **Transmissão segura**: Upload para Cloudflare R2 utilizando container efêmero `rclone/rclone` (versão fixa, ver abaixo), com credenciais passadas como variáveis de ambiente do container (nunca em argumento de linha de comando, que ficaria visível via `docker inspect`/`ps` a qualquer usuário local).
6. **Semântica de sucesso**: geração local do dump e envio externo confirmado são estados **distintos e registrados separadamente**. Ausência de credenciais R2 ou falha de upload nunca é reportada como sucesso de backup externo: `last_backup.json` registra `status: "success_local_only"` nesse caso e **não** cria/atualiza `last_successful_remote_backup.json` — apenas um upload verificado (tamanho conferido no destino) atualiza esse segundo arquivo, que é a única fonte válida para RPO/monitoramento.
7. **Retenção e isolamento**: Prunagem automática de arquivos com mais de 30 dias restrita estritamente ao prefixo do SocialFlow (`backups/socialflow/homolog/`), preservando backups existentes fora do escopo.
8. **Proteção de concorrência**: `flock` exclusivo via descritor de arquivo impede execuções concorrentes acidentais.
9. **Alertas e monitoramento**: Webhook para Discord relatando sucesso completo (local+remoto), sucesso local apenas (aviso, sem envio externo) ou falha crítica, além de registro em `/root/backups/socialflow/last_backup.json`. Um verificador independente (`check-backup-freshness.sh`) detecta atraso mesmo se o cron do backup parar de rodar — ver seção de agendamento.

A imagem `rclone/rclone` é fixada em uma versão explícita (atualmente `1.68.2`, não `:latest`) nos três scripts que a usam, para que uma mudança na imagem upstream nunca altere o comportamento de upload/download/retenção sem uma atualização deliberada e re-execução do drill.

### Configuração na VPS

Arquivo de configuração em `/root/.config/socialflow/backup.env` com permissões estritas `0600`:

```sh
# /root/.config/socialflow/backup.env (chmod 0600)
POSTGRES_USER=socialflow_migration
POSTGRES_DB=socialflow
GPG_RECIPIENT="SocialFlow Backup"
R2_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
R2_BUCKET="socialflow-backups"
R2_PREFIX="backups/socialflow/homolog"
R2_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
R2_SECRET_ACCESS_KEY="<R2_SECRET_ACCESS_KEY>"
RETENTION_DAYS=30
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
```

### Execução e Agendamento

- **Execução manual**:
  ```sh
  /root/scripts/backup/socialflow-backup.sh
  ```
- **Agendamento diário via cron, com fuso explícito (03:00 UTC)**: confirme antes o fuso real do crond da VPS com `timedatectl` e `date -u`; o `TZ=UTC` abaixo remove a ambiguidade independentemente da configuração do sistema, mas **não foi verificado nesta revisão** por falta de acesso à VPS real:
  ```sh
  TZ=UTC
  0 3 * * * /root/scripts/backup/socialflow-backup.sh >> /var/log/socialflow-backup.log 2>&1
  ```
- **Verificador independente de atraso** (detecta backup atrasado mesmo se a linha acima for removida, o crond travar, ou o script falhar silenciosamente): agende em um horário **diferente** do backup, por exemplo:
  ```sh
  TZ=UTC
  30 4 * * * /root/scripts/backup/check-backup-freshness.sh >> /var/log/socialflow-backup-freshness.log 2>&1
  ```
  Este script só lê `last_successful_remote_backup.json` (nunca invoca `socialflow-backup.sh`), então continua funcionando como sentinela mesmo se a entrada de cron do backup for apagada.

### Procedimento de Recuperação de Desastres

`scripts/backup/socialflow-restore.sh` executa o procedimento completo e é a via oficial (o passo a passo manual abaixo descreve o que ele faz por baixo, para auditoria ou execução manual se o script não estiver disponível):

```sh
# Sem argumento: baixa o mais recente do R2 configurado em backup.env.
# Um caminho local só deve ser usado para depuração — não conta como
# evidência de recuperação a partir do destino externo (ver ponto 2 abaixo).
BACKUP_CONFIG_FILE=/root/.config/socialflow/backup.env \
  /root/scripts/backup/socialflow-restore.sh
```

Passo a passo equivalente:

1. **Baixar artefato e checksum do R2** (não de uma cópia local/manual — isso é o que precisa ser comprovado; ver `DOWNLOAD_SOURCE`/"Backup source exercised" na saída do script, que deve começar com `r2:`).
2. **Conferir SHA256** contra o arquivo `.sha256` companheiro.
3. **Descriptografar fora da VPS** usando a chave privada custodiada (nunca a mesma chave/keyring usado para criptografar na VPS).
4. **Subir PostgreSQL 17.11 isolado em rede Docker dedicada e descartável** (nunca a rede de produção), com roles inicializadas por `infra/postgres/init.sh`.
5. **Criar banco limpo e restaurar** com `pg_restore --exit-on-error --single-transaction --no-owner`.
6. **Validar invariantes de segurança**, cobrindo **todas** as tabelas de `public` dinamicamente (não uma lista fixa que fica desatualizada a cada tabela nova):
   - Migrations Prisma aplicadas.
   - RLS e FORCE RLS ativos em `Brand`, `Client`, `Organization`, `Membership`, `AuditLog`.
   - **Todas** as tabelas de `public` pertencem a `socialflow_migration`; nenhuma pertence a `socialflow_runtime` (ownership verificado dinamicamente contra `pg_tables`, não uma lista fixa de 3 tabelas).
   - Role `socialflow_runtime` sem `SUPERUSER`, `BYPASSRLS`, `CREATEDB` ou `CREATEROLE`.
   - Role `socialflow_runtime` sem `DELETE` em `User`, `Organization`, `Membership`, `Client`, `Brand`, `AuditLog`, `Account` (apenas as tabelas efêmeras `Session`/`Verification`/`RateLimit` permitem `DELETE`, por desenho).
7. **Subir a aplicação isolada na mesma rede descartável** apontando para o banco restaurado com a role `socialflow_runtime`, validar `GET /health/ready` e confirmar que uma requisição não autenticada a uma rota protegida é rejeitada (401) — prova que autenticação funciona contra o esquema restaurado, sem precisar de credenciais reais de nenhum usuário. `socialflow-restore.sh` faz isso automaticamente se a imagem da API estiver disponível localmente (`SOCIALFLOW_APP_IMAGE`); caso contrário, reporta `[PENDING]` explicitamente — trate como validação pendente, não como aprovada.
8. **Destruir containers, rede e arquivos temporários** ao final (o script faz isso via `trap`).

O tempo total reportado como RTO cobre o procedimento inteiro, do início da localização/download do artefato até a validação concluída — não apenas o passo de `pg_restore` isoladamente. O RPO reportado é a idade do último backup **externo confirmado** (`last_successful_remote_backup.json`), nunca a data do último registro de auditoria (que reflete quando o sistema de origem escreveu dado, não quando esse dado foi copiado com segurança para fora da VPS).

### Verificador de Frescor (independente do cron de backup)

`scripts/backup/check-backup-freshness.sh` lê apenas `last_successful_remote_backup.json` e sai com código 0 (fresco), 1 (atrasado além do limite) ou 2 (nunca houve backup externo confirmado). Por não invocar `socialflow-backup.sh` nem depender do seu cron, continua detectando atraso mesmo se essa entrada de cron for removida ou o crond falhar. Deve rodar em um horário de cron **separado** do backup (ver seção de agendamento).

### Ensaio Automatizado Contínuo

O repositório inclui `scripts/backup/drill-backup-recovery.mjs`, que executa os scripts de produção reais (não uma reimplementação paralela) contra um destino S3 compatível local (MinIO, sem qualquer credencial real do R2) e valida 25 verificações: geração e separação de custódia GPG (o keyring "só público" simulando a VPS comprovadamente não consegue descriptografar), roundtrip de criptografia, corte/corrupção/adulteração, retenção com arquivos realmente com data retroativa, upload real, listagem independente no bucket, download real a partir do S3 (não cópia manual) seguido de descriptografia/restauração/validação completa, verificação dinâmica de ownership/grants, checagem de saúde/autenticação da aplicação restaurada, verificador de frescor (fresco/atrasado/nunca), proteção de concorrência via `flock` real (container Linux) e ausência de referências a `:latest` nas imagens rclone. Execute via:

```sh
node scripts/backup/drill-backup-recovery.mjs
```

Pré-requisito: um stack de teste do SocialFlow rodando localmente (ex.: `docker compose -f compose.yaml -f compose.test.yaml up`) com um container Postgres cujo nome contenha `socialflow`; se a imagem da API de teste também existir localmente, a validação de aplicação (passo 7) roda automaticamente, senão é reportada como pendência explícita.

Redis usa AOF e volume persistente. Nesta fase contém somente diagnósticos descartáveis; PostgreSQL é a fonte de verdade de identidade e autorização. Antes das fases de publicação, implementar persistência de intenção/outbox e reconciliação, conforme discovery.

## Incidentes e recursos

Readiness 503: confira health de PostgreSQL/Redis, credenciais e migration; não desligue RLS. Falhas de login: observe rate limit compartilhado, Origin exato e relógio; não registrar cookies para investigar. Sessão comprometida: remover sessões do usuário e desativar identidade, depois auditar vínculos. SIGTERM fecha worker com janela de 25s e o compose concede 30s.

Meça `docker stats --no-stream` após seed/login e sob carga real. Não usar uma estimativa como requisito validado de VPS. A imagem inicial compartilha o workspace completo entre serviços para consistência de ferramentas/migrations; há oportunidade de reduzir tamanho com deploy/pruning específico após os gates funcionais.
