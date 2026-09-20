# Walkthrough: Endurecimento Final da Publicação Manual na Meta (Fase 3)

Este documento descreve o endurecimento final realizado sobre o commit `aa01df2`, focado em resiliência atômica pré-chamada à Meta, gestão de lease persistente (`leaseExpiresAt`), reconciliação de tentativas abandonadas e estados incertos (`UNCERTAIN`), endpoint autenticado de resolução manual para OWNER/ADMIN e cobertura abrangente de testes.

---

## 1. Tratamento Atômico de Falhas Pré-Meta

Anteriormente, as tentativas eram reservadas no PostgreSQL no estado `PROCESSING` antes da criação do ticket público de mídia no Redis. Caso o Redis, o armazenamento ou qualquer preparação subsequente falhasse antes da primeira chamada à Meta, as tentativas poderiam permanecer `PROCESSING` indefinidamente, bloqueando novos disparos devido ao índice único parcial `PublicationAttempt_single_active_idx`.

### Correções Implementadas:

- **Finalização Atômica**: Toda exceção ocorrida após a reserva no banco e antes da primeira chamada à Meta é capturada e finaliza atomicamente as tentativas afetadas no estado `FAILED`.
- **Código de Erro Seguro**: Registrado `errorCode = "PREPARATION_FAILED"` e mensagem segura `"Falha na preparação da publicação antes do envio."`.
- **Auditoria**: Registrada ação `post.publish_failed` no `AuditLog` para cada tentativa afetada.
- **Liberação da Chave HTTP de Idempotência**: A chave de idempotência no Redis (`idempotency:publish:...`) é removida para permitir nova tentativa imediata pelo cliente.
- **Proteção contra Vazamento de Detalhes Internos**: A resposta HTTP retorna `503` com a mensagem sanitizada `"Falha na preparação da publicação. Tente novamente."`, nunca expondo mensagens ou falhas de Redis, S3/MinIO ou PostgreSQL.

---

## 2. Gestão de Lease e Recuperação de Tentativas Abandonadas

### 2.1 Coluna `leaseExpiresAt` e Migration

- Adicionada a coluna `leaseExpiresAt TIMESTAMP(3)` no modelo `PublicationAttempt`.
- Adicionado índice `PublicationAttempt_status_leaseExpiresAt_idx` sobre `(status, leaseExpiresAt)`.
- Migration criada: `packages/db/prisma/migrations/202609200002_publication_lease_and_reconciliation/migration.sql`.
- Concedida permissão específica `GRANT UPDATE ("leaseExpiresAt") ON "PublicationAttempt" TO socialflow_runtime;` garantindo conformidade com as regras de privilégios mínimos do banco.

### 2.2 Ciclo de Vida da Lease

- Na reserva da tentativa (`PROCESSING`), a lease é definida com timeout de 3 minutos (`Date.now() + 180_000`).
- No Instagram, ao criar e persistir o container (`CONTAINER_CREATED`), a lease é renovada por mais 3 minutos para cobrir o polling de processamento.
- Ao concluir a publicação (`PUBLISHED`, `FAILED` ou `UNCERTAIN`), a lease é liberada (`leaseExpiresAt: null`).

### 2.3 Distinção entre Execução Ativa e Processo Abandonado

Ao receber uma solicitação de publicação para uma conta social com tentativa em andamento (`PENDING`, `PROCESSING`, `CONTAINER_CREATED`):

1. **Lease Ativa (`leaseExpiresAt > now`)**:
   - Bloqueio estrito de concorrência: retorna HTTP `409 Conflict` com `"Publicação em andamento para a conta social..."`.
2. **Lease Expirada (`leaseExpiresAt <= now`)**:
   - **Instagram**:
     - Se possuir `creationContainerId`, a tentativa anterior é marcada como `FAILED` com `errorCode: "ABANDONED_LEASE_EXPIRED"`, registra auditoria `post.lease_expired`, e a nova tentativa retoma o fluxo aproveitando o container existente sem recriá-lo na Meta.
     - Se não possuía container, marca a anterior como `FAILED` e permite nova criação com `attemptNumber` incrementado.
   - **Facebook**:
     - Como não é possível verificar com certeza o status remoto sem ID prévio, a tentativa anterior é transicionada para `UNCERTAIN` com `errorCode: "LEASE_EXPIRED_UNCERTAIN"`, grava auditoria `post.publish_uncertain`, e rejeita nova publicação automática com HTTP `409 Conflict`, exigindo reconciliação manual do administrador.

---

## 3. Resiliência Pós-Sucesso Remoto e Estados `UNCERTAIN`

- **Falha após Sucesso Remoto**: Caso a chamada à Meta Graph API tenha retornado sucesso (com `remoteMediaId`), mas a transação curta de persistência local falhar (queda de conexão, crash ou timeout), a tentativa é transicionada para `UNCERTAIN` com `errorCode = "REMOTE_SUCCESS_PERSISTENCE_FAILED"`, preservando o `remoteMediaId` e `creationContainerId`.
- **Prevenção de Duplicação**: O estado `UNCERTAIN` é incluído no índice único parcial `PublicationAttempt_single_active_idx`, impedindo republicação cega e evitando posts duplicados no feed da rede social.

---

## 4. Endpoint de Resolução Manual para OWNER / ADMIN

Para dar controle definitivo ao administrador sobre publicações em estado incerto (`UNCERTAIN`) ou expiradas, foi implementado o endpoint autenticado:

```http
POST /api/organizations/:org/clients/:clientId/posts/:postId/attempts/:attemptId/resolve
```

### 4.1 Permissões e Segurança

- Restrito exclusivamente a usuários com papel `OWNER` ou `ADMIN` no tenant/organização (avaliado via `accessScope`).
- Tentativas por usuários com perfis como `CLIENT_VIEWER`, `APPROVER` ou `EDITOR` são rejeitadas com HTTP `403 Forbidden`.
- Tentativas já no estado `PUBLISHED` são rejeitadas com HTTP `400 Bad Request`.
- Tentativas com lease ainda ativa são rejeitadas com HTTP `409 Conflict`.

### 4.2 Decisões Suportadas

1. **`CONFIRM_PUBLISHED`**:
   - Confirma que o post foi publicado remotamente (permite informar `remoteMediaId` e `remotePermalink`).
   - Transiciona a tentativa para `PUBLISHED` e limpa a lease.
   - Registra no `AuditLog`: `post.reconciled_published`.
   - O índice único `PublicationAttempt_single_published_idx` garante que nenhuma publicação futura possa ser feita para este post e conta.
2. **`CONFIRM_FAILED`**:
   - Confirma que o post não foi publicado remotamente.
   - Transiciona a tentativa para `FAILED` com `errorCode: "MANUALLY_RECONCILED_FAILED"`.
   - Registra no `AuditLog`: `post.reconciled_failed`.
   - Libera o índice parcial ativo, permitindo que os operadores disparem uma nova tentativa controlada com `attemptNumber` incrementado.
3. **`DISMISS`**:
   - Mantém o registro com anotações explicativas do administrador sem alterar o bloqueio.
   - Registra no `AuditLog`: `post.reconciled_dismissed`.

---

---

## 5. Preparação em Duas Fases: Consistência Transacional contra Reservas Órfãs

### 5.1 O Bloqueio de Consistência Identificado

No commit `b2f7f87`, ao processar múltiplos alvos (`socialAccountIds`), as tentativas eram reservadas sequencialmente como `PROCESSING` no loop. Se uma conta subsequente fosse do Facebook com lease expirada, o método realizava a transição dessa conta para `UNCERTAIN` e retornava `uncertainAccount`, confirmando a transação.
Fora da transação, a API respondia HTTP `409 Conflict`. A conta válida processada anteriormente no loop já havia sido confirmada no banco em `PROCESSING`, permanecendo presa e bloqueando novas publicações, embora nenhuma chamada remota tivesse sido disparada.

### 5.2 Arquitetura em Duas Fases (Same-Transaction Two-Phase Prep)

A preparação foi refatorada em duas etapas estritas dentro da transação curta (`shortTx`):

1. **Fase 1 (Análise e Validação Global)**:
   - Itera por todas as contas selecionadas sem executar mutações no banco.
   - Valida status `PUBLISHED` (bloqueio imediato 409).
   - Valida status `UNCERTAIN` (bloqueio imediato 409).
   - Valida leases ativas (`leaseExpiresAt > now` -> bloqueio imediato 409).
   - Valida expiração de lease e regras de plataforma:
     - **Instagram**: permite retomar container prévio ou recomeçar; planeja `RESUME_INSTAGRAM`.
     - **Facebook**: sem ID remoto não pode prosseguir; coleta o ID da tentativa expirada para transição `UNCERTAIN`.
   - Valida status da conta e credenciais (planeja `RECORD_FAILED` ou `CREATE_PROCESSING`).

2. **Decisão Global**:
   - Se **qualquer** conta Facebook possuir lease expirada, o lote **não prossegue**.
   - Atualiza **apenas** as tentativas Facebook expiradas para `UNCERTAIN` e grava auditoria `post.publish_uncertain`.
   - **Nenhuma** tentativa `PROCESSING` é criada para as demais contas.
   - A chave de idempotência é liberada no Redis e a API responde HTTP `409 Conflict`.

3. **Fase 2 (Efetivação Atômica)**:
   - Somente executada se a análise global confirmar que o lote pode prosseguir.
   - Atualiza tentativas abandonadas do Instagram (`FAILED`/`ABANDONED_LEASE_EXPIRED`).
   - Cria todas as novas reservas `PROCESSING` com suas leases ativas.
   - Cria registros `FAILED` para contas inativas ou com token inválido.
   - Grava auditorias correspondentes.

---

## 6. Matriz de Testes e Validação Completa

### 6.1 Testes de Integração (`tests/integration/publication.test.ts`)

- `primeira conta válida e segunda Facebook com lease expirada: não reserva conta válida, transiciona Facebook para UNCERTAIN, libera idempotência e não chama Meta`
- `primeira Facebook com lease expirada e segunda válida: não reserva conta válida, transiciona Facebook para UNCERTAIN, libera idempotência e não chama Meta`
- `três contas com bloqueio na última (Facebook expirado): nenhuma conta anterior fica em PROCESSING, libera idempotência e não chama Meta`
- `três contas com bloqueio por lease ativa na última: nenhuma conta anterior é reservada, libera idempotência e não chama Meta`
- `falha na preparação ou ticket após reserva finaliza tentativa atomicamente como FAILED com PREPARATION_FAILED, grava audit e libera idempotência`
- `lease ativa em tentativa PROCESSING bloqueia concorrência (409)`
- `lease expirada para Instagram permite retomada controlada aproveitando o mesmo container sem duplicar`
- `lease expirada para Facebook transiciona para UNCERTAIN, bloqueia republicação e permite resolução manual pelo administrador`
- `resolução manual com CONFIRM_FAILED permite nova tentativa controlada com attemptNumber 2`
- `resolução manual com CONFIRM_PUBLISHED impede duplicação definitiva (409)`
- `rejeição de resolução manual por perfil não-administrador com 403`
- `isolamento multi-tenant, validação de contas sociais e integridade de mídia pública`

### 6.2 Resultados Exatos da Suíte de Verificação

- **Testes Unitários (`pnpm test`)**: 10 arquivos, 131 testes aprovados (100%).
- **Testes de Integração (`node scripts/run-tests.mjs integration`)**: 6 arquivos, 113 testes aprovados (100%).
- **Testes E2E Playwright (`node scripts/run-tests.mjs e2e`)**: 34 testes aprovados em desktop e mobile (100%).
- **Typecheck (`pnpm typecheck`)**: 6 pacotes e ferramentas validados com 0 erros.
- **Lint (`pnpm lint`)**: 0 erros e 0 avisos.
- **Format Check (`pnpm format:check`)**: Todos os arquivos formatados de acordo com o padrão Prettier.
- **Build de Produção (`pnpm build`)**: Todos os pacotes e Next.js compilados com sucesso.
- **Ambientes Remotos**: Nenhuma chamada real à Meta, nenhum deploy em homologação ou produção e nenhum arquivo `.claude/` incluído.
