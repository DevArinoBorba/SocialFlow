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

Agende `pg_dump -Fc` em canal administrativo separado, criptografe o arquivo, copie para destino fora da VPS e monitore sucesso/retenção. Dentro do container postgres, a credencial local é disponibilizada pelo operador; não passar senhas como argumentos. Exemplo de criação sem redirecionar binário pelo PowerShell:

```sh
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/socialflow.dump'
docker compose cp postgres:/tmp/socialflow.dump ./socialflow.dump
```

Armazene o dump fora do repositório. Criptografe usando a chave pública do
responsável por recuperação (por exemplo `gpg --encrypt --recipient ID_DA_CHAVE`
sobre o arquivo), copie para destino externo com acesso restrito e registre
checksum do arquivo criptografado. Defina frequência, retenção e RPO/RTO com o
responsável antes de clientes reais. Monitore falhas e backups atrasados. A chave
privada de recuperação precisa existir fora da VPS e ter custódia testada.

Para restaurar um backup real, use um host/projeto de recuperação com a mesma
imagem PostgreSQL e init de roles. Suba **somente postgres** em volume novo;
não aplique migrations antes de restaurar um dump completo. Após descriptografar
o backup confiável fora do repositório, copie-o para esse container e use um
banco novo de nome explícito. Exemplo, já no projeto isolado `socialflow-recovery`:

```sh
docker compose -p socialflow-recovery up -d --wait postgres
docker compose -p socialflow-recovery cp /CAMINHO_SEGURO/socialflow.dump postgres:/tmp/restore.dump
docker compose -p socialflow-recovery exec -T postgres createdb -U socialflow_migration restore_check
docker compose -p socialflow-recovery exec -T postgres pg_restore -U socialflow_migration -d restore_check --exit-on-error --single-transaction --no-owner /tmp/restore.dump
```

Use env de recuperação com senhas próprias e nome de projeto **novo**, e confira
o volume efetivamente montado antes da execução. `createdb` deve falhar se o
destino já existe; nunca adicione `--clean`, `--create`, `--no-acl` ou remova RLS
para fazer o restore passar. A role de migration passa a ser dona; ACLs são
restauradas e a role runtime continua sem ownership/superuser/BYPASSRLS.

Valide contagens e integridade contra o registro do backup, histórico/checksums
de migrations, flags RLS/FORCE RLS e permissões de runtime. Aponte uma API de
homologação para `restore_check` com a credencial runtime, teste login e acessos
A/B, escrita negada e revogação. Não altere tráfego de produção antes do aceite
do operador. Qualquer migração posterior é aplicada sobre o banco recuperado
somente com imagem compatível e revisão da sequência pendente.

O ensaio automatizado `pnpm test:foundation` executa dump custom e restore em
`restore_check` dentro do PostgreSQL isolado do teste. Compara fingerprints de
todas as tabelas de dados e registros de migrations; verifica login Better Auth,
RLS e escrita cross-organization com runtime. O dump temporário sai com o
container; os volumes ficam preservados. Resultado e duração ficam em
`.local/socialflow-acceptance-*/result.json`. Isso comprova o procedimento local,
não criptografia, destino externo, agenda ou recuperação de uma VPS perdida.

Redis usa AOF e volume persistente. Nesta fase contém somente diagnósticos descartáveis; PostgreSQL é a fonte de verdade de identidade e autorização. Antes das fases de publicação, implementar persistência de intenção/outbox e reconciliação, conforme discovery.

## Incidentes e recursos

Readiness 503: confira health de PostgreSQL/Redis, credenciais e migration; não desligue RLS. Falhas de login: observe rate limit compartilhado, Origin exato e relógio; não registrar cookies para investigar. Sessão comprometida: remover sessões do usuário e desativar identidade, depois auditar vínculos. SIGTERM fecha worker com janela de 25s e o compose concede 30s.

Meça `docker stats --no-stream` após seed/login e sob carga real. Não usar uma estimativa como requisito validado de VPS. A imagem inicial compartilha o workspace completo entre serviços para consistência de ferramentas/migrations; há oportunidade de reduzir tamanho com deploy/pruning específico após os gates funcionais.
