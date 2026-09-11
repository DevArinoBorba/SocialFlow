# Operação centralizada no Coolify

## Publicação

Use um único recurso Docker Compose na VPS da agência, apontando para o repositório e o compose da raiz. Build local não equivale a deploy homologado. Defina no Coolify `APP_ENV=production`, `APP_URL=https://dominio-da-agencia`, senhas independentes de PostgreSQL/Redis/runtime e SESSION_SECRET aleatório. Nenhum segredo tem fallback de desenvolvimento. Configure domínio/TLS somente no serviço web, porta interna 3000. API, worker, PostgreSQL e Redis ficam na rede privada. Remova o mapeamento loopback web se o roteador do Coolify usar apenas a rede interna; nunca adicione portas públicas aos dados. Não configure domínio nos serviços internos.

O Coolify utiliza os healthchecks declarados no compose. Readiness consulta banco/Redis com timeout, e web consulta a API. Migration roda uma única vez antes de API/worker. Uma migration falha bloqueia a subida. API e worker devem usar role `socialflow_runtime`, sem superuser/BYPASSRLS e sem ownership das tabelas. Nunca substitua DATABASE_URL pela URL de migration para corrigir um erro de permissão.

Bootstrap de produção: criar identidade, conta de senha com hashing Better Auth e vínculos por ferramenta administrativa revisada, usando segredo recebido por canal seguro. O seed de desenvolvimento é explicitamente proibido. A homologação inicial é NO-GO para clientes reais enquanto pipeline remota, provisionamento operacional e restore não estiverem demonstrados.

## Migrations e rollback

Migrations estão em `packages/db/prisma/migrations`. O primeiro SQL é gerado do schema; o segundo adiciona RLS, grants e constraints. Prisma migrate deploy registra checksums e ignora migrations já aplicadas. Revisar ambos em qualquer mudança de schema. A senha da role runtime é criada apenas na inicialização de volume vazio; mudar env não muda senha no PostgreSQL existente. Rotacione por conexão de operador com `ALTER ROLE` e atualize o secret coordenadamente, sem colocar senha em logs ou histórico do terminal.

Rollback de aplicação: mantenha imagem/commit anterior e restaure apenas se compatível com o schema vigente. Mudança de banco incompatível pede migration corretiva ou restore. Não edite migrations já aplicadas, não execute reset e não use `down -v` em dados que devam ser preservados.

## Backup e restore

Agende `pg_dump -Fc` em canal administrativo separado, criptografe o arquivo, copie para destino fora da VPS e monitore sucesso/retenção. Dentro do container postgres, a credencial local é disponibilizada pelo operador; não passar senhas como argumentos. Exemplo de criação sem redirecionar binário pelo PowerShell:

```sh
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/socialflow.dump'
docker compose cp postgres:/tmp/socialflow.dump ./socialflow.dump
```

Armazene o dump fora do repositório. Valide restauração em banco/volume isolado, usando a mesma versão de PostgreSQL, roles criadas pelo init e `pg_restore --exit-on-error --no-owner` com a role de migration. Verifique contagens, login e RLS com a role runtime antes de qualquer troca de tráfego. Registre duração, data e resultado do restore; até ser executado, este runbook não prova recuperação.

Redis usa AOF e volume persistente. Nesta fase contém somente diagnósticos descartáveis; PostgreSQL é a fonte de verdade de identidade e autorização. Antes das fases de publicação, implementar persistência de intenção/outbox e reconciliação, conforme discovery.

## Incidentes e recursos

Readiness 503: confira health de PostgreSQL/Redis, credenciais e migration; não desligue RLS. Falhas de login: observe rate limit compartilhado, Origin exato e relógio; não registrar cookies para investigar. Sessão comprometida: remover sessões do usuário e desativar identidade, depois auditar vínculos. SIGTERM fecha worker com janela de 25s e o compose concede 30s.

Meça `docker stats --no-stream` após seed/login e sob carga real. Não usar uma estimativa como requisito validado de VPS. A imagem inicial compartilha o workspace completo entre serviços para consistência de ferramentas/migrations; há oportunidade de reduzir tamanho com deploy/pruning específico após os gates funcionais.
