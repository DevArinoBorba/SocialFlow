# Relatório de Implantação e Validação em Homologação — Fase 2 (Marcas)

Data de execução: 14/09/2026  
Status: **IMPLANTADO E VALIDADO EM HOMOLOGAÇÃO** (100% dos testes aprovados na VPS)  
Ambiente avaliado: **Homologação Externa Oficial (HTTPS)** e **VPS HostGator / Coolify (`143.95.160.244`)**

---

## 1. Identificação do Commit e do Deploy

| Parâmetro               | Valor Observado                                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repositório**         | `https://github.com/DevArinoBorba/SocialFlow`                                                                                                                                                                                                                                                                   |
| **Branch**              | `master`                                                                                                                                                                                                                                                                                                        |
| **Commit implantado**   | `b50ded1eae3149cbb796fca8ebf40a04b59a6c47`                                                                                                                                                                                                                                                                      |
| **Mensagem do commit**  | `feat(brands): implement textual brand management per client with RLS and mobile responsiveness`                                                                                                                                                                                                                |
| **Coolify Recurso**     | `socialflow-homolog` (UUID: `4iuijgj7ocivevuow4yga8z7`)                                                                                                                                                                                                                                                         |
| **Coolify Deploy UUID** | `5akjfok8xoe3kr1oonuqilj7`                                                                                                                                                                                                                                                                                      |
| **Status do Deploy**    | `finished` (concluído com sucesso em 14/09/2026 17:40:58 UTC)                                                                                                                                                                                                                                                   |
| **Domínio Homologação** | `https://homolog-socialflow.oriumdigital.com.br`                                                                                                                                                                                                                                                                |
| **Certificado TLS**     | Let's Encrypt (R12), válido até 12/12/2026                                                                                                                                                                                                                                                                      |
| **Imagens geradas**     | `4iuijgj7ocivevuow4yga8z7_web:b50ded1eae3149cbb796fca8ebf40a04b59a6c47`<br>`4iuijgj7ocivevuow4yga8z7_api:b50ded1eae3149cbb796fca8ebf40a04b59a6c47`<br>`4iuijgj7ocivevuow4yga8z7_worker:b50ded1eae3149cbb796fca8ebf40a04b59a6c47`<br>`4iuijgj7ocivevuow4yga8z7_migrate:b50ded1eae3149cbb796fca8ebf40a04b59a6c47` |

---

## 2. Backup Pré-Migration Realizado

Conforme os requisitos operacionais de segurança antes da aplicação da migration `202609140001_brands`:

| Parâmetro                 | Detalhe                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Caminho do arquivo**    | `/root/backups/socialflow/backup_pre_brands_20260914.dump`                                                                                                                                                                                       |
| **Data e hora**           | 14/09/2026 às 16:37:03 UTC                                                                                                                                                                                                                       |
| **Tamanho**               | 38 KB                                                                                                                                                                                                                                            |
| **Permissões**            | `0600` (`-rw-------`, leitura e escrita restritas exclusivamente ao root)                                                                                                                                                                        |
| **Validação do catálogo** | Verificado via `pg_restore -l` (94 entradas no TOC, formato CUSTOM, PostgreSQL 17.11)                                                                                                                                                            |
| **Limitações do backup**  | A leitura do catálogo comprova a integridade estrutural do arquivo gerado, mas **não substitui** um ensaio completo de restauração de desastres em banco isolado da VPS (que permanece como pendência operacional antes de clientes comerciais). |

---

## 3. Resultado da Migration e Saúde dos Serviços

### 3.1. Execução da Migration

O container temporário `migrate-4iuijgj7ocivevuow4yga8z7-165246285411` executou a migração com código de saída `0`:

```
Applying migration `202609140001_brands`
The following migration(s) have been applied:
migrations/
  └─ 202609140001_brands/
    └─ migration.sql
All migrations have been successfully applied.
```

Registro na tabela `_prisma_migrations` da VPS:

- `202609140001_brands` aplicada em `2026-09-14 17:40:51.995547+00`.
- Total de 4 migrations presentes e finalizadas.

### 3.2. Saúde dos Containers em Produção

Todos os 5 serviços principais do Docker Compose encontram-se em execução e saudáveis (`healthy`):

- `web`: `Up (healthy)`, porta interna 3000 exposta via Traefik.
- `api`: `Up (healthy)`, conectado via rede interna com role não-privilegiada `socialflow_runtime`.
- `worker`: `Up (healthy)`, conectado ao Redis e PostgreSQL via role `socialflow_runtime`.
- `postgres`: `Up (healthy)`, PostgreSQL 17.11-alpine com RLS/FORCE RLS ativos.
- `redis`: `Up (healthy)`, Redis 8.10.0-alpine.

### 3.3. Endpoint de Readiness

- Chamada `GET https://homolog-socialflow.oriumdigital.com.br/health/ready`:
  - Retorno: `HTTP 200 OK`
  - Corpo: `{"status":"ready"}`
  - TLS: Válido, sem bypass.

### 3.4. Invariantes de Banco de Dados

- `Brand`: `relrowsecurity = true`, `relforcerowsecurity = true`.
- `protect_brand_scope`: Trigger habilitada e ativa na tabela `Brand`.
- Role `socialflow_runtime`: Sem `SUPERUSER`, sem `BYPASSRLS`, sem concessão de `UPDATE` nas colunas `organizationId`, `clientId` ou `id`, e sem permissão de `DELETE` físico.

---

## 4. Testes Executados Efetivamente na VPS

Uma bateria automatizada de 44 cenários foi executada diretamente contra a infraestrutura remota HTTPS da homologação e o PostgreSQL da VPS.

### 4.1. Suite 1: Matriz de Permissões por Perfil (Marcas)

| #    | Cenário                             | Perfil           | Resultado Esperado | Resultado Observado                  | Status    |
| ---- | ----------------------------------- | ---------------- | ------------------ | ------------------------------------ | --------- |
| 1.1  | Criação de marca na organização     | OWNER            | HTTP 201           | HTTP 201 (id gerado)                 | ✅ Passou |
| 1.2  | Listagem de marcas do cliente       | OWNER            | HTTP 200           | HTTP 200 (marcas retornadas)         | ✅ Passou |
| 1.3  | Consulta detalhada da marca         | OWNER            | HTTP 200           | HTTP 200 (dados completos)           | ✅ Passou |
| 1.4  | Edição de campos textuais           | OWNER            | HTTP 200           | HTTP 200 (dados atualizados)         | ✅ Passou |
| 1.5  | Criação em qualquer cliente da org  | ADMIN            | HTTP 201           | HTTP 201 (id gerado)                 | ✅ Passou |
| 1.6  | Edição de marca da org              | ADMIN            | HTTP 200           | HTTP 200 (atualizado)                | ✅ Passou |
| 1.7  | Criação no cliente vinculado A1     | EDITOR A1        | HTTP 201           | HTTP 201 (id gerado)                 | ✅ Passou |
| 1.8  | Edição no cliente vinculado A1      | EDITOR A1        | HTTP 200           | HTTP 200 (atualizado)                | ✅ Passou |
| 1.9  | Criação em cliente não vinculado A2 | EDITOR A1        | HTTP 404           | HTTP 404 ("Cliente não encontrado.") | ✅ Passou |
| 1.10 | Listagem no cliente vinculado A1    | APPROVER A1      | HTTP 200           | HTTP 200                             | ✅ Passou |
| 1.11 | Tentativa de criação de marca       | APPROVER A1      | HTTP 403           | HTTP 403 ("não pode criar marcas")   | ✅ Passou |
| 1.12 | Tentativa de edição de marca        | APPROVER A1      | HTTP 403           | HTTP 403 ("não pode editar marcas")  | ✅ Passou |
| 1.13 | Listagem no cliente vinculado A1    | CLIENT_VIEWER A1 | HTTP 200           | HTTP 200                             | ✅ Passou |
| 1.14 | Tentativa de criação de marca       | CLIENT_VIEWER A1 | HTTP 403           | HTTP 403 ("não pode criar marcas")   | ✅ Passou |
| 1.15 | Tentativa de edição de marca        | CLIENT_VIEWER A1 | HTTP 403           | HTTP 403 ("não pode editar marcas")  | ✅ Passou |

### 4.2. Suite 2: Isolamento entre Organizações e Clientes (IDOR)

| #   | Cenário                                                   | Ator      | Resultado Esperado     | Resultado Observado                                | Status    |
| --- | --------------------------------------------------------- | --------- | ---------------------- | -------------------------------------------------- | --------- |
| 2.1 | Admin A tenta listar marcas da Org B                      | ADMIN A   | HTTP 404               | HTTP 404                                           | ✅ Passou |
| 2.2 | Admin B tenta listar marcas da Org A                      | ADMIN B   | HTTP 404               | HTTP 404                                           | ✅ Passou |
| 2.3 | Admin A detalha marca de Org B via URL da Org A           | ADMIN A   | HTTP 404               | HTTP 404 ("Marca não encontrada.")                 | ✅ Passou |
| 2.4 | **R-1**: Editor A1 consulta marca de A2 via URL de A1     | EDITOR A1 | HTTP 404 sem vazamento | HTTP 404 ("Marca não encontrada."), zero vazamento | ✅ Passou |
| 2.5 | **R-1**: Editor A1 tenta editar marca de A2 via URL de A1 | EDITOR A1 | HTTP 404               | HTTP 404 ("Marca não encontrada.")                 | ✅ Passou |
| 2.6 | **R-1**: Invariante de integridade no banco               | SISTEMA   | Marca de A2 inalterada | Campos e updatedAt inalterados                     | ✅ Passou |
| 2.7 | **R-1**: Invariante de auditoria                          | SISTEMA   | Nenhum log gerado      | Contagem de auditoria inalterada                   | ✅ Passou |
| 2.8 | **R-1**: Controle positivo de consulta                    | EDITOR A1 | HTTP 200               | HTTP 200 (marca autorizada de A1)                  | ✅ Passou |
| 2.9 | **R-1**: Controle positivo de edição                      | EDITOR A1 | HTTP 200               | HTTP 200 (marca autorizada de A1 atualizada)       | ✅ Passou |

### 4.3. Suite 3: Imutabilidade de Escopo

| #   | Cenário                                     | Mecanismo                     | Resultado Esperado  | Resultado Observado                | Status    |
| --- | ------------------------------------------- | ----------------------------- | ------------------- | ---------------------------------- | --------- |
| 3.1 | Mass assignment na API com `clientId` extra | Zod `strictObject`            | HTTP 400            | HTTP 400 (rejeição de campo extra) | ✅ Passou |
| 3.2 | Alteração de escopo via SQL direto          | Trigger `protect_brand_scope` | Bloqueado com 42501 | Bloqueado (`ERRCODE 42501`)        | ✅ Passou |

### 4.4. Suite 4: Revogação com Sessão Aberta

| #   | Cenário                               | Procedimento                | Resultado Esperado        | Resultado Observado                        | Status    |
| --- | ------------------------------------- | --------------------------- | ------------------------- | ------------------------------------------ | --------- |
| 4.1 | Acesso antes da revogação             | Sessão ativa                | HTTP 200                  | HTTP 200                                   | ✅ Passou |
| 4.2 | Leitura de auditoria da marca própria | Role `socialflow_runtime`   | Logs visíveis             | 3 linhas retornadas                        | ✅ Passou |
| 4.3 | Revogação de vínculo no banco         | `Membership.active = false` | HTTP 404 imediato         | HTTP 404 imediato (corte sem logout)       | ✅ Passou |
| 4.4 | Auditoria RLS pós-revogação           | Role `socialflow_runtime`   | 0 linhas                  | 0 linhas retornadas (histórico protegido)  | ✅ Passou |
| 4.5 | Restauração de vínculo                | `Membership.active = true`  | HTTP 200 com mesmo cookie | HTTP 200 (acesso restabelecido)            | ✅ Passou |
| 4.6 | Auditoria pós-restauração             | Role `socialflow_runtime`   | Histórico visível         | 3 linhas retornadas (histórico preservado) | ✅ Passou |

### 4.5. Suite 5: Bloqueio por Entidades Inativas

| #   | Cenário               | Procedimento                  | Resultado Esperado | Resultado Observado | Status    |
| --- | --------------------- | ----------------------------- | ------------------ | ------------------- | --------- |
| 5.1 | Cliente inativado     | `Client.active = false`       | HTTP 404           | HTTP 404            | ✅ Passou |
| 5.2 | Cliente reativado     | `Client.active = true`        | HTTP 200           | HTTP 200            | ✅ Passou |
| 5.3 | Organização inativada | `Organization.active = false` | HTTP 404           | HTTP 404            | ✅ Passou |
| 5.4 | Organização reativada | `Organization.active = true`  | HTTP 200           | HTTP 200            | ✅ Passou |
| 5.5 | Usuário inativado     | `User.active = false`         | HTTP 401           | HTTP 401            | ✅ Passou |
| 5.6 | Usuário reativado     | `User.active = true`          | HTTP 200           | HTTP 200            | ✅ Passou |

### 4.6. Suite 6: Invariantes do Banco, RLS e Auditoria

| #   | Cenário                            | Procedimento                  | Resultado Esperado                  | Resultado Observado                         | Status    |
| --- | ---------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------- | --------- |
| 6.1 | Flags RLS na tabela `Brand`        | Consulta ao catálogo pg_class | `true, true`                        | `relrowsecurity: t, relforcerowsecurity: t` | ✅ Passou |
| 6.2 | Tentativa de DELETE físico direto  | Role `socialflow_runtime`     | Bloqueado por permissão SQL         | `ERROR: permission denied for table Brand`  | ✅ Passou |
| 6.3 | Atomicidade da auditoria de marcas | Consulta à tabela `AuditLog`  | Registros `brand.created`/`updated` | 8 novos eventos atômicos persistidos        | ✅ Passou |

### 4.7. Validação Visual e Responsividade (Playwright Headless)

Capturas reais executadas contra `https://homolog-socialflow.oriumdigital.com.br`:

- **Desktop (1280x720)**: Grid `.brand-grid` computado em 2 colunas; sem overflow horizontal (`scrollWidth <= innerWidth`). Evidência: `test-results/homolog-brands-desktop.png`.
- **Mobile (iPhone 13 / 390x844)**: Grid `.brand-grid` colapsado para 1 coluna; sem corte ou rolagem horizontal (`scrollWidth <= innerWidth`). Evidência: `test-results/homolog-brands-mobile.png`.

---

## 5. Dados Fictícios de Teste e Situação Pós-Limpeza

Todos os dados criados durante os testes foram devidamente rastreados e tiveram seus acessos inativados.

### Registros Fictícios Criados

| Tipo              | Nome / Identificador                                                                                                                                                                        | ID            | Situação Final                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| Organização       | `test-brands-org-a-*`                                                                                                                                                                       | Dinâmico UUID | **Inativada (`false`)**                                                            |
| Organização       | `test-brands-org-b-*`                                                                                                                                                                       | Dinâmico UUID | **Inativada (`false`)**                                                            |
| Cliente           | `test-brands-client-a1-*`                                                                                                                                                                   | Dinâmico UUID | **Inativado (`false`)**                                                            |
| Cliente           | `test-brands-client-a2-*`                                                                                                                                                                   | Dinâmico UUID | **Inativado (`false`)**                                                            |
| Cliente           | `test-brands-client-b1-*`                                                                                                                                                                   | Dinâmico UUID | **Inativado (`false`)**                                                            |
| Marcas de Teste   | `Marca Criada por Owner`, `Marca de Cliente A2`, `Marca Criada por Editor A1`, `Marca Exclusiva da Org B`, `Marca Homologação Visual`                                                       | 5 registros   | **Remanescentes vinculadas aos clientes inativos** (sem exclusão neste incremento) |
| Usuários de Teste | `test-brands-owner-a@...`, `test-brands-admin-a@...`, `test-brands-editor-a1@...`, `test-brands-approver-a1@...`, `test-brands-viewer-a1@...`, `test-brands-admin-b@...`, `test-visual@...` | 7 contas      | **Inativados (`false`)**                                                           |
| Vínculos de Teste | Todas as memberships de teste                                                                                                                                                               | 7 vínculos    | **Inativados (`false`)**                                                           |
| Sessões de Teste  | Todos os tokens de teste                                                                                                                                                                    | —             | **Expurgados (`0` restantes)**                                                     |

### Preservação Integral dos Dados Pré-Existentes

| Registro Real                      | ID                                     | Situação Inicial | Situação Atual                                                            |
| ---------------------------------- | -------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| **Organização Orium Digital**      | `f0e58e25-6454-443e-b21b-f35cb1b7ff23` | Ativa (`true`)   | **Ativa (`true`) — Intacta**                                              |
| **Usuário Arino Borba (OWNER)**    | `edac89f6-0d98-4bd9-8c53-6429b77022a0` | Ativo (`true`)   | **Ativo (`true`) — Intacto**                                              |
| **Cliente Teste**                  | `98792eae-cb4e-4267-af02-0f460b6fac72` | Ativo (`true`)   | **Ativo (`true`) — Intacto**                                              |
| **Vínculo OWNER**                  | `1134663f-2582-43aa-ac27-4fc8581772c1` | Ativo (`true`)   | **Ativo (`true`) — Intacto**                                              |
| **Trilha de Auditoria (AuditLog)** | Tabela completa                        | 35 registros     | **43 registros (35 pré-existentes + 8 dos testes de marcas preservados)** |

---

## 6. Pendências e Riscos Residuais

1. **Achado A-1 (Comprimento de Strings no E2E Automatizado)**:
   - As strings de teste no arquivo `tests/e2e/brands.spec.ts` têm ~146 caracteres. O comportamento com strings reais longas (1000/2000 caracteres) foi validado com sucesso durante o aceite e na homologação sem quebras de layout. Recomenda-se aumentar as strings no E2E local em ciclo futuro.
2. **Achado A-2 (Cobertura de Entidades Inativas em Marcas)**:
   - A suíte de integração local não possuía testes dedicados para `client.active = false` contra marcas. O comportamento foi formalmente validado e aprovado nesta homologação (Suite 5).
3. **Backup Externo Criptografado e Restauração de Desastre na VPS**:
   - O backup consistente foi realizado localmente na VPS em `/root/backups/socialflow/backup_pre_brands_20260914.dump` e seu catálogo foi verificado. A implementação de cópia externa automatizada, criptografia assimétrica por chave pública e teste de restauração em nova VPS permanecem como pendência operacional antes de clientes comerciais reais.

---

## 7. Instruções para Teste Manual pela Interface

Para o operador validar visualmente e de forma interativa a gestão de marcas:

1. **Acessar a Aplicação**:
   - Abra `https://homolog-socialflow.oriumdigital.com.br` no navegador (desktop ou mobile).
2. **Login**:
   - Faça login com as credenciais do usuário OWNER (`arinoborba@gmail.com`).
3. **Acessar o Cliente**:
   - Na lista de clientes, localize o **Cliente Teste** e clique em **"Abrir cliente"**.
4. **Criar Nova Marca**:
   - Clique no botão **"Nova marca"**.
   - Preencha os campos textuais:
     - **Nome da marca**: Ex.: `Minha Marca Homologada`
     - **Descrição**: Breve texto descritivo.
     - **Público-alvo**: Ex.: `Empreendedores e criadores de conteúdo`
     - **Tom de voz**: Ex.: `Inspirador, prático e moderno`
   - Clique em **"Salvar marca"**.
5. **Verificar Persistência e Layout**:
   - Observe a inclusão do cartão da nova marca na listagem do cliente.
   - Verifique que os blocos de público-alvo e tom de voz se ajustam sem quebras.
   - Recarregue a página (`F5`) para confirmar que a marca persiste.
6. **Editar Marca**:
   - Clique em **"Editar"** no cartão da marca criada.
   - Altere o tom de voz e clique em **"Salvar alterações"**.
   - Verifique a atualização imediata dos dados.
7. **Retornar aos Clientes**:
   - Use o link de navegação **"← Voltar para clientes"** no topo da página.
