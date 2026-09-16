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

### Estado operacional (verificação de 15/09/2026)

Bucket dedicado `socialflow-backups`, prefixo `backups/socialflow/homolog`.
Configuração protegida: `/root/.config/socialflow/backup.env` (0600).
Scripts: `/root/scripts/backup/`. Não exibir configuração, cookies, URLs
assinadas, senhas ou chaves em logs. Variáveis passadas por `docker -e` ainda
podem ser lidas por administradores via inspect; não representam isolamento
contra root ou acesso ao daemon Docker.

O token permanente R2 deve ter **Object Read & Write**, limitado ao bucket
SocialFlow. A política desse token usa recursos Account/Bucket, não prefixos.
Para recuperação, preferir credencial separada Object Read only ou GETs
assinados de curta duração. Não inferir o escopo efetivamente configurado
apenas porque uma operação S3 teve sucesso.
Fonte: [autenticação oficial R2](https://developers.cloudflare.com/r2/api/tokens/).

### Geração, envio e recuperação são estados distintos

- `last_backup.json`: resultado da execução local, com `success_local_only`,
  `success_remote` ou `failed`.
- `last_successful_remote_backup.json`: atualizado somente após upload de
  ambos os arquivos, tamanho exatamente igual, leitura integral do ciphertext
  e SHA256 correspondente, mais leitura e comparação do checksum remoto.
  Uma falha preserva o marcador anterior.
- Recuperação: evidência separada do ensaio. Upload confirmado não prova
  restore nem disponibilidade da aplicação.

A criptografia usa a chave pública GPG na VPS. A privada é utilizada pelo GPG
no computador de recuperação; nunca deve ser copiada para a VPS. O operador
confirmou custódia externa nesta conversa; cofre/MFA não foram inspecionados.
Rclone fixado em `1.68.2`; atualização exige verificação deliberada.

### Agendamento real e fuso

VPS: Ubuntu 22.04, cron `3.0pl1-137ubuntu3`, fuso `America/Sao_Paulo`.
Este cron interpreta as linhas no fuso do daemon/sistema. Definir `TZ=UTC`
para um comando não muda o horário de disparo. Não depender de `CRON_TZ`
sem suporte comprovado no cron instalado.

| Tarefa            | Linha atual | America/Sao_Paulo | UTC   | America/Cuiaba               |
| ----------------- | ----------- | ----------------- | ----- | ---------------------------- |
| Backup            | `0 0 * * *` | 00:00             | 03:00 | 23:00 do dia anterior ao UTC |
| Monitor de atraso | `0 6 * * *` | 06:00             | 09:00 | 05:00                        |

Disparo automático de 15/09 às 03:00 UTC confirmado pelo marcador e pelo
alerta recebido pelo operador. O log do watchdog confirma execução posterior.
Preservar os demais agendamentos da VPS compartilhada ao editar cron.

O watchdog é independente da entrada de backup, mas depende do mesmo cron
e da mesma VPS. **Não detecta queda total da VPS nem a parada do daemon cron.**
Um monitor externo de ausência de sinal permanece pendente. O limite é 26h;
com execução diária às 09:00 UTC, a primeira falha de backup pode ser percebida
cerca de 30h após o último backup, não imediatamente ao ultrapassar 26h.
Datas inválidas/futuras e ausência de marcador causam falha explícita.

### Retenção e primeiro ensaio

`RETENTION_DAYS=0` desativa exclusões; atualmente a configuração persistente
na VPS está em 30 dias (já estava assim quando esta retomada começou).
O ensaio manual de 15/09 usou uma configuração temporária protegida que carrega
a original e redefine `RETENTION_DAYS=0` e `DISCORD_WEBHOOK_URL=""`.
Não houve exclusão de retenção nem envio de teste nesse ensaio.
Não usar a raiz de bucket ou prefixo compartilhado como destino de retenção.
A limpeza atual usa `rclone delete --min-age`; uma falha nessa limpeza ainda é
ignorada pelo script: sucesso do upload não comprova sucesso da retenção.

### Recuperação reproduzível fora da VPS

O ensaio operacional revisado é `scripts/backup/verify-real-recovery.mjs`:

```powershell
node scripts/backup/verify-real-recovery.mjs
```

Requer Windows com Node 24, Git Bash/GPG, Docker Desktop e SSH autorizado.
O caminho de Docker pode ser definido em `DOCKER_BIN`. A chave já custodiada
fica em `.local/recovery/socialflow-recovery.sec.key`; o programa não lê seu
conteúdo, apenas a entrega ao GPG. Não gerar nem substituir essa chave.

O script referencia as imagens da versão `b50ded1eae3149cbb796fca8ebf40a04b59a6c47`
instalada na VPS. Verificar essa referência a cada mudança de versão:

1. Obtém os IDs reais de API e web. Se necessário, transfere as imagens via
   `docker image save` por SSH para `docker image load`, sem deploy. Verifica
   identidade local/remota. Um nome `latest` não comprova equivalência.
2. Usa a configuração R2 na VPS somente para listar e assinar dois GETs com
   validade de dez minutos. As URLs ficam na memória e não são registradas.
3. Baixa os bytes **diretamente do R2 para o computador de recuperação**,
   confere SHA256 e descriptografa localmente em keyring temporário.
4. Cria rede Docker `--internal`, sem portas públicas, e banco/Redis com
   dados em tmpfs. Restaura com `--no-owner --single-transaction --exit-on-error`
   usando migration como dono; não toca em volumes existentes.
5. Verifica migrations, donos, atributos de roles, grants selecionados,
   RLS/FORCE RLS e ausência de default grants amplos para runtime.
6. Cria usuários efêmeros somente no banco restaurado, com senha aleatória,
   para testar login e isolamento. Se faltar segunda organização ativa,
   cria uma fixture identificada como sintética no banco descartável.
7. Valida aplicação restaurada e acesso autorizado/negado. Compara os usuários
   e contas originais restaurados antes/depois sem registrar seus dados.
8. Remove apenas containers/rede/arquivos temporários desta execução.
   Grava resultado sem segredos em `.local/sfverify-*/result.json`.

A transferência de imagens e assinatura dependem de acesso à VPS neste
procedimento. Isso prova recuperação da cópia externa, mas não independência
operacional em uma perda total da VPS: ainda é necessário disponibilizar
imagens e uma credencial de recuperação fora dela.

O `socialflow-restore.sh` continua disponível para diagnóstico em Linux; exige
checksum e permite `INIT_SQL_SCRIPT` para deployments fora do checkout.
Seu healthcheck/401 e teste SQL de ator não substituem login HTTP real. Para
aceite operacional, usar o ensaio acima e examinar o resultado completo.

### Métricas e alertas

Medir do início da obtenção de imagens/acessos e download até o fim das
validações. Registrar separadamente cache de imagens e escopo coberto.
Duração de `pg_restore` ou backup não é RTO completo. A retomada do domínio,
TLS, detecção do incidente e decisão do operador não são medidas neste ensaio.

Idade do último upload é **frescor do backup**, não comprovação do RPO real.
O RPO depende do snapshot consistente recuperado e do instante do incidente;
o marcador atual registra término de upload, não o instante exato do snapshot.
Não usar data de auditoria como substituto dessa evidência.

Webhook Discord: teste anterior autorizado, HTTP 204 e recebimento confirmado
pelo operador. O print comprova recebimento do alerta automático. Não repetir
mensagens de teste sem autorização. O nome do canal/servidor não foi informado.

Testes direcionados: `scripts/backup/test-upload-confirmation.sh` executa em
container Linux descartável, com `/repo` montado somente leitura e sem rede.
Cobre sete casos de confirmação de upload e cinco de frescor. O ensaio MinIO
antigo continua disponível, mas não equivale ao R2 real.

Redis contém diagnósticos descartáveis nesta fase; PostgreSQL é a fonte de
verdade. Filas de publicação futuras exigirão persistência/reconciliação própria.

## Incidentes e recursos

Readiness 503: confira health de PostgreSQL/Redis, credenciais e migration; não desligue RLS. Falhas de login: observe rate limit compartilhado, Origin exato e relógio; não registrar cookies para investigar. Sessão comprometida: remover sessões do usuário e desativar identidade, depois auditar vínculos. SIGTERM fecha worker com janela de 25s e o compose concede 30s.

Meça `docker stats --no-stream` após seed/login e sob carga real. Não usar uma estimativa como requisito validado de VPS. A imagem inicial compartilha o workspace completo entre serviços para consistência de ferramentas/migrations; há oportunidade de reduzir tamanho com deploy/pruning específico após os gates funcionais.
