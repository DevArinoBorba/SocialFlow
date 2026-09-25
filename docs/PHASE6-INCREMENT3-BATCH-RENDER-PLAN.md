# Plano Técnico Detalhado — Incremento 3 da Fase 6: Geração de Artes em Lote

## 1. Visão Geral e Auditoria da Arquitetura Atual

### 1.1 Contexto e Estado Validado

- **Incremento 1 (Concluído)**: Renderer determinístico baseado em Satori 0.33.4 + Sharp 0.35.4 no pacote `@socialflow/render`, fila BullMQ (`artwork-render`), worker dedicado (`apps/worker/src/renderer-worker.ts`), armazenamento em MinIO/S3 isolado por tenant e endpoint de renderização individual autenticado (`apps/api/src/render.ts`).
- **Incremento 2 (Concluído)**: Catálogo, versionamento imutável (`DesignTemplateVersion`), concorrência otimista com resolução de conflito HTTP 409, análise de contraste WCAG 2.1 e editor declarativo de templates.
- **Integridade Atual**:
  - `pnpm typecheck`: 0 erros nos 7 pacotes do monorepo;
  - Testes Unitários: 20 arquivos, 227 testes passando;
  - Testes de Integração: 12 arquivos, 300 testes passando;
  - Testes E2E (Playwright): 100 cenários passando em desktop e mobile (iPhone 13);
  - Row-Level Security (RLS) habilitado e forçado no PostgreSQL 17 com papéis estritos (`socialflow_runtime`, `socialflow_migration`).

### 1.2 Mecanismos Reutilizáveis Identificados no Repositório

- **Isolamento Multitenant e RLS**:
  - Funções de escopo no PostgreSQL: `can_read_client("organizationId", "clientId")`, `can_edit_client("organizationId", "clientId")`, `current_actor()`, `renderer_in_scope("organizationId", "clientId")`.
  - Helper transacional no backend: `asRendererActor(db, { organizationId, clientId }, tx => ...)` que ativa `set_config('app.user_id', 'system:renderer', true)` garantindo atuação sem privilégios de superusuário e estritamente dentro do tenant.
- **Idempotência**:
  - Chave única no banco (`@@unique([organizationId, clientId, idempotencyKey])`).
  - Detecção de replay em `POST /render-jobs` retornando `200 OK` para requisições equivalentes ou `409 Conflict` para divergência de parâmetros.
  - Tratamento transacional de corrida no banco (`P2002` no Prisma) que consulta o registro vencedor e compara parâmetros imutáveis.
- **Worker, Fila e Leases**:
  - BullMQ com conexão Redis dedicada (`maxRetriesPerRequest: null`, `connectTimeout: 2500`).
  - Lease operacional de 5 minutos (`RENDER_LEASE_MS = 300000`) com renovação atômica via `executionToken` (fencing token UUID) e campo `leaseExpiresAt`.
  - Concorrência controlada (`concurrency: 1`) protegendo a VPS de sobrecarga de memória e CPU ao usar Satori/Sharp.
- **Reconciliação e Resiliência**:
  - Função no banco `discover_reconcilable_render_jobs()` (SECURITY DEFINER) identificando jobs `PENDING` ou `PROCESSING` com lease expirada.
  - Classe `RendererReconciler` executando ciclo periódico a cada 60s e no startup do worker, recuperando jobs órfãos sem duplicação de execuções.
- **Armazenamento e Deduplicação**:
  - Caminho determinístico de storage: `media/${organizationId}/${clientId}/${renderJobId}`.
  - Validação estrita de bytes, dimensões e SHA-256 (`MAX_IMAGE_BYTES = 10MB`, `MAX_RENDER_SOURCE_PIXELS = 25MP`).
  - Detecção de colisão no S3 (HTTP 412 / `PreconditionFailed`), comparando SHA-256 e dimensões antes de reutilizar o ativo.
- **Frontend e Polling**:
  - `ArtworkPollingController` e `PollingLifecycleManager`: ciclo de polling adaptativo com `AbortController`, suporte a `visibilityState` ("visible" a 1600ms, "hidden" a 4000ms), isolamento contra respostas fora de ordem (número de geração e authorizedJobId) e deduplicação de callbacks de conclusão.

### 1.3 Lacunas Reais para o Incremento 3

1. **Ausência de Entidade de Lote de Renderização**: Atualmente só existe `ContentBatch` (específico para importação de posts via CSV). Não há modelo para agrupar e auditar solicitações em lote de renderização de artes.
2. **Falta de Associação em Lote no `RenderJob`**: O modelo `RenderJob` não possui campo `batchId`, impedindo rastreamento consolidado e cancelamento coordenado.
3. **Ausência de Estado `CANCELLED`**: `RenderJobStatus` possui apenas `PENDING`, `PROCESSING`, `COMPLETED` e `FAILED`. Para suportar cancelamento seguro e cooperativo, o enum precisa do estado `CANCELLED`.
4. **Sem Endpoint de Seleção em Lote e Orquestração**: A API só suporta submissão de uma única arte por requisição via `POST /render-jobs`.
5. **UI sem Seleção Múltipla de Conteúdo**: O `ContentManager` permite visualizar posts, mas não selecionar múltiplos posts para geração de artes em lote.

---

## 2. Modelo de Domínio e Banco de Dados

### 2.1 Decisão Arquitetural: `RenderBatch` e Vínculo com `RenderJob`

**Decisão**: Criar a entidade `RenderBatch` e associar os itens diretamente ao `RenderJob` existente através da adição da coluna opcional `batchId` em `RenderJob`.

**Justificativa**:

- `RenderJob` já contém todo o ciclo de vida de execução: `templateVersionId`, `postId`, `backgroundMediaAssetId`, `logoMediaAssetId`, `outputMediaAssetId`, `input`, `inputHash`, `idempotencyKey`, `attemptNumber`, `leaseExpiresAt`, `executionToken`, `errorCode`, `errorMessage`.
- Criar uma tabela intermediária `RenderBatchItem` criaria redundância massiva ou forçaria um relacionamento 1:1 artificial com `RenderJob`, dobrando locks, migrações e complexidade de RLS.
- Associar `RenderJob.batchId` permite que o worker de renderização existente (`executeRenderJob()`) continue executando exatamente a mesma lógica testada e homologada, apenas atualizando os contadores e status do lote na conclusão ou falha de cada job.

### 2.2 Especificação do Modelo `RenderBatch`

```prisma
enum RenderBatchStatus {
  PENDING
  PROCESSING
  CANCELLING
  COMPLETED
  PARTIALLY_FAILED
  FAILED
  CANCELLED
}

enum RenderBatchSourceType {
  POSTS_SELECTION
  CONTENT_BATCH
}

model RenderBatch {
  id                 String                @id @default(uuid())
  organizationId     String
  organization       Organization          @relation(fields: [organizationId], references: [id])
  clientId           String
  client             Client                @relation(fields: [organizationId, clientId], references: [organizationId, id])
  templateVersionId  String
  templateVersion    DesignTemplateVersion @relation(fields: [organizationId, clientId, templateVersionId], references: [organizationId, clientId, id], onDelete: Restrict)
  sourceType         RenderBatchSourceType @default(POSTS_SELECTION)
  contentBatchId     String?
  contentBatch       ContentBatch?         @relation(fields: [organizationId, clientId, contentBatchId], references: [organizationId, clientId, id], onDelete: Restrict)
  format             DesignFormat
  status             RenderBatchStatus     @default(PENDING)
  idempotencyKey     String
  createdById        String
  createdBy          User                  @relation(fields: [createdById], references: [id])
  totalItems         Int
  pendingItems       Int
  processingItems    Int                   @default(0)
  completedItems     Int                   @default(0)
  failedItems        Int                   @default(0)
  cancelledItems     Int                   @default(0)
  cancelRequestedAt  DateTime?
  cancelCompletedAt  DateTime?
  completedAt        DateTime?
  createdAt          DateTime              @default(now())
  updatedAt          DateTime              @updatedAt
  jobs               RenderJob[]

  @@unique([organizationId, id])
  @@unique([organizationId, clientId, id])
  @@unique([organizationId, clientId, idempotencyKey])
  @@index([organizationId, clientId, status, createdAt])
}
```

### 2.3 Atualizações no Modelo `RenderJob`

```prisma
// Expansão do enum existente:
enum RenderJobStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
  CANCELLED
}

// Novos campos no model RenderJob:
model RenderJob {
  // ... campos existentes ...
  batchId String?
  batch   RenderBatch? @relation(fields: [organizationId, clientId, batchId], references: [organizationId, clientId, id], onDelete: Restrict)

  @@index([organizationId, clientId, batchId, status])
}
```

### 2.4 Máquinas de Estado Formais

#### A. Máquina de Estados de `RenderJob` (Item)

```
          ┌──────────────────────────────────────────────┐
          │                                              │ (Cancelamento antes de executar)
          ▼                                              │
      [ PENDING ] ───(Início da Execução)───► [ PROCESSING ]
          │                                       │     │
          │ (Cancelamento cooperativo)             │     │ (Falha transitória / permanente)
          ▼                                       │     ▼
    [ CANCELLED ] ◄───────────────────────────────┘  [ FAILED ]
          ▲                                             │
          │                                             │ (Re-tentativa controlada)
          │                                             ▼
          │                                        [ PENDING ]
          │
          └─── (Sucesso) ───► [ COMPLETED ] (Terminal)
```

- **Transições Permitidas**:
  - `PENDING -> PROCESSING`: Aquisição atômica da lease pelo worker.
  - `PROCESSING -> COMPLETED`: Renderização e persistência no storage concluídas com sucesso.
  - `PROCESSING -> FAILED`: Falha permanente ou esgotamento de tentativas.
  - `PENDING -> CANCELLED`: Solicitação de cancelamento enquanto o item ainda aguardava na fila.
  - `PROCESSING -> CANCELLED`: Solicitação de cancelamento durante execução, se o processo for interrompido antes de persistir o arquivo.
  - `FAILED -> PENDING`: Acionado exclusivamente via endpoint de repetição controlada de falhas (`retry-failed`).
- **Estados Terminais**: `COMPLETED`, `CANCELLED`, `FAILED` (até que uma ação explícita de retry seja acionada).

#### B. Máquina de Estados de `RenderBatch` (Lote)

```
      [ PENDING ]
          │
          │ (Primeiro item entra em PROCESSING)
          ▼
    [ PROCESSING ]
       │     │     │
       │     │     └───────────────────────────────────────────────┐
       │     │                                                     │
       │     │ (Cancelamento solicitado pelo usuário)              │
       │     ▼                                                     │
       │  [ cancelRequestedAt definido ]                           │
       │     │                                                     │
       │     │ (Todos os itens atingiram estado terminal)          │
       │     ▼                                                     │
       │  [ CANCELLED ] (cancelCompletedAt definido)               │
       │                                                           │
       │ (Todos itens terminaram sem cancelamento)                 │
       ▼                                                           ▼
  [ completedItems == totalItems ]                     [ failedItems > 0 ]
       │                                                           │
       ▼                                                           ▼
  [ COMPLETED ]                                      [ PARTIALLY_FAILED / FAILED ]
```

- **Consistência dos Contadores (`computeBatchAggregateStatus`)**:
  - Antes de qualquer inferência terminal, valida-se a invariante de soma: `pending + processing + completed + failed + cancelled === totalItems`.
  - Se a soma dos contadores for inconsistente (ex.: atualização parcial durante concorrência ou falha de rede), a função retorna preventivamente `cancelRequestedAt ? "CANCELLING" : "PROCESSING"`, impedindo falsos encerramentos antes que o banco atinja consistência.
- **Transição Não-Terminal com Cancelamento Solicitado**:
  - Enquanto houver itens em processamento (`pendingItems > 0 || processingItems > 0`), se `cancelRequestedAt` estiver definido, o status agregado é estritamente `CANCELLING`.
  - O polling do cliente continua ativo durante `CANCELLING`, e o botão de cancelamento fica desabilitado para evitar re-submissões.
- **Precedência Estrita dos Estados Terminais (quando `completed + failed + cancelled === totalItems`)**:
  1. Todos concluídos com sucesso (`completedItems === totalItems`): **`COMPLETED`**
  2. Todos falharam (`failedItems === totalItems`): **`FAILED`**
  3. Todos cancelados (`cancelledItems === totalItems`): **`CANCELLED`**
  4. Qualquer item com falha permanente (`failedItems > 0`): **`PARTIALLY_FAILED`** (prevalece sobre cancelamento parcial)
  5. Concluídos + Cancelados sem falhas (`cancelledItems > 0 && failedItems === 0`): **`CANCELLED`**

---

## 3. Imutabilidade e Reprodutibilidade

Para garantir que uma edição posterior em um post ou template não altere silenciosamente uma arte em lote:

1. **Snapshot no Momento da Criação**:
   - Para cada item selecionado, a API extrai o conteúdo do post (`title`, `caption`, `callToAction`, etc.) e gera um objeto `ArtworkInput` completo.
   - O objeto `input` é validado contra `artworkInputSchema` e armazenado como JSONB imutável no campo `RenderJob.input`.
2. **Versão Fixada do Template**:
   - O lote referencia estritamente `templateVersionId` (imutável). Qualquer alteração no editor de templates gera uma nova versão com incremento de número, preservando a versão usada pelo lote.
3. **Cálculo de Hash Determinístico**:
   - `inputHash = hashRenderInput(spec, input)`.
   - O hash considera a versão do renderer fixada (`RENDERER_VERSION = satori-0.33.4_sharp-0.35.4_v1`), a especificação do template ordenada e os textos normalizados.
4. **Proteção no PostgreSQL (Triggers de Imutabilidade)**:
   - O trigger existente `protect_render_job_scope()` já impede alteração de `templateVersionId`, `postId`, `input`, `inputHash` e `idempotencyKey`.
   - Um novo trigger `protect_render_batch_scope()` impedirá a alteração de `organizationId`, `clientId`, `templateVersionId`, `sourceType`, `totalItems` e `idempotencyKey`.

---

## 4. Seleção de Conteúdo e Regras de Negócio

### 4.1 Modos de Seleção Suportados

1. **Seleção Manual de Posts**:
   - O usuário seleciona 1 a 100 posts através da lista paginada do `ContentManager`.
   - Envia um array `postIds: string[]`.
2. **Seleção por Filtro de Posts**:
   - Para evitar tráfego de centenas de IDs no navegador, a API aceita um critério de seleção baseado em filtro:
     - `filter: { status?: "APPROVED" | "IN_REVIEW" | "DRAFT", batchId?: string, dateFrom?: string, dateTo?: string }`.
     - A API resolve a lista de posts diretamente no banco dentro da transação, com limite estrito de até 100 posts.
3. **Seleção por Lote de Importação CSV (`contentBatchId`)**:
   - O usuário escolhe gerar artes para todos os posts válidos oriundos de um lote CSV importado na Fase 2.

> [!IMPORTANT]
> **Gate Local de Capacidade (Trava de Produto de até 100 Artes)**:
> O limite máximo de 100 artes por lote é uma trava mandatória de capacidade e estabilidade operacional local da VPS. Impede sobrecarga de memória (OOM por rasterização concorrente no Sharp/Satori), saturação e estouro de fila no Redis/BullMQ, e contenção de conexões ou transações no PostgreSQL sob o perfil `socialflow_runtime`.

### 4.2 Validação Prévia (Dry-Run / Preflight)

- Endpoint `POST /render-batches/validate`:
  - Recebe os critérios de seleção e o template pretendido.
  - Verifica:
    - Se os posts pertencem ao tenant e cliente ativo;
    - Se os textos cabem dentro do orçamento de layout (`calculateLayoutBudget`);
    - Se contêm caracteres ou padrões proibidos (`disallowedContentPattern`);
    - Se mídias vinculadas (logotipo ou fundo) estão prontas e não arquivadas.
  - Retorna relatório estruturado:
    ```json
    {
      "valid": true,
      "totalSelected": 42,
      "acceptedCount": 40,
      "rejectedCount": 2,
      "rejectedItems": [
        {
          "postId": "uuid-1",
          "title": "Post com texto excessivo",
          "reason": "LAYOUT_OVERFLOW",
          "details": "Texto ultrapassa a área útil em 120px."
        },
        {
          "postId": "uuid-2",
          "title": "Post com link",
          "reason": "DISALLOWED_CONTENT",
          "details": "Texto contém URLs não permitidas."
        }
      ]
    }
    ```

---

## 5. Especificação de API e Contratos

### 5.1 Rotas REST (Sob `/api/organizations/:org/clients/:clientId/render-batches`)

| Método | Caminho                  | Descrição                              | Perfis Autorizados      |
| :----- | :----------------------- | :------------------------------------- | :---------------------- |
| `POST` | `/validate`              | Pré-validação do lote (dry-run)        | OWNER, ADMIN, EDITOR    |
| `POST` | `/`                      | Criação e enfileiramento do lote       | OWNER, ADMIN, EDITOR    |
| `GET`  | `/`                      | Listagem paginada de lotes             | Todos (conforme tenant) |
| `GET`  | `/:batchId`              | Detalhes consolidados do lote          | Todos (conforme tenant) |
| `GET`  | `/:batchId/items`        | Listagem paginada dos itens com filtro | Todos (conforme tenant) |
| `POST` | `/:batchId/cancel`       | Cancelamento cooperativo do lote       | OWNER, ADMIN, EDITOR    |
| `POST` | `/:batchId/retry-failed` | Re-tentativa somente dos itens falhos  | OWNER, ADMIN, EDITOR    |

### 5.2 Schemas Zod (`@socialflow/contracts`)

```typescript
export const renderBatchCreateSchema = z.strictObject({
  templateVersionId: z.string().uuid(),
  format: z.enum(["SQUARE", "PORTRAIT", "STORY"]),
  source: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("POSTS_SELECTION"),
      postIds: z.array(z.string().uuid()).min(1).max(100),
    }),
    z.strictObject({
      type: z.literal("FILTER"),
      status: z.enum(["DRAFT", "IN_REVIEW", "APPROVED"]).optional(),
      batchId: z.string().uuid().optional(),
    }),
    z.strictObject({
      type: z.literal("CONTENT_BATCH"),
      contentBatchId: z.string().uuid(),
    }),
  ]),
  defaults: z
    .strictObject({
      backgroundMediaAssetId: z
        .string()
        .uuid()
        .nullable()
        .optional()
        .default(null),
      logoMediaAssetId: z.string().uuid().nullable().optional().default(null),
    })
    .optional(),
  idempotencyKey: z.string().trim().min(16).max(128),
});

export const renderBatchListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().uuid().optional(),
  status: z
    .enum([
      "PENDING",
      "PROCESSING",
      "CANCELLING",
      "COMPLETED",
      "PARTIALLY_FAILED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
});

export const renderBatchItemsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().uuid().optional(),
  status: z
    .enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"])
    .optional(),
});
```

### 5.3 Respostas e Códigos HTTP

- **201 Created**: Lote criado e enfileirado com sucesso.
- **200 OK**: Retorno em replay idêntico de idempotência ou em consultas GET.
- **400 Bad Request**: Payload inválido, template inativo ou parâmetros corrompidos.
- **403 Forbidden**: Papel não autorizado (ex.: `CLIENT_VIEWER` tentando criar ou cancelar).
- **404 Not Found**: Cliente, template ou lote não encontrado.
- **409 Conflict**: Idempotency key reutilizada com payload divergente.
- **422 Unprocessable Entity**: Nenhum post elegível ou todos rejeitados na validação.
- **429 Too Many Requests**: Limite de taxa de criação atingido.
- **503 Service Unavailable**: Falha transitória de infraestrutura (mensagem amigável sanitizada).

---

## 6. Idempotência e Concorrência

### 6.1 Idempotência em Duas Camadas

1. **Camada do Lote (`RenderBatch`)**:
   - `idempotencyKey` fornecida pelo cliente e restrita por `@@unique([organizationId, clientId, idempotencyKey])`.
   - Se o usuário der duplo clique, a segunda chamada encontra o registro existente. Se o payload for idêntico, retorna `200 OK` com o estado do lote. Se divergir, retorna `409 Conflict`.
2. **Camada do Item (`RenderJob`)**:
   - Cada item gerado dentro do lote recebe uma chave de idempotência determinística e única:
     `itemKey = `${batchId}:${index}:${post.id}:${inputHash}``.
   - Isso garante que, mesmo em cenários de re-execução do lote ou retries, nenhum `RenderJob` duplicado seja inserido para o mesmo post.

### 6.2 Resiliência entre Banco e Redis

- **O PostgreSQL é a Fonte de Verdade Única**:
  - Toda a criação de `RenderBatch` e inserção dos `RenderJob` correspondentes ocorre em uma única transação atômica no PostgreSQL com status `PENDING`.
  - O enfileiramento no BullMQ ocorre após a transação ser confirmada.
  - Se a chamada `queue.add()` falhar (ex.: queda momentânea do Redis):
    - A API não apaga os registros do banco;
    - Retorna `202 Accepted` ao cliente;
    - O reconciliador (`RendererReconciler`) detecta os jobs em `PENDING` sem `queueJobId` e os enfileira automaticamente no próximo ciclo.

---

## 7. Worker, Concorrência e Gestão de Recursos da VPS

### 7.1 Limites de Recursos e Backpressure

- **Concorrência do Worker**: Fixada estritamente em **1** (ou até 2 em servidores com mais de 4 vCPUs).
- **Consumo de Memória por Renderização**:
  - Satori compila JSX/SVG em memória (~30-60 MB).
  - Sharp rasteriza PNG de alta resolução (1080x1920 px em 9:16) (~40-80 MB).
  - Com concorrência 1, o consumo máximo do worker permanece abaixo de 250 MB de RAM.
  - Se colocássemos 100 artes em concorrência livre, o consumo ultrapassaria 4 GB, provocando OOM (Out Of Memory) e reinício do container na VPS.
- **Liberação em Chunks no BullMQ**:
  - O lote de 100 itens é enfileirado no BullMQ com jobs individuais leves contendo apenas referências `{ renderJobId, organizationId, clientId }`.
  - O BullMQ processa um por vez de forma ordenada, evitando picos de CPU e permitindo progresso granular.

### 7.2 Atualização Atômica de Contadores

Para evitar perda de incrementos sob concorrência:

- O worker, ao concluir ou falhar um item com seu `executionToken`, executa uma atualização atômica no `RenderBatch`:

```sql
UPDATE "RenderBatch"
SET "completedItems" = "completedItems" + 1,
    "processingItems" = GREATEST("processingItems" - 1, 0),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE id = :batchId;
```

- O reconciliador periódico também recalcula os totais reais via `COUNT(*)` agrupado por `status` em caso de divergência após quedas abruptas.

---

## 8. Cancelamento Cooperativo e Idempotente

### 8.1 Semântica de Cancelamento

Quando um usuário autorizado solicita o cancelamento de um lote (`POST /render-batches/:batchId/cancel`):

1. **Marcação no Lote**:
   - `cancelRequestedAt` é definido imediatamente como `NOW()`.
2. **Itens `PENDING`**:
   - São atualizados atomicamente para `CANCELLED` no banco:
     ```sql
     UPDATE "RenderJob"
     SET status = 'CANCELLED', "updatedAt" = NOW()
     WHERE "batchId" = :batchId AND status = 'PENDING';
     ```
   - O worker, ao retirar um job da fila BullMQ, consulta o banco; ao verificar que o status já é `CANCELLED`, pula a execução imediatamente.
3. **Itens `PROCESSING` (Em Andamento)**:
   - O cancelamento é cooperativo: se o item já estiver gravando os bytes no S3 ou finalizando, ele conclui como `COMPLETED` para não corromper o arquivo.
   - Nenhuma arte já concluída com sucesso é excluída.
4. **Finalização do Lote**:
   - Quando não restar nenhum item em `PENDING` ou `PROCESSING`, o `RenderBatch` é marcado com `status = 'CANCELLED'` e `cancelCompletedAt = NOW()`.
   - Auditoria `render_batch.cancelled` é registrada.

---

## 9. Segurança Multitenant, RLS e RBAC

### 9.1 Políticas de Row-Level Security (PostgreSQL)

- **`RenderBatch`**:
  - `render_batch_read`: `can_read_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId")`.
  - `render_batch_create`: `can_edit_client("organizationId", "clientId") AND status = 'PENDING' AND createdById = current_actor()`.
  - `render_batch_update`: `can_edit_client("organizationId", "clientId")` (apenas para cancelamento) ou `renderer_in_scope("organizationId", "clientId")` (para contadores e status de progresso).
- **Garantia de Não Vazamento**:
  - Chaves estrangeiras compostas: `FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id")`.
  - Impossível para a Organização A selecionar posts ou templates da Organização B.
- **Funções `SECURITY DEFINER` e Princípio do Menor Privilégio**:
  - As rotinas de varredura global `discover_reconcilable_render_jobs()` e `discover_active_render_batches()` são marcadas como `SECURITY DEFINER` para permitir que o worker descubra tarefas órfãs através de tenants.
  - Para evitar qualquer enumeração não autorizada de lotes, clientes ou organizações por sessões runtime sem contexto ou usuários comuns (mesmo `OWNER` ou `ADMIN`), ambas as funções impõem verificação estrita:
    ```sql
    IF current_setting('app.user_id', true) IS DISTINCT FROM 'system:renderer' THEN
      RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
    END IF;
    ```
  - Sessões `socialflow_runtime` sem ator ou com atores de usuários comuns recebem imediatamente erro `42501`. Apenas o worker do sistema executando via `asSystemRendererDiscovery` (ou `asRendererActor`) possui permissão para executar a descoberta.

### 9.2 Matriz de Autorização RBAC

| Perfil            | Criar Lote |    Listar / Ver Detalhes     | Cancelar Lote | Repetir Falhas |    Acessar Mídias     |
| :---------------- | :--------: | :--------------------------: | :-----------: | :------------: | :-------------------: |
| **OWNER**         |    Sim     |             Sim              |      Sim      |      Sim       |          Sim          |
| **ADMIN**         |    Sim     |             Sim              |      Sim      |      Sim       |          Sim          |
| **EDITOR**        |    Sim     |             Sim              |      Sim      |      Sim       |          Sim          |
| **APPROVER**      | Não (403)  |             Sim              |   Não (403)   |   Não (403)    |          Sim          |
| **CLIENT_VIEWER** | Não (403)  | Sim (somente do seu cliente) |   Não (403)   |   Não (403)    | Sim (somente leitura) |

---

## 10. Armazenamento e Política de Assets de Saída (Opção C)

1. **Decisão Arquitetural — Opção C (Sem Deduplicação Inter-Jobs)**:
   - Cada `RenderJob` de um lote produz seu próprio `MediaAsset` exclusivo no banco e objeto correspondente no MinIO/S3, vinculado diretamente ao post de destino (`postId`).
   - Não há compartilhamento nem reutilização de `outputMediaAssetId` entre diferentes jobs, mesmo se dois posts gerarem artes visualmente idênticas (mesmo hash).
2. **Justificativa Operacional e de Governança**:
   - **Desacoplamento e Ciclo de Vida Independente**: A exclusão, arquivamento ou edição de um post não impacta nem remove a mídia de outro post, eliminando risco de referências órfãs (_dangling pointers_) ou exclusões acidentais em cascata.
   - **Rastreabilidade e Auditoria 1:1**: Cada linha do histórico de publicações aponta para seu ativo exclusivo de mídia, permitindo auditoria clara de data, autor e job de geração.
   - **Simplicidade de RLS e Concorrência**: Elimina locks de concorrência e condições de corrida entre jobs simultâneos tentando referenciar o mesmo ativo de saída.
3. **Localização e Integridade dos Arquivos**:
   - Caminho determinístico no S3: `media/${organizationId}/${clientId}/${renderJobId}`.
   - O SHA-256 e as dimensões em pixels são calculados pelo worker e persistidos no `MediaAsset` para validação de integridade.
   - Isolamento multitenant estrito: O path garante segregação física por organização e cliente.

---

## 11. Arquitetura da Interface Web

### 11.1 Componentes e Fluxo de Uso

1. **Seleção de Posts no `ContentManager`**:
   - Adicionar checkboxes de seleção na listagem de posts.
   - Barra de ações em lote flutuante: `"X posts selecionados" -> [ Gerar Artes em Lote ]`.
2. **Modal / Painel de Configuração do Lote**:
   - Seleção do modelo ativo (`DesignTemplate`) e formato desejado (`SQUARE`, `PORTRAIT`, `STORY`).
   - Opção de logotipo padrão e imagem de fundo padrão da biblioteca.
   - Prévia rápida e resumo de validação antes de confirmar.
3. **Painel de Acompanhamento do Lote**:
   - Barra de progresso percentual consolidada: `(completed + failed + cancelled) / total * 100`.
   - Cartões numéricos de status: Total, Concluídos, Processando, Falhos e Cancelados.
   - Botão `"Cancelar lote restante"` com confirmação explícita.
   - Lista paginada dos itens com prévia em miniatura dos itens concluídos.
4. **Gerenciador de Polling Unificado**:
   - Reutilização da arquitetura do `ArtworkPollingController`: uma única chamada periódica a cada 2000ms consultando o status agregado do lote.
   - Reduz para 5000ms quando a aba estiver em segundo plano (`document.visibilityState === "hidden"`).
   - Encerramento automático do timer assim que o lote atinge estado terminal.

---

## 12. Observabilidade e Auditoria

### 12.1 Eventos Estruturados (stdout em formato JSON)

- `render_batch.created`: `{ batchId, organizationId, clientId, totalItems, format, templateVersionId }`
- `render_batch.started`: `{ batchId, organizationId, clientId }`
- `render_batch.cancel_requested`: `{ batchId, organizationId, clientId, actorUserId }`
- `render_batch.cancelled`: `{ batchId, organizationId, clientId, cancelledItems, completedItems }`
- `render_batch.completed`: `{ batchId, organizationId, clientId, durationMs, completedItems, failedItems }`
- `render_batch.reconciled`: `{ batchId, fixedCounters: boolean, recoveredJobsCount }`

### 12.2 Registro em `AuditLog`

- `render_batch.requested` (ator: usuário criador)
- `render_batch.cancel_requested` (ator: usuário cancelador)
- `render_batch.completed` (ator: `system:renderer`)
- `render_batch.cancelled` (ator: `system:renderer`)

---

## 13. Estratégia de Migrations

### 13.1 Migration Reversível

1. Adicionar enum `RenderBatchStatus` e `RenderBatchSourceType`.
2. Expandir enum `RenderJobStatus` com valor `CANCELLED`.
3. Criar tabela `RenderBatch` com RLS habilitado e forçado.
4. Adicionar coluna `batchId` e foreign key em `RenderJob`.
5. Criar trigger `protect_render_batch_scope()`.
6. Conceder permissões para `socialflow_runtime`.
7. Atualizar a função `discover_reconcilable_render_jobs()` e criar `discover_active_render_batches()`, ambas com `SECURITY DEFINER` e validação estrita de `app.user_id = 'system:renderer'` para evitar enumeração de tenants.

---

## 14. Estratégia de Testes e Validação do Gate

### 14.1 Matriz de Testes Automatizados

- **Testes Unitários**:
  - Validação de schemas Zod (`renderBatchCreateSchema`, etc.);
  - Cálculo de contadores agregados e transições de estado;
  - Resolução de conflito e idempotência determinística.
- **Testes de Integração**:
  - Criação transacional de lote com 5, 20 e 50 posts;
  - Replay idêntico retornando 200 e divergente retornando 409;
  - Falha simulada do Redis após gravação no banco, comprovando recuperação pelo reconciliador;
  - Cancelamento no meio da execução, verificando itens PENDING cancelados e PROCESSING finalizados;
  - Testes de isolamento RLS: Organização B tentando acessar `batchId` da Organização A (deve retornar 404).
- **Testes E2E (Playwright)**:
  - Fluxo completo na UI: selecionar posts no ContentManager -> abrir modal -> disparar lote -> acompanhar barra de progresso -> verificar artes na Biblioteca de Mídias.
  - Teste de cancelamento cooperativo via UI em desktop e mobile.

### 14.2 Critérios Objetivos do Gate de 100 Artes

O gate de homologação da Fase 6 será considerado aprovado quando:

1. Um lote com exatamente **100 artes** for submetido e processado do início ao fim.
2. O worker de renderização mantiver concorrência restrita sem picos de memória acima de 500 MB na VPS.
3. Não houver nenhum `RenderJob` duplicado no banco ou storage.
4. O reinício forçado do worker durante o processamento do lote (ex.: no item 45) for recuperado automaticamente pelo reconciliador sem abortar o lote e sem reprocessar os 44 itens já concluídos.
5. 100% dos arquivos finais ficarem disponíveis na biblioteca com miniaturas e integridade SHA-256 verificada.

---

## 15. Plano de Rollout em Etapas (Sem Impacto no Ambiente Atual)

- **Etapa A — Fundação do Banco, Contratos e RLS**:
  - Adição de schemas Zod em `@socialflow/contracts`.
  - Migration Prisma com `RenderBatch`, expansão de `RenderJob` e políticas RLS.
  - Testes unitários e de integração de isolamento de banco.
- **Etapa B — API de Validação e Criação Idempotente**:
  - Endpoints `POST /validate` e `POST /render-batches`.
  - Testes de idempotência, limites de taxa e RBAC.
- **Etapa C — Worker, Execução Sequencial e Reconciliação**:
  - Atualização do `renderer-worker.ts` para reportar progresso atômico no lote pai.
  - Extensão do `RendererReconciler` para monitorar lotes incompletos.
- **Etapa D — Consulta, Listagem e Cancelamento Cooperativo**:
  - Endpoints de consulta de status, listagem de itens e cancelamento cooperativo.
  - Testes de cancelamento em diferentes estágios do lote.
- **Etapa E — Interface Web e Experiência do Usuário**:
  - Checkboxes e barra de seleção múltipla em `ContentManager`.
  - Modal de configuração e tela de progresso em tempo real com polling adaptativo.
  - Suporte completo a telas móveis e acessibilidade WCAG.
- **Etapa F — Homologação de Carga e Gate de 100 Artes**:
  - Execução controlada de baterias de 10, 25, 50 e 100 artes.
  - Validação de métricas de CPU, memória e ausência de vazamento de tenant.

---

## 16. Resultados Reais da Execução do Gate e Validação

Em 23/09/2026, a validação reportada para `tests/integration/render-batch-100-gate.test.ts` cobriu os cenários de carga e resiliência abaixo. Estes resultados são do gate automatizado local; o aceite operacional na infraestrutura de homologação permanece no Incremento 4.

### 16.1 Métricas Consolidadas do Gate Oficial de 100 Artes

| Métrica                                 | Meta / Limite do Gate            | Resultado Obtido                                         | Status   |
| :-------------------------------------- | :------------------------------- | :------------------------------------------------------- | :------- |
| **Quantidade de Artes no Lote**         | Exatamente 100 artes             | 100 artes submetidas e persistidas                       | APROVADO |
| **Tempo Total de Execução (100 artes)** | < 120 segundos                   | Aproximadamente **93 segundos** (0,93 s/arte em média)   | APROVADO |
| **Tempo Médio por Arte**                | < 1.2 segundos/arte              | **0,93 segundos/arte**                                   | APROVADO |
| **Variação de Memória (Heap)**          | Sem vazamento / < 500 MB         | Sem vazamento reportado                                  | APROVADO |
| **Concorrência do Worker**              | Estritamente 1x (proteção VPS)   | 1 job processado por vez na fila                         | APROVADO |
| **Duplicação de RenderJobs**            | Zero                             | 100 jobs únicos vinculados ao lote                       | APROVADO |
| **Duplicação de MediaAssets**           | Zero                             | 100 arquivos com SHA-256 e storageKey determinística     | APROVADO |
| **Retomada pós-interrupção (25 artes)** | Sem reprocessar itens concluídos | 10 concluídos intactos, 15 retomados com sucesso         | APROVADO |
| **Cancelamento Cooperativo (50 artes)** | Preservar artes já concluídas    | 20 prontas preservadas, 30 canceladas com sucesso        | APROVADO |
| **Isolamento Multitenant (RLS)**        | Tenant B rejeitado (404/403)     | 100% isolado por `can_edit_client` e `renderer_in_scope` | APROVADO |

### 16.2 Estado Geral da Suíte de Testes e Qualidade

- **TypeScript (`pnpm typecheck`)**: 100% aprovado nos 8 projetos do monorepo;
- **ESLint (`pnpm lint`)**: 100% limpo, zero erros e zero warnings;
- **Prettier (`pnpm format:check`)**: 100% em conformidade de estilo;
- **Testes Unitários (`pnpm test`)**: **259 testes passando** (22 suítes verdes);
- **Testes de Integração da API de lotes (`render-batch-api.test.ts`)**: **18 testes passando**;
- **Gate de carga (`render-batch-100-gate.test.ts`)**: **4 testes passando**, incluindo interrupção, cancelamento e lote de 100 artes;
- **Testes E2E Playwright (`batch-artwork-generator.spec.ts`)**: **6 testes passando**, 3 em Desktop Chrome e 3 em Mobile iPhone 13.

Os resultados acima foram informados na validação de 23/09/2026. Typecheck, lint e
format:check também foram reportados sem erros ou warnings. Este registro não
substitui métricas de CPU/RAM da infraestrutura alvo nem o aceite de homologação.
