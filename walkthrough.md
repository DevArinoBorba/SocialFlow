# Walkthrough: Fase 6 — Worker de Renderização de Arte e Pipeline de Armazenamento

Este documento descreve a implementação completa da Fase 6 do SocialFlow: o worker de renderização em processo isolado (`render-main.ts`), integração com armazenamento S3/R2 determinístico, reconciliação de inicialização e endurecimento por fencing tokens e RLS.

---

## 1. Arquitetura e Isolamento Operacional

- **Entrypoint Isolado**: Implementado `apps/worker/src/render-main.ts` dedicado exclusivamente ao processamento da fila `artwork-render`.
- **Não Concorrência com o Scheduler**: O processo do renderer não inicia o scheduler, não consome `publication-schedule` nem a fila de diagnósticos, operando com concorrência inicial controlada igual a `1`.
- **Healthcheck Independente**: Servidor HTTP embutido expondo `/health/ready` e `/health/live` na porta `3003` (isolada da porta `3002` do scheduler e da porta `3001` da API), verificando PostgreSQL, Redis, Worker BullMQ e validação de storage S3.
- **Graceful Shutdown**: Tratamento de sinais `SIGINT` e `SIGTERM` fechando o servidor HTTP, interrompendo o worker sem descartar jobs ativos, destruindo o cliente S3 e desconectando conexões Redis e Prisma com timeout de segurança.
- **Docker Compose e Imutabilidade**:
  - `compose.yaml` atualizado com o serviço `render-worker`, reutilizando a mesma imagem imutável do GHCR (`${SOCIALFLOW_IMAGE}`) com comando de inicialização `pnpm --filter @socialflow/worker start:render`.
  - `compose.test.yaml` atualizado mapeando a porta `53003:3003` e apontando para o MinIO de teste local.

---

## 2. Pipeline de Processamento do RenderJob

Para cada job entregue via BullMQ (`RenderJobData`):

1. **Validação de Payload**: Validação estrita dos campos `renderJobId`, `organizationId` e `clientId` com Zod.
2. **Escopo RLS e Ator Técnico**: Todo o pipeline executa sob `asRendererActor(db, { organizationId, clientId }, tx)` definindo `app.user_id = 'system:renderer'` e verificando a ativação do tenant.
3. **Aquisição Atômica com Fencing Token**:
   - Aceita jobs em `PENDING` ou `PROCESSING` com lease expirada (`leaseExpiresAt <= now`).
   - Gera novo `executionToken` (UUIDv4) e incrementa `attemptNumber`.
   - Define lease de 5 minutos (`RENDER_LEASE_MS`).
   - Registra no `AuditLog`: `render.started` (para novos jobs) ou `render.recovered` (para jobs retomados de lease expirada).
4. **Validação de Integridade**:
   - Validação da versão do template, especificação Zod (`designTemplateSpecSchema`), input Zod (`artworkInputSchema`) e versão imutável do renderer (`RENDERER_VERSION`).
   - Verificação determinística do hash de entrada (`hashRenderInput(spec, input) === renderJob.inputHash`).
5. **Mídias de Origem com Hash Check**:
   - Background e logotipo opcionais carregados do banco sob RLS (`status = ready`, não arquivados, tamanho válido).
   - Download dos bytes pelo cliente de storage existente.
   - Conferência de SHA-256 dos bytes baixados contra o registro no banco antes de renderizar.
6. **Renderização Determinística**:
   - Execução de `renderArtwork()` (`@socialflow/render`) via Satori + Sharp, gerando PNG com níveis otimizados de compressão.
7. **Reserva Determinística do MediaAsset**:
   - `MediaAsset.id = renderJobId`.
   - Chave de armazenamento: `media/<organizationId>/<clientId>/<renderJobId>`.
   - `status: pending`.
   - Operação idempotente (`upsert`) impedindo criação de segundo ativo em retries.
8. **Gravação no Storage e Recuperação de Colisão**:
   - Upload com cabeçalho `IfNoneMatch: "*"`.
   - Se o objeto já existir no storage (HTTP 412 / `PreconditionFailed`):
     - Download do objeto existente e validação com `validateImage`.
     - Se dimensões, MIME e SHA-256 coincidirem exatamente com o resultado da renderização, reaproveita o upload e prossegue para finalização no banco.
     - Se divergir, não sobrescreve, marca o job como `FAILED` com código seguro `OUTPUT_OBJECT_CONFLICT`, registra `render.failed` e interrompe sem retry automático.
9. **Finalização Atômica com Fencing**:
   - Conferência estrita do `executionToken` no `UPDATE`.
   - `MediaAsset.status = 'ready'`, preenchendo dimensões, MIME, tamanho e SHA-256.
   - `RenderJob.status = 'COMPLETED'`, `outputMediaAssetId = renderJobId`, `completedAt = now()`, lease e executionToken limpos.
   - Auditoria `render.completed` registrada.

---

## 3. Classificação de Falhas e Resiliência

- **Falhas Permanentes**: Template/mídia não encontrados ou inválidos, template inativo, versão incompatível do renderer, hash de input ou mídia divergente, ou colisão de objeto divergente no storage.
  - Transicionam `RenderJob.status = FAILED`.
  - Limpam lease e token com fencing.
  - Sanitizam mensagem com `sanitizeErrorMessage` (redação de tokens, senhas e URLs).
  - Registram `render.failed` no `AuditLog`.
  - Lançam `UnrecoverableError` (BullMQ) para impedir retries automáticos inúteis.
- **Falhas Transitórias**: Falhas de rede ou indisponibilidade temporária de S3/MinIO.
  - Liberam a lease e redefinem o job para `PENDING` (caso o executionToken ainda pertença ao worker).
  - Permitem retries com backoff exponencial do BullMQ sem perda do job nem vazamento de credenciais.

---

## 4. Reconciliação e ID Determinístico no BullMQ

1. **ID Determinístico Padrão**: Uso de `render-<renderJobId>` sem caractere `:` (dois-pontos). IDs customizados no BullMQ não podem conter `:` de acordo com a validação nativa da biblioteca, eliminando a necessidade de qualquer subclasse ou monkey-patching interno (`RenderBullJob`/`RenderBullQueue`).
2. **Reconciliação de Inicialização e Periódica**:
   - `RendererReconciler` roda a cada intervalo configurável (padrão 60s) com guarda de concorrência (`isRunning`) para evitar sobreposição.
   - Busca no banco via `discover_reconcilable_render_jobs()` apenas jobs em `PENDING` ou `PROCESSING` com lease expirada.
   - Enfileira no BullMQ apenas se o job não existir ou estiver em estado terminal (`completed`/`failed`).
   - Se a lease estiver ativa, lança `ActiveLeaseError` (erro transitório) para que o BullMQ não considere a tarefa concluída com falso sucesso.
   - Em caso de shutdown (`SIGINT`/`SIGTERM`), o timer do reconciler é limpo imediatamente.

---

## 5. Prontidão de Armazenamento (Storage Readiness)

- Adicionado `checkReadiness(): Promise<boolean>` na abstração `mediaStorage` usando `HeadBucketCommand` do AWS SDK S3 com timeout seguro de 3s (sem listar, criar ou apagar objetos).
- Endpoint `/health/ready` do renderer retorna status `503 Unavailable` caso o bucket/storage S3 esteja inacessível, enquanto `/health/live` permanece `200 OK`.
- Interface `MediaStorage` preserva compatibilidade com doubles de testes existentes.

---

## 6. Sanitização de Logs e Limite Central de Exceções

- **Sanitização Universal**: Logs não contêm URLs assinadas, tokens Bearer ou Meta, endpoints privados ou strings de conexão de banco de dados (`sanitizeErrorMessage`). Identificadores do domínio (`renderJobId`, `mediaAssetId`) são preferidos.
- **Limite Central de Tratamento**: Todas as operações pós-aquisição (leitura, template, download, render, reserva de mídia, upload e finalização) são protegidas por um bloco central:
  - Falhas permanentes conhecidas gravam `FAILED` com código seguro e lançam `UnrecoverableError`.
  - Falhas transitórias liberam o job de volta para `PENDING` somente se o worker ainda mantiver o `executionToken`.
  - Workers antigos com token substituído por fencing nunca alteram o estado do job.

---

## 7. Resultados das Verificações e Testes

Todos os passos de validação foram executados localmente no ambiente isolado de teste:

1. **`pnpm db:generate`**: Prisma Client 7.10.0 gerado com sucesso.
2. **`node scripts/run-tests.mjs migrate`**: 18 migrations verificadas sem pendências.
3. **`pnpm test` (Unitário)**: 149 testes passaram (13 suítes).
4. **`node scripts/run-tests.mjs integration` (Integração)**: 215 testes passaram (10 suítes), incluindo todos os 34 testes de render-worker, reconciliação periódica, storage readiness e fencing tokens.
5. **`node scripts/run-tests.mjs e2e` (Playwright E2E)**: 36 testes passaram (desktop e mobile).
6. **`pnpm typecheck`**: Compilação TypeScript de todos os 7 pacotes do workspace e `tsconfig.tools.json` com zero erros.
7. **`pnpm lint`**: ESLint executado com zero warnings e zero erros.
8. **`pnpm format:check`**: Prettier validou formatação de todos os arquivos.
9. **`pnpm build`**: Build de produção executado com sucesso em todos os pacotes e Next.js.
10. **`git diff --check`**: Verificação concluída sem conflitos ou espaços em branco residuais.

---

## 6. Evidência da Geração Real nos Três Formatos

Testado com o pipeline real completo do worker contra o MinIO local (`socialflow-media-test`), validando metadados reais gerados pelo Sharp e Satori:

- **SQUARE**: Dimensões `1080x1080`, MIME `image/png`, SHA-256 verificado contra o MinIO, persistência única no banco sob `MediaAsset`.
- **PORTRAIT**: Dimensões `1080x1350`, MIME `image/png`, SHA-256 verificado contra o MinIO, persistência única no banco sob `MediaAsset`.
- **STORY**: Dimensões `1080x1920`, MIME `image/png`, SHA-256 verificado contra o MinIO, persistência única no banco sob `MediaAsset`.
- **Idempotência**: Reexecução controlada contra o mesmo objeto persistido não duplicou registros no banco e retornou `ALREADY_COMPLETED`.
