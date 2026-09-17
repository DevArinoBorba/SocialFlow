# Fase 2 (Incremento 3) — Gestão de Conteúdo, Lotes CSV e Workflow de Aprovação

Data de execução: 17/09/2026  
Status: **IMPLEMENTADO E VERIFICADO**  
Ambiente avaliado: **Ambiente de Testes Local (Windows 11 / Docker Desktop / PostgreSQL 17.11-alpine real via role `socialflow_runtime` / Redis 8.10.0-alpine / MinIO S3)**

---

## 1. Escopo Entregue

Este incremento conclui o núcleo da **Fase 2 do SocialFlow** (Conteúdo e Mídia), implementando a gestão completa do ciclo de vida de postagens sociais, importação massiva em lote via CSV com relatório detalhado de inconsistências por linha, e máquina de estados de aprovação com rigorosa segregação RBAC e RLS multi-tenant:

1. **Gestão de Lotes de Conteúdo (`ContentBatch`)**:
   - Criação e rastreamento de lotes originados por importação CSV.
   - Contabilização atômica de `totalRows`, `validRows`, `invalidRows` e persistência do `errorReport` estruturado em JSONB.
   - Status de ciclo de vida do lote: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`.

2. **Importação Resiliente de CSV (Gate da Fase 2)**:
   - Parser streaming/buffer tolerante a arquivos com até 2 MiB (`MAX_CSV_SIZE_BYTES`) e limite de 500 linhas (`MAX_CSV_DATA_ROWS`).
   - Validação coluna por coluna: coluna obrigatória `caption` (texto até 5.000 caracteres); colunas opcionais `title`, `hashtags`, `callToAction`, `firstComment`, `suggestedDate` (ISO 8601).
   - **Isolamento de falhas**: Linhas inválidas reportam erro com `{ row, column, message, rawValue }` sem abortar o processamento das linhas válidas do lote.
   - Inserção atômica de todas as linhas válidas como `DRAFT` na mesma transação PostgreSQL.

3. **Ciclo de Vida e Workflow de Posts (`Post`)**:
   - Criação individual de posts avulsos (DRAFT) com associação opcional de marca pertencente ao mesmo cliente e organização.
   - Estados suportados: `DRAFT`, `IN_REVIEW`, `APPROVED`, `REJECTED`.
   - Transições de estado com máquina de estados determinística:
     - `DRAFT` → `IN_REVIEW`: Executado por `EDITOR`, `ADMIN` ou `OWNER`.
     - `IN_REVIEW` → `APPROVED`: Restrito a `APPROVER`, `ADMIN` ou `OWNER` (`EDITOR` proibido com 403).
     - `IN_REVIEW` → `REJECTED`: Restrito a `APPROVER`, `ADMIN` ou `OWNER`; justificativa textual (`rejectionReason`) é **obrigatória**.
     - `REJECTED` → `IN_REVIEW` / `DRAFT`: Permite reaproveitamento e correção pelo `EDITOR`.
   - Edição de conteúdo: `EDITOR` pode editar apenas posts em `DRAFT` ou `REJECTED`. Posts em `IN_REVIEW` ou `APPROVED` são bloqueados para edição.

4. **Interface Web de Usuário (`apps/web`)**:
   - Componente `ContentManager` ([apps/web/app/content-manager.tsx](file:///c:/Users/arino/Documents/PROJETOS/SocialFlow/apps/web/app/content-manager.tsx)).
   - Filtro dinâmico por status e por marca.
   - Painel retrátil de criação de posts avulsos com validações de tamanho.
   - Painel de envio de arquivo CSV com relatório detalhado de erros por linha.
   - Cards de posts com badges de status, exibição de justificativa de rejeição e botões de ação contextuais conforme o perfil autenticado.
   - Histórico de lotes anteriores com métricas de importação.
   - Proxy web ([apps/web/app/api/[...path]/route.ts](file:///c:/Users/arino/Documents/PROJETOS/SocialFlow/apps/web/app/api/%5B...path%5D/route.ts)) ajustado para permitir uploads de até 2 MiB na rota de importação de lotes.

5. **Auditoria Transacional**:
   - Eventos auditados gravados na mesma transação em `AuditLog`: `batch.imported`, `post.created`, `post.updated`, `post.status_transition`.

---

## 2. Modelagem do Banco e Row-Level Security (RLS)

As migrações `202609160001_content_batches_posts` e `202609160002_content_batches_posts` estruturam as tabelas:

1. **`ContentBatch`**:
   - Chave primária UUID `id`.
   - Chave composta única `@@unique([organizationId, clientId, id])`.
   - Chave estrangeira composta `(organizationId, clientId) REFERENCES Client(organizationId, id)`.
   - RLS ativo e forçado (`FORCE ROW LEVEL SECURITY`), com políticas baseadas em `can_read_client` e `can_edit_client`.

2. **`Post`**:
   - Chave primária UUID `id`.
   - Chaves compostas únicas `@@unique([organizationId, clientId, id])`.
   - Chaves estrangeiras compostas:
     - `(organizationId, clientId) REFERENCES Client(organizationId, id)`
     - `(organizationId, clientId, batchId) REFERENCES ContentBatch(organizationId, clientId, id)`
     - `(organizationId, clientId, brandId) REFERENCES Brand(organizationId, clientId, id)`
   - RLS ativo e forçado, impedindo no nível do banco qualquer vazamento cross-tenant ou cross-client.
   - Trigger `protect_post_scope` bloqueia com `42501` qualquer tentativa de alteração de `organizationId`, `clientId` ou `id`.

---

## 3. Matriz de Autorização (RBAC)

| Ação                                  | OWNER  | ADMIN  | EDITOR | APPROVER | CLIENT_VIEWER |
| :------------------------------------ | :----: | :----: | :----: | :------: | :-----------: |
| **Listar lotes e posts**              | ✅ Sim | ✅ Sim | ✅ Sim |  ✅ Sim  |    ✅ Sim     |
| **Criar lote / Importar CSV**         | ✅ Sim | ✅ Sim | ✅ Sim |  ❌ 403  |    ❌ 403     |
| **Criar post avulso (DRAFT)**         | ✅ Sim | ✅ Sim | ✅ Sim |  ❌ 403  |    ❌ 403     |
| **Editar post em DRAFT/REJECTED**     | ✅ Sim | ✅ Sim | ✅ Sim |  ❌ 403  |    ❌ 403     |
| **Editar post em IN_REVIEW/APPROVED** | ✅ Sim | ✅ Sim | ❌ 403 |  ❌ 403  |    ❌ 403     |
| **Enviar post para revisão**          | ✅ Sim | ✅ Sim | ✅ Sim |  ❌ 403  |    ❌ 403     |
| **Aprovar post em revisão**           | ✅ Sim | ✅ Sim | ❌ 403 |  ✅ Sim  |    ❌ 403     |
| **Rejeitar post em revisão**          | ✅ Sim | ✅ Sim | ❌ 403 |  ✅ Sim  |    ❌ 403     |
| **Visualização somente-leitura**      |   —    |   —    |   —    |    —     |   ✅ Total    |

---

## 4. Evidências de Validação

- **Testes Unitários**: 65 testes passando (incluindo 14 testes do parser CSV e limites de payload).
- **Testes de Integração**: 56 testes passando contra PostgreSQL, Redis e Storage reais em container (incluindo RBAC, isolamento multi-tenant, revogação de sessão e importação de 80 linhas válidas com 20 inválidas).
- **Testes E2E (Playwright)**: 22 testes passando em navegadores Desktop e Mobile (incluindo criação de post, persistência pós-reload, importação com relatório de erros, aprovação pelo approver e restrição do viewer).
