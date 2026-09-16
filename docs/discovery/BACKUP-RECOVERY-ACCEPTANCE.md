# Backup e recuperação — verificação operacional de 15/09/2026

**Parecer: envio real, recuperação isolada de web/API e execução automática
comprovados. Recuperação independente de uma perda total da VPS ainda pendente.**

Esta seção substitui as conclusões do histórico de 14/09 preservado abaixo.
Em particular, o histórico não comprova RPO pelo horário de upload, não prova
RTO completo por uma etapa parcial, nem equivalência de imagens pelo nome
`latest`. `TZ=UTC` não determina o horário do cron Ubuntu instalado.

## Resultado atual por etapa

| Etapa                         | Resultado e evidência                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validação local anterior      | Histórico 25/25 MinIO; não repetido integralmente nesta retomada.                                                                                                                                   |
| Backup automático             | Objeto `socialflow_backup_20260915_030001.dump.gpg`, marcador `success_remote` às 03:00:14 UTC, 15.336 bytes. Print do operador mostra alerta recebido.                                             |
| Integridade do automático     | Em 15/09, leitura integral do R2 produziu `be65184dedbeba4dc12e3357420378e43e95ee98e3fd873f7c99333524668818`, igual ao checksum remoto e ao marcador.                                               |
| Novo upload real com correção | `socialflow_backup_20260915_133033.dump.gpg`, 15.338 bytes, `success_remote` às 13:30:39 UTC, 6s; leitura integral e checksum confirmados. Retenção e mensagens desativadas somente nesta execução. |
| Recuperação real              | Novo objeto baixado diretamente do R2 para Windows/Docker, descriptografado pelo GPG local, restaurado em rede interna descartável, web e API testadas.                                             |
| Agendamento ativo             | Backup `0 0 * * *` e watchdog `0 6 * * *`, já existentes, preservados. Log do watchdog confirma execução e resultado fresco.                                                                        |
| Alertas testados              | Teste anterior autorizado: HTTP 204 e recebimento confirmado. Alerta automático confirmado pelo print. Nenhuma nova mensagem de teste enviada nesta retomada.                                       |
| Queda total da VPS            | Não coberta pelo watchdog local; monitor externo ainda não configurado.                                                                                                                             |

Evidência estruturada sem segredos:
[evidence/backup-recovery-20260915.json](evidence/backup-recovery-20260915.json).
Reprodução: [verify-real-recovery.mjs](../../scripts/backup/verify-real-recovery.mjs).

## Dados e segurança do restore

- Objeto novo: `socialflow_backup_20260915_133033.dump.gpg`.
- SHA256: `e042f0ab901182718b2748efa6aea7d230e76862cd185cbb8f28f34d968a136c`.
- Download direto via HTTPS R2 com GETs assinados de dez minutos. URLs em
  memória; credencial permanente permaneceu na configuração protegida da VPS.
- Chave externa: uso pelo GPG autorizado explicitamente pelo operador; conteúdo
  não lido/exibido pelo agente. Custódia externa é atestação do operador,
  não inspeção de cofre/MFA.
- PostgreSQL 17.11, restore `--no-owner --single-transaction --exit-on-error`.
- Todas as tabelas públicas pertencem a `socialflow_migration`; runtime não é dono.
- Runtime sem superuser, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION ou
  memberships de roles; sem CREATE no schema público.
- SELECT permitido e DELETE/TRUNCATE/REFERENCES/TRIGGER negados nas sete
  tabelas centrais; sem default grants amplos de DELETE/TRUNCATE/TRIGGER.
  Não confundir essa verificação com auditoria exaustiva de cada ACL de coluna.
- RLS e FORCE RLS confirmados nas cinco tabelas protegidas.
- Quatro migrations: foundation, isolation, audit_revocation e brands.
- Inventário antes das fixtures: 6 organizações, 15 usuários, 15 clientes,
  6 marcas e 45 registros de auditoria. Contagens descrevem o dump; não medem RPO.
- Rede Docker `--internal`, nenhuma porta publicada, PostgreSQL/Redis em tmpfs.
  Nenhum dado ou volume existente usado como destino de restauração.

O dataset tinha apenas uma organização ativa com cliente utilizável para o
ensaio. Criou-se a segunda organização e dois usuários efêmeros **somente no
banco descartável**. Houve login Better Auth real em produção, emissão de
sessão e chamadas pelo proxy web: identidade correta, clientes restaurados
visíveis, marcas acessíveis e HTTP 404 nas tentativas entre organizações,
nos dois sentidos. Health retornou 200; chamada anônima a `/api/me`, 401.
A página web `/` retornou HTML. Não houve teste visual com navegador.

Hashes internos dos registros originais de User/Account foram comparados
antes/depois e permaneceram iguais; hashes/dados de usuários não foram
registrados. Containers/rede/arquivos de dump desta execução foram removidos;
imagens obtidas permanecem no cache local.

## Versão e tempos medidos

As imagens reais da VPS são da versão
`b50ded1eae3149cbb796fca8ebf40a04b59a6c47`. O script verifica seus IDs e obtém
as imagens por streaming `docker image save` via SSH para `docker image load`.
Os IDs de API e web estão no JSON de evidência. A API local anterior tinha ID
diferente; sua suposta equivalência não foi usada neste aceite.

**20,528 segundos** no ensaio final: resolução/verificação das imagens em
cache, obtenção de GETs assinados, download R2, hash, GPG, banco, validações de
segurança, API/web prontas e testes autenticados completos pelo proxy web.
Download finalizado em 5,941s desde o início. Esse tempo inclui internet real,
mas foi medido no computador local com imagens já obtidas — não numa máquina
nova sem cache. Não inclui incidente/detecção, decisão humana, DNS, TLS ou
corte de tráfego; portanto não comprova sozinho RTO global de 30 minutos.

O primeiro ensaio trouxe a imagem API (etapa até imagem pronta: 37,855s), mas
falhou por exigir duas organizações ativas; a tentativa inicial com web usava
uma rota `/login` inexistente. Ambos foram corrigidos e os recursos descartáveis
limpos. Não somar trechos de tentativas diferentes para fabricar um RTO.

**RPO permanece não medido.** O marcador registra término de upload, não o
snapshot nem o último commit recuperável. A idade dele serve ao monitoramento
de atraso. Falta registrar o ponto consistente do dump e compará-lo com o
instante do incidente/ensaio e um marcador transacional apropriado.

## Correções instaladas e reversão

1. Upload só confirma sucesso após tamanho exatamente igual, download integral
   para SHA256 e comparação do arquivo de checksum; tamanho maior agora falha.
2. Restore Linux exige checksum; falha de download desse arquivo não é ignorada.
3. Watchdog usa segundos para o limite, e trata marcador ausente, inválido ou
   futuro como falha explícita. Corrigida a alegação de funcionar com cron parado.
4. Novo ensaio operacional usa imagens exatas e login HTTP passando pela web.

Versões anteriores preservadas na VPS em:
`/root/scripts/backup/previous_versions/20260915_integrity_1789479014/`.
Configuração persistente (0600), chave, cron e demais aplicações preservados.
O terminal retornou erro por CR residual após a instalação; a execução manual
subsequente confirmou os scripts funcionais. Verificação final compara hashes.

Retenção persistente já estava em 30 dias e não foi alterada. O ensaio manual
usou override temporário de retenção 0 e webhook vazio. Não houve exclusões
por retenção nesta retomada. Falhas de retenção ainda são ignoradas no script:
o sucesso de backup não comprova a limpeza do destino.

## Horários efetivos

| Tarefa          | America/Sao_Paulo (VPS) | UTC   | America/Cuiaba               |
| --------------- | ----------------------- | ----- | ---------------------------- |
| Backup diário   | 00:00                   | 03:00 | 23:00 do dia anterior ao UTC |
| Watchdog diário | 06:00                   | 09:00 | 05:00                        |

Cron instalado: Ubuntu `3.0pl1-137ubuntu3`, fuso America/Sao_Paulo.
O watchdog de 09:00 UTC foi observado em log com estado fresco. A autorização
para ativação já havia sido aplicada antes desta retomada; não criamos linhas
duplicadas nem alteramos o cron de outra aplicação existente na VPS.

## Testes desta retomada

- 12 testes direcionados em container Linux sem rede: credencial ausente,
  falha de upload, tamanho maior, corrupção, falha de leitura, checksum ausente,
  sucesso; frescor normal, atraso de 26h01min, ausência, data inválida e futura.
  Casos de falha preservam o marcador anterior.
- Integração real R2 → banco → API/web: resultado no JSON, com 12 respostas
  HTTP verificadas e login real nas duas identidades efêmeras.
- Lint, typecheck completo, 15 testes unitários e build de todos os pacotes:
  aprovados. A suíte de integração que modifica o banco de teste existente
  não foi executada; a integração desta revisão usou apenas banco descartável.

## Pendências operacionais explícitas

1. Disponibilizar fora da VPS as imagens corretas e acesso R2 de recuperação.
   O procedimento atual depende da VPS para obter imagens e assinar os GETs;
   ainda não prova recuperação com perda completa da VPS.
2. Confirmar no painel a política efetiva do token permanente: Object Read &
   Write limitado ao bucket dedicado. Sucesso de GET/PUT não atesta escopo.
   A [documentação R2](https://developers.cloudflare.com/r2/api/tokens/)
   descreve recursos Bucket/Account para esse token; não presumir prefixo.
   Credenciais temporárias têm mecanismos próprios de escopo.
3. Monitor externo de ausência de sinal e teste de indisponibilidade: pendentes.
   O watchdog diário local pode levar até o próximo horário para perceber
   atraso; cron/VPS parados impedem seu funcionamento.
4. Medição de RPO e recuperação global com DNS/TLS/corte de tráfego: pendentes.
5. Identificação nominal do canal/servidor de alerta não informada; recebimento
   confirmado pelo operador. Novos testes de mensagens exigem autorização.
6. Retenção: restringir/validar configuração de destino e tornar suas falhas
   observáveis antes de tratar limpeza automática como homologada.

Sem commit, push ou deploy da aplicação nesta retomada. O commit `87abf0c`
já existia quando começamos; mudanças não relacionadas foram preservadas.

---

# Histórico de 14/09 — preservado, conclusões substituídas pela revisão acima

Os textos abaixo contêm afirmações antigas e contraditórias. Servem apenas
como histórico; o estado vigente e suas limitações estão na seção de 15/09.

# Relatório de Aceite de Backup Externo e Recuperação de Desastres (Revisão Independente)

Data da revisão: 14/09/2026
Revisor: independente, sem acesso à VPS de produção/homologação nem a credenciais reais de Cloudflare R2.
Ambiente de verificação: máquina de desenvolvimento local (Windows + Docker Desktop), stack de teste `compose.test.yaml` já em execução, containers e rede efêmeros descartados ao final de cada execução.

Status geral: **CORRIGIDO E RE-VERIFICADO EM AMBIENTE ISOLADO — AINDA NÃO HOMOLOGADO EM PRODUÇÃO**. O relatório anterior (mesma data) continha alegações que a evidência não sustentava; a lista de discrepâncias e as correções aplicadas estão na Seção 1. A Seção 3 lista exatamente o que falta para ativação real e não pode ser resolvido a partir deste ambiente.

---

## 1. Discrepâncias encontradas no relatório anterior e correção aplicada

| #   | Problema encontrado                                                                                                                                                                                                                                                                                                                                | Evidência do problema                                                                                                                                                                                  | Correção aplicada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `socialflow-backup.sh` registrava `status: "success"` e disparava alerta verde "SUCESSO" mesmo sem nenhuma credencial R2 configurada — um backup puramente local era indistinguível de um backup externo confirmado.                                                                                                                               | Código-fonte antes da correção: bloco `else` (sem R2) escrevia no mesmo `STATUS_FILE` com `"status": "success"` e chamava `send_discord_alert("SUCESSO", ...)` incondicionalmente.                     | Estados separados: `success_local_only` (local, sem `remoteUploadConfirmed`) vs `success_remote` (upload verificado). Um segundo arquivo, `last_successful_remote_backup.json`, só é escrito após o upload ser lido de volta do destino e ter o tamanho conferido — é a única fonte válida para RPO/monitoramento. Testado ao vivo: rodar o script real sem credenciais produz `success_local_only` e **não** cria o marcador remoto; com credenciais (MinIO local simulando R2) produz `success_remote` e cria o marcador.                                                                                                                         |
| 2   | A "restauração comprovada" do relatório anterior foi baseada em transferência manual do arquivo `.dump.gpg` da VPS para a máquina do operador — nunca exercitou o código de download via `rclone`/R2 que `socialflow-restore.sh` contém.                                                                                                           | Seção 6 do relatório anterior: "O arquivo ... foi transferido ... para ambiente isolado". Nenhuma menção a `rclone copy` real.                                                                         | `socialflow-restore.sh` agora roda de fato o download (`rclone lsf` + `copy`) contra um destino S3 compatível real (MinIO local, sem credenciais reais de R2) antes de decriptar/restaurar. Testado ao vivo, ponta a ponta: upload real → listagem independente no bucket → download real → decrypt → restore → validação. Saída do script confirma `Backup source exercised: r2:...` (não um caminho local).                                                                                                                                                                                                                                       |
| 3   | Verificação de ownership cobria só 3 tabelas (`Brand`, `Client`, `Organization`) de 10 existentes no schema; nenhuma verificação de que `socialflow_runtime` não tem `DELETE` em tabelas centrais além de `Brand`; nenhuma validação de que a aplicação restaurada realmente funciona (isolamento/autenticação/saúde) — apenas invariantes de SQL. | `pg_tables WHERE tablename IN ('Brand','Client','Organization')` — schema real tem `User, Session, Account, Verification, RateLimit, Organization, Client, Membership, Brand, AuditLog`.               | Ownership verificado dinamicamente contra **todas** as tabelas de `public` (nenhuma lista fixa), mais confirmação de que `socialflow_runtime` não é dono de nenhuma. `DELETE` verificado como ausente em `User, Organization, Membership, Client, Brand, AuditLog, Account`. Novo passo de validação de aplicação: sobe a imagem real da API na rede isolada, aponta para o banco restaurado com a role `socialflow_runtime`, confirma `GET /health/ready` e que uma chamada não autenticada a `/api/me` retorna 401 (prova que autenticação consulta o schema restaurado com sucesso). Testado ao vivo com a imagem `socialflow-test-api`: passou. |
| 4   | RTO reportado (0,78s) media apenas o passo `pg_restore`, não o procedimento completo; RPO reportado usava a data do último registro de `AuditLog` (dado da fonte, não da cópia externa).                                                                                                                                                           | Seção 6.2/6.3 do relatório anterior.                                                                                                                                                                   | Cronômetro do RTO movido para antes da localização/download do artefato, cobrindo download+verificação+decrypt+restore+validação+checagem de aplicação. RPO agora calculado como idade de `last_successful_remote_backup.json`. Medido ao vivo neste ambiente: RTO completo ≈ 12–13s (ver Seção 2; **não é o RTO real da VPS**, ver Seção 3).                                                                                                                                                                                                                                                                                                       |
| 5   | Nenhum verificador de atraso independente do cron do próprio backup; teste de concorrência (`flock`) alegado no relatório mas ausente do script de ensaio; teste de retenção nunca de fato criava arquivos com data antiga (usava apenas nomes sugerindo idade, sem alterar `mtime`), então não podia detectar uma poda quebrada.                  | Relatório anterior, item 6 da bateria de testes ("Proteção contra concorrência") sem código correspondente em `drill-backup-recovery.mjs`; teste de retenção escrevia os 3 arquivos com `mtime` atual. | Criado `scripts/backup/check-backup-freshness.sh`, independente do cron do backup (só lê o marcador). Teste de concorrência real adicionado (container Linux, `flock` de verdade, mesmo padrão `exec FD>lock; flock -n FD`). Teste de retenção corrigido para retroceder `mtime` de fato (40 dias) e afirmar que o arquivo antigo é removido e o recente/fora do prefixo não são.                                                                                                                                                                                                                                                                   |
| 6   | Fuso do cron não confirmado contra o relógio real da VPS; `rclone/rclone:latest` usado em 3 scripts, sujeito a mudança de comportamento sem aviso.                                                                                                                                                                                                 | `docs/OPERATIONS.md` (versão anterior) e scripts.                                                                                                                                                      | Linha de cron documentada com `TZ=UTC` explícito (remove ambiguidade independente do fuso do sistema, mas a verificação contra o relógio real da VPS continua pendente — ver Seção 3). Imagem fixada em `rclone/rclone:1.68.2` nos três scripts que a usam; regressão coberta por teste automatizado (grep por `:latest`).                                                                                                                                                                                                                                                                                                                          |
| 7   | Custódia de chave descrita como fato consumado ("cofre... MFA... cópia física") sem qualquer verificação possível a partir deste ambiente.                                                                                                                                                                                                         | Seção 4 do relatório anterior.                                                                                                                                                                         | Reformulado: a separação de custódia (VPS só decripta com a pública; only o operador decripta com a privada) foi **demonstrada** neste ambiente — keyring "só público" tentando decriptar falha explicitamente, keyring com a privada decripta com sucesso. As alegações sobre cofre físico, MFA e cópia offline continuam sendo **atestação do operador**, não verificação técnica, e são descritas como tal a partir de agora.                                                                                                                                                                                                                    |

---

## 2. Evidência real desta revisão (execução completa, 14/09/2026)

Todas as verificações abaixo foram executadas de fato nesta sessão, contra os scripts reais (`socialflow-backup.sh`, `socialflow-restore.sh`, `check-backup-freshness.sh`), usando `scripts/backup/drill-backup-recovery.mjs` reescrito para orquestrar tudo isso contra um MinIO local (credenciais descartáveis, geradas por execução, nunca reais) como substituto do Cloudflare R2. Nenhuma credencial real de R2, GPG de produção ou dado de produção foi usada ou exposta.

```
DRILL SUMMARY: 25/25 CHECKS PASSED
DRILL SUCCESSFUL! All backup and disaster recovery requirements verified.
```

Destaques da execução real (não simulação):

- **Backup sem credenciais R2** → `status: "success_local_only"`, `remoteUploadConfirmed: false`, nenhum `last_successful_remote_backup.json` criado.
- **Backup com credenciais (MinIO)** → `status: "success_remote"`, `remoteUploadConfirmed: true`, objeto confirmado por listagem independente no bucket (não apenas autorrelato do script).
- **Restauração real via download S3** → `Backup source exercised: r2:socialflow-backups-test/...`, decrypt com keyring contendo **apenas a chave privada** (sem a pública residual da VPS), restore `--no-owner`, todas as tabelas de `public` com dono `socialflow_migration`, nenhuma com `DELETE` para `socialflow_runtime` nas tabelas centrais, aplicação real (`socialflow-test-api`) subida na rede isolada e validada (`health/ready` + `401` em rota protegida sem sessão).
- **RTO completo medido**: **~12–13 segundos** neste ambiente (download + verificação + decrypt + restore + validações + boot da aplicação) — substituindo os 0,78s anteriores, que mediam só o `pg_restore`.
- **RPO**: calculado a partir do `last_successful_remote_backup.json` mais recente (idade em horas), nunca da data de um registro de auditoria.
- **Custódia de chave**: keyring "só público" (simulando a VPS) falhou ao decriptar (`decryption failed: No secret key`); keyring com a chave privada decriptou com sucesso.
- **Concorrência**: uma segunda execução simultânea do padrão `flock` usado no script é rejeitada (`REJECTED`, código de saída 1), verificado em container Linux real.
- **Retenção**: arquivo com `mtime` retroagida 40 dias é removido por `rclone delete --min-age 30d`; arquivo recente e arquivo fora do prefixo dedicado (mesmo que antigo) são preservados.
- **Verificador de frescor**: fresco → sai 0; 48h de atraso → sai 1 (crítico); nunca houve backup externo → sai 2 (crítico) — e por construção não depende do cron do backup em si.
- **Regressão de imagem**: nenhum script referencia `rclone/rclone:latest`.

Containers, redes e diretórios temporários usados no ensaio foram todos efêmeros e destruídos ao final; nenhum dado ou volume de produção/homologação foi alterado.

---

## 3. Pendências que exigem decisão ou acesso do operador (não resolvíveis a partir deste ambiente)

Nenhum segredo foi solicitado ou exposto para produzir esta lista.

1. **Credenciais reais do Cloudflare R2** (bucket `socialflow-backups`, token de API com leitura/escrita no prefixo `backups/socialflow/homolog/`). Sem isso, o primeiro envio real e a primeira recuperação real a partir do R2 de produção continuam não realizados — o que foi comprovado aqui é o _mecanismo_ (protocolo S3, mesmo código, credenciais diferentes), não o destino final.
2. **Fuso horário real do crond da VPS**: rodar `timedatectl` e `date -u` na VPS e comparar com o horário local do sistema. A linha de cron documentada já fixa `TZ=UTC` para remover a ambiguidade, mas isso não foi confirmado contra a VPS real.
3. **Disponibilidade da imagem da aplicação na VPS/host de recuperação** para o passo 7 do procedimento (validação de isolamento/autenticação/saúde). `socialflow-restore.sh` já faz essa checagem automaticamente quando a imagem existe localmente (`SOCIALFLOW_APP_IMAGE`); em um host de recuperação sem a imagem, o script reporta `[PENDING]` explicitamente em vez de contar como aprovado — decidir se o processo de recuperação real vai puxar a imagem de um registry ou construí-la localmente.
4. **Verificação da custódia física da chave privada** (cofre, MFA, cópia offline): permanece atestação do operador; nenhuma ferramenta disponível aqui pode confirmar isso. O que foi tecnicamente demonstrado é apenas a separação criptográfica (VPS não decripta).
5. **Ativação do cron de backup e do verificador de frescor na VPS real** — deliberadamente **não realizada** nesta revisão, por instrução explícita. As linhas prontas estão em `docs/OPERATIONS.md`.
6. **Medição de RTO/RPO na infraestrutura real**: os ~12–13s medidos aqui refletem hardware/rede locais de desenvolvimento, não a VPS de produção nem a latência real de download do R2 (que tende a ser o fator dominante). Repetir a medição com `socialflow-restore.sh` apontando para o R2 real antes de declarar o SLA de 30 minutos como validado.

---

## 4. Como reproduzir esta verificação

```sh
# Pré-requisito: stack de teste rodando (docker compose -f compose.yaml -f compose.test.yaml up)
node scripts/backup/drill-backup-recovery.mjs
```

O script cria e destrói seus próprios containers/redes MinIO e PostgreSQL de recuperação; não requer e não deve receber credenciais reais de R2.

---

## 5. Homologação do Backup Externo Real no Cloudflare R2 e Ativação do Cron (14/09/2026)

Com o fornecimento seguro das credenciais R2 na VPS e autorização do operador, o ciclo completo de produção/homologação foi executado e homologado:

### 5.1 Configuração Real e Primeiro Backup

- **Destino:** Cloudflare R2 (Bucket dedicado: `socialflow-backups`, Endpoint: `https://0a510deeb627ca48cd55f39ea505b32e.r2.cloudflarestorage.com`, Prefixo: `backups/socialflow/homolog`).
- **Credenciais:** Token de API R2 com escopo restrito (_Object Read & Write_) no bucket `socialflow-backups`, configurado em `/root/.config/socialflow/backup.env` com permissão restrita `0600`.
- **Disparo manual inicial com retenção desativada (`RETENTION_DAYS=0`):**
  - Artefato gerado: `socialflow_backup_20260914_213041.dump.gpg` (15.340 bytes).
  - Checksum SHA256: `0a1c62d1fa681dce8601524e2e8141f8e7e30e9bf76243cec547f8392d405ab9`.
  - Upload para Cloudflare R2: verificado remotamente com tamanho idêntico (`Remote verification passed: 15340 bytes in R2`).
  - Status registrado na VPS: `success_remote` em `/root/backups/socialflow/last_backup.json` e arquivo `/root/backups/socialflow/last_successful_remote_backup.json` criado.
  - Alerta de sucesso emitido para o Discord.

### 5.2 Ensaio de Recuperação a partir do Cloudflare R2

1. **Download do R2:** Artefato baixado diretamente do Cloudflare R2 via `rclone copy` em ambiente isolado.
2. **Conferência SHA256:** Hash SHA256 do arquivo baixado bateu 100% com o arquivo de checksum.
3. **Custódia e Decifragem:** O arquivo foi decifrado fora da VPS utilizando a chave privada GPG do custodiante (`socialflow-recovery.sec.key`), confirmando a separação de custódia.
4. **TOC Verification:** `pg_restore -l` validou 113 entradas, estrutura de banco e integridade dos dados comprimidos.
5. **Restauração em PostgreSQL 17.11 isolado:**
   - Restauração efetuada via `pg_restore -U socialflow_migration -d socialflow --single-transaction --exit-on-error`.
   - **RTO medido:** 0.15s para a restauração do banco; tempo total do ciclo < 30 segundos (SLA de 30 minutos amplamente atendido).
6. **Validação Estrutural e de Segurança pós-restore:**
   - 4 migrações do Prisma confirmadas (incluindo `202609140001_brands`).
   - RLS ativo e `FORCE ROW LEVEL SECURITY` ativo nas 5 tabelas sensíveis (`AuditLog`, `Brand`, `Client`, `Membership`, `Organization`).
   - Trigger `protect_brand_scope` ativo em `Brand`.
   - Role `socialflow_runtime`: confirmada sem permissão de `DELETE` em tabelas centrais e com proteção de integridade nas colunas de escopo (`clientId` não atualizável).
   - Contagem de registros íntegra: 6 Organizações, 15 Usuários, 15 Clientes, 6 Marcas, 45 Logs de Auditoria.

### 5.3 Validação da Aplicação em Homologação

- URL: `https://homolog-socialflow.oriumdigital.com.br`
- Resposta HTTP: `200 OK` (Next.js prerender / cache HIT).

### 5.4 Ativação da Retenção e Agendamento Automático

- **Retenção:** Atualizada para `RETENTION_DAYS=30` em `/root/.config/socialflow/backup.env` na VPS.
- **Fuso Horário da VPS:** Confirmado via `timedatectl` como `America/Sao_Paulo (-03:00)`.
- **Crontab Ativo do root:**
  ```cron
  # SocialFlow Automated Encrypted Backup (00:00 America/Sao_Paulo = 03:00 UTC)
  0 0 * * * /root/scripts/backup/socialflow-backup.sh >> /var/log/socialflow-backup.log 2>&1

  # SocialFlow Backup Freshness Watchdog (06:00 America/Sao_Paulo = 09:00 UTC)
  0 6 * * * /root/scripts/backup/check-backup-freshness.sh >> /var/log/socialflow-backup-watchdog.log 2>&1
  ```
- **Watchdog de Frescor Testado:** Executado e validado:
  `[OK] Last confirmed external backup: 2026-09-14T21:31:08Z (0h ago, within 26h)`.

---

## 6. Aceite da Recuperação da Aplicação Conectada ao Banco Restaurado do R2 (14/09/2026)

Em cumprimento ao critério final de homologação da recuperação de desastres, a aplicação foi colocada em funcionamento em ambiente isolado, conectada **exclusivamente** ao banco restaurado a partir do Cloudflare R2, sem utilizar a homologação externa como evidência e sem alterar senhas de usuários reais.

### 6.1 Identificação da Versão da Aplicação

- **Commit:** `b50ded1eae3149cbb796fca8ebf40a04b59a6c47`
- **Mensagem:** `feat(brands): implement textual brand management per client with RLS and mobile responsiveness`
- **Imagem Docker utilizada:** `socialflow-test-api:latest` (idêntica à versão compilada em homologação).
- **Topologia isolada:** Rede Docker efêmera contendo `dr-postgres` (PostgreSQL 17.11-alpine), `dr-redis` (Redis 8.10.0-alpine) e `dr-api` (porta host temporária 59101), sem acesso à base real da VPS.

### 6.2 Métricas de Recuperação (Diferenciação de Tempos)

- **Duração do `pg_restore` puro:** **0,82 segundos** (tempo exclusivo de execução do utilitário `pg_restore` restaurando o dump para o PostgreSQL com `--single-transaction --exit-on-error`).
- **Tempo do trecho medido até a API restaurada ficar pronta:** **27,20 segundos** (tempo cronometrado do ensaio isolado: decifragem assimétrica GPG Cv25519 do arquivo já presente localmente, provisionamento da rede efêmera, inicialização dos containers de banco e Redis, restauração completa dos dados, configuração de runtime, subida do container da API e resposta positiva de readiness em `GET /health/ready`).
  - _Delimitação de escopo da medição:_ Este trecho de 27,20s **não inclui** o tempo de download do arquivo a partir da rede do Cloudflare R2 (variável conforme a banda WAN) nem a subida/recuperação da interface web (frontend Next.js), limitando-se estritamente ao núcleo de dados e API de serviços restaurada e funcional.
- **Conformidade de SLA:** Ambos os tempos atendem ao RTO estabelecido de $\le 30$ minutos com ampla margem de segurança.

### 6.3 Resultados dos Testes Funcionais Autenticados

Para realizar os testes autenticados sem violar o requisito de **preservar intocadas as senhas e contas de usuários reais** (como `arinoborba@gmail.com`), foram criadas credenciais efêmeras de verificação para as organizações de teste no banco isolado:

| Teste                                  | Descrição                                                | Resultado Esperado                   | Resultado Observado                                         | Status      |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- | ----------- |
| **Readiness**                          | Chamada `GET /health/ready` na API isolada               | HTTP 200 `{"status":"ready"}`        | HTTP 200 `{"status":"ready"}`                               | ✅ Aprovado |
| **Login Autenticado**                  | Login via Better Auth (`POST /api/auth/sign-in/email`)   | HTTP 200 + Cookie de sessão          | HTTP 200 (sessão emitida)                                   | ✅ Aprovado |
| **Sessão e Identidade**                | Chamada `GET /api/me` com o cookie emitido               | HTTP 200, usuário e vínculo corretos | HTTP 200 (usuário vinculado à Org Orium Digital restaurada) | ✅ Aprovado |
| **Acesso Autorizado (Clientes)**       | `GET /api/organizations/{orgA}/clients`                  | HTTP 200, clientes restaurados       | HTTP 200 (Cliente Teste retornado)                          | ✅ Aprovado |
| **Acesso Autorizado (Marcas)**         | `GET /api/organizations/{orgA}/clients/{clientA}/brands` | HTTP 200, marcas restauradas         | HTTP 200 (marcas restauradas retornadas)                    | ✅ Aprovado |
| **Isolamento Multi-Tenant (Clientes)** | Usuário da Org A tentando listar clientes da Org B       | HTTP 404 (Bloqueio estrito RLS)      | HTTP 404 (Sem vazamento de dados)                           | ✅ Aprovado |
| **Isolamento Multi-Tenant (Marcas)**   | Usuário da Org A tentando acessar marcas da Org B        | HTTP 404                             | HTTP 404 (Bloqueio estrito)                                 | ✅ Aprovado |
| **Isolamento Reverso**                 | Usuário da Org B tentando listar clientes da Org A       | HTTP 404                             | HTTP 404 (Bloqueio estrito)                                 | ✅ Aprovado |
| **Preservação de Usuários Reais**      | Integridade de `arinoborba@gmail.com`                    | Senhas e dados reais inalterados     | 100% inalterados e protegidos                               | ✅ Aprovado |

### 6.4 Limitações Operacionais e Riscos Residuais

1. **Primeira Execução Automática do Cron Pendente:** O agendamento está configurado no crontab da VPS (`0 0 * * *` correspondente às 00:00 no fuso de Brasília / 03:00 UTC), mas o primeiro disparo automático programado ainda precisa ser conferido após a meia-noite para homologar a execução autônoma do daemon cron da VPS.
2. **Alcance do Watchdog de Frescor Local:** O script `check-backup-freshness.sh` está agendado localmente na VPS (`0 6 * * *` Brasília / 09:00 UTC). Por rodar na própria máquina, ele detecta falhas de dump, upload, R2 ou cron desativado, mas **não detecta uma queda total ou indisponibilidade da VPS**. Para o ambiente de produção, é recomendada a inclusão de um monitor externo com _dead man's switch_ (ex: BetterStack, Healthchecks.io ou Uptime Kuma) que alerte caso a VPS deixe de emitir o sinal de batimento cardíaco diário.
