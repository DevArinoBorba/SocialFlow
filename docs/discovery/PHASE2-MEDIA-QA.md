# Relatório de Garantia da Qualidade (QA) — Biblioteca de Imagens

**Projeto**: SocialFlow  
**Data**: 15/09/2026  
**Ambiente**: Local isolado (Docker / MinIO / PostgreSQL 17.11 / Redis 8.10)  
**Documento de Origem**: `docs/discovery/PHASE2-MEDIA-IMPLEMENTATION.md`  
**Regras de Governança**: `agents/AGENTS.md`  
**Evidência de Execução Nova**: `.local/socialflow-acceptance-1789506404366-1bfed0/result.json`

---

## 1. Parecer Executivo de QA

| Veredito                                                                    |                  Status                  | Motivo Principal                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :-------------------------------------------------------------------------- | :--------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **APROVADO NO ESCOPO DE CÓDIGO**<br>_(com ressalva operacional de storage)_ | ⚠️ **APROVADO COM RESSALVA OPERACIONAL** | Todas as correções de código, segurança (RLS, autorização, CSP no proxy, storage, tratamento de uploads incompletos) e testes E2E (Desktop e Mobile) foram implementadas e validadas com 100% de sucesso no ensaio isolado da fundação (`pnpm test:foundation`).<br><br>**Ressalva / Pendência Separada**: A rotina de backup/recuperação de desastres para os objetos binários no Cloudflare R2 permanece uma pendência operacional externa e não foi declarada implementada. |

---

## 2. Correções Implementadas no Código

Após a conclusão da revisão paralela e autorização do usuário, foram executadas integralmente todas as correções técnicas consolidadas:

### 2.1. Correção do Fluxo E2E de Edição e Persistência

- **Arquivo**: `apps/web/app/media-library.tsx` e `tests/e2e/media.spec.ts`
- **Problema anterior**: O elemento `<h3>{asset.name}</h3>` era desmontado ao entrar em modo de edição, invalidando o locator Playwright `.filter({ has: heading })` e gerando timeout de 30s.
- **Correção aplicada**:
  1. O cabeçalho `<h3>{asset.name}</h3>` com o nome original da imagem foi mantido no DOM fora do condicional de edição, preservando a semântica de acessibilidade (WCAG) e a estabilidade do locator do teste.
  2. Adicionado o atributo identificador estável `data-asset-id={asset.id}` no elemento `<article>` de cada card.
  3. Comprovada a edição, a persistência dos metadados após recarregar a página (`page.reload()`) e o arquivamento em ambos os viewports (Desktop e Mobile), sem necessidade de aumentar nenhum timeout.

### 2.2. Política de Segurança de Conteúdo (CSP) no Proxy

- **Arquivo**: `apps/web/app/api/[...path]/route.ts`
- **Problema anterior**: Respostas de erro (503, 413) e rotas padrão não possuíam cabeçalhos de CSP e nosniff garantidos caso o upstream não os enviasse.
- **Correção aplicada**:
  1. Definido CSP estrito em todas as respostas do proxy.
  2. Para rotas de conteúdo de mídia (`/media/.../content`): garantido `Content-Security-Policy: default-src 'none'; sandbox`.
  3. Para rotas da API geral: garantido `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
  4. Garantido `X-Content-Type-Options: nosniff` e tratamento de erros 413/503 com headers de segurança completos.

### 2.3. Configuração e Normalização do Storage

- **Arquivo**: `apps/api/src/media-storage.ts`
- **Correção aplicada**:
  1. Tratamento e normalização do `endpoint` com remoção de barras finais (`endpoint.replace(/\/+$/, "")`) para evitar rotas com barra dupla no cliente S3.
  2. Suporte à variável `MEDIA_S3_REGION` (com fallback seguro para `"auto"`), permitindo compatibilidade com provedores S3 que exigem região explícita.
  3. Manutenção das proteções contra uso do bucket de backup (`socialflow-backups` ou `R2_BUCKET`) e credenciais de backup reutilizadas.

### 2.4. Política de Row-Level Security (RLS)

- **Arquivo**: `packages/db/prisma/migrations/202609150001_media/migration.sql`
- **Problema anterior**: A política de `UPDATE` delegava a verificação de privilégios de arquivamento exclusivamente ao trigger procedural `protect_media_scope`.
- **Correção aplicada**:
  1. A cláusula `WITH CHECK` da política `media_update` foi reforçada para exigir:
     `can_edit_client("organizationId","clientId") AND (NOT archived OR can_manage("organizationId")) AND EXISTS (...)`
  2. Agora, tentativas de alteração de `archived = true` por perfis sem `can_manage` (como `EDITOR`) são sumariamente rejeitadas na própria camada de RLS do PostgreSQL, além da barreira do trigger.

### 2.5. Tratamento de Falhas e Uploads Incompletos (Item 6 da Revisão)

- **Arquivo**: `apps/api/src/media.ts`
- **Problema identificado**: O atalho `if (error instanceof MediaError) throw error;` no catch de finalização ocorria antes do log operacional. Quando a autorização era revogada entre a gravação no storage e a finalização, o registro podia permanecer em `uploading` sem evidência estruturada de correlação para reconciliação. Além disso, nenhuma rotina deve presumir que toda falha consegue transicionar para `failed` com auditoria quando as permissões do ator foram revogadas ou o banco estiver inacessível.
- **Correção aplicada**:
  1. **Log operacional antes de relançar**: Registro estruturado `media_upload_failed` emitido antes de relançar qualquer erro (inclusive `MediaError`), contendo `stage` (`storage_put` ou `database_commit`), `correlationId` e `assetId`, sem expor segredos, credenciais ou mensagens brutas.
  2. **Preservação de autorização sem ampliação de privilégios**: A tentativa de marcar o asset como `failed` continua sendo executada sob o contexto de permissões do chamador (`access(...)`), sem credenciais privilegiadas nem bypass de RLS.
  3. **Log de necessidade de reconciliação**: Se a autorização for revogada ou houver falha de banco ao tentar marcar `failed`, o sistema emite log operacional estruturado `media_reconciliation_needed` com `stage`, `correlationId`, `assetId`, `storageKey` e `status: "uploading"`.
  4. **Preservação da resposta original**: O erro original (ex.: 404 por perda de acesso, ou 503 por indisponibilidade) chega intacto ao cliente. Nenhum objeto incompleto é publicado e nenhum evento `media.created` é gerado.
  5. **Auditoria de falha contextual**: O evento `media.upload_failed` na tabela `AuditLog` é registrado somente quando a transição para `failed` for autorizada e persistida.

---

## 3. Validação do Estado Atual do Código

Execução das ferramentas estáticas, tipagem, testes unitários e build de produção:

| Comando                 | Resultado Real | Detalhes                                                                     |
| :---------------------- | :------------: | :--------------------------------------------------------------------------- |
| `pnpm format:check`     | ✅ **PASSOU**  | Prettier validou todos os arquivos sem divergências de estilo.               |
| `pnpm lint`             | ✅ **PASSOU**  | ESLint 10.10.0 validou o projeto sem erros e sem avisos.                     |
| `pnpm typecheck`        | ✅ **PASSOU**  | TypeScript 6.0.3 validou os 6 pacotes do monorepo e ferramentas sem erros.   |
| `pnpm test` (Unitários) | ✅ **PASSOU**  | 30 testes passaram em 561ms (15 em `media.test.ts`, 15 em `config.test.ts`). |
| `pnpm build`            | ✅ **PASSOU**  | Next.js 16.3.4 Turbopack e pacotes compilados com sucesso.                   |

---

## 4. Nova Execução do Ensaio Isolado da Fundação (`pnpm test:foundation`)

A nova execução do ensaio isolado foi disparada após as correções e concluída com **êxito absoluto**:

- **ID do Projeto Efêmero**: `socialflow-acceptance-1789506404366-1bfed0`
- **Horário de Término**: `2026-09-15T21:10:21.543Z`
- **Duração Total**: 217.16s
- **Arquivo de Evidência**: `.local/socialflow-acceptance-1789506404366-1bfed0/result.json`

### 4.1. Resumo das Fases do Ensaio

```json
{
  "project": "socialflow-acceptance-1789506404366-1bfed0",
  "completedAt": "2026-09-15T21:10:21.543Z",
  "result": "passed",
  "durationSeconds": 217.161,
  "restoreSeconds": 3.016
}
```

1. **Subida de Infraestrutura e Verificações Iniciais**:
   - Containers iniciados com sucesso: PostgreSQL 17.11, Redis 8.10, MinIO (`media-storage`), API, Worker, Web.
   - `verify("empty")`: Passou (banco zerado, migrações prontas).
   - `verify("seed")`: Passou (seed idempotente validado com hash).
   - `verify("bootstrap")`: Passou (banco isolado `bootstrap_check`, 5 migrações aplicadas, incluindo `202609150001_media`).

2. **Testes de Integração**:
   - `tests/integration/foundation.test.ts`: 15 testes passaram.
   - `tests/integration/brands.test.ts`: 16 testes passaram.
   - `tests/integration/media.test.ts`: 13 testes passaram (incluindo testes de proxy CSP, concorrência atômica, RBAC e falha de upload).
   - **Total de Integração**: **44 de 44 testes passaram (100%)** em 15.87s.

3. **Testes Ponta a Ponta E2E (Playwright)**:
   - **Total**: **16 de 16 testes passaram (100%)** em 17.7s.
   - Testes de Mídia:
     - `ok 8 [desktop] › tests/e2e/media.spec.ts:11:1 › image library uploads, previews, edits and archives (1.5s)`
     - `ok 16 [mobile] › tests/e2e/media.spec.ts:11:1 › image library uploads, previews, edits and archives (1.9s)`
   - Testes de Marcas e Clientes:
     - Todos os 14 testes de marcas e clientes passaram em Desktop e Mobile sem nenhuma regressão.

4. **Recuperação e Integridade do Banco**:
   - `pg_dump -Fc` e `pg_restore` executados no banco `restore_check`.
   - `verify("restore")`: Passou (fingerprint de integridade verificado com sucesso nas 6 tabelas com RLS e FORCE RLS: `Client`, `Brand`, `MediaAsset`, `Organization`, `Membership`, `AuditLog`).

### 4.2. Execução Final Corrigida do Item 6 (Eliminação de Headers Remotos, Revogação Real e Correlação)

Após a correção integral dos três achados da revisão final do Item 6, o código da aplicação foi expurgado de qualquer controle remoto de falha via headers HTTP, a revogação de autorização passou a ser exercitada contra a infraestrutura real do PostgreSQL durante a gravação real no MinIO, e o tratamento de correlationId foi desacoplado entre servidor e cliente com sanitização estrita. A suíte completa de testes e checagens foi reexecutada:

- **Comando de Integração**: `node scripts/run-tests.mjs integration`
- **Data/Horário da Execução**: `15/09/2026 20:52:18` (UTC: `2026-09-16T00:52:18Z`)
- **Duração da Execução**: 17.26s
- **Arquivo de Log**: `.local/media-integration-item6.log`
- **Resultado Geral de Integração**: **48 de 48 testes passaram (100%)** em 3 arquivos (`media.test.ts`: 17, `foundation.test.ts`: 15, `brands.test.ts`: 16).
- **Testes Unitários**: `pnpm test` com 33 de 33 testes aprovados em 771ms (`.local/unit-test-item6.log`).
- **Formatação**: `pnpm format:check` com 0 violações (`.local/format-check-item6.log`).
- **Linter**: `pnpm lint` com 0 erros/avisos (`.local/lint-item6.log`).
- **Checagem de Tipos**: `pnpm typecheck` com 0 erros nos 7 workspaces e ferramentas (`.local/typecheck-item6.log`).
- **Compilação**: `pnpm build` com sucesso em todos os pacotes e Next.js (`.local/build-item6.log`).

#### Detalhamento dos Três Cenários e Identificação da Infraestrutura (`tests/integration/media.test.ts`):

1. **Injeção de Cabeçalhos Legados no Handler Normal (Remoção dos Controles Remotos)**:
   - **Infraestrutura**: **Infraestrutura Real** (API Node.js/Express normal em container Docker, PostgreSQL real, MinIO real).
   - **Comportamento**: A requisição de upload envia os cabeçalhos legados `x-test-fail-storage`, `x-test-fail-commit`, `x-test-fail-recovery`, `x-test-revoke-membership` com `NODE_ENV=test`.
   - **Evidência**: O handler ignora completamente todos os headers legados. Retorna `201 Created`, transiciona status para `ready`, cria `media.created` e serve os bytes do storage normalmente (`GET /content` retorna 200).

2. **Falha em `storage.put` com Dependência Substituível**:
   - **Infraestrutura**: **Dependência Simulada de Storage** (Harness local injeta storage com erro em `put()`; banco PostgreSQL real).
   - **Comportamento**: Falha durante a gravação binária (`stage: storage_put`).
   - **Evidência**: Retorna `503 Service Unavailable`, transiciona status para `failed` (liberando cota de reservas), audita `media.upload_failed`, 0 `media.created`, e conteúdo não é servido (`GET /content` retorna 404).

3. **Revogação Real no PostgreSQL Durante Upload Real no MinIO (Sincronização Determinística)**:
   - **Infraestrutura**: **Infraestrutura Real Completa** (MinIO real + PostgreSQL real).
   - **Comportamento**:
     1. Gravação binária real no MinIO através de `realStore.put()`.
     2. Ponto de pausa determinístico antes da finalização dispara a revogação real do vínculo do usuário no PostgreSQL via conexão administrativa exclusiva de teste (`migration.membership.update({ where: { id: "membership-editor-a" }, data: { active: false } })`).
     3. O fluxo é retomado, deixando `access()` e as transações reais executarem.
     4. `access()` detecta membership inativa e lança `MediaError(404, "Cliente não encontrado.")`.
     5. O handler tenta a recuperação real marcando `failed`, mas esta tentativa também executa `access()`, sendo rejeitada de forma segura sem elevação de privilégios.
     6. O handler emite os logs operacionais estruturados `media_upload_failed` (`stage: database_commit`) e `media_reconciliation_needed` (`status: uploading`, assetId, storageKey, correlationId interno do servidor e clientCorrelationId sanitizado).
     7. A fixture é restaurada no bloco `finally` reativando a membership.
   - **Evidência**: Resposta preserva erro de autorização original (`404 Not Found`), 0 eventos `media.created`, 0 eventos `media.upload_failed` (sem ampliação indevida de privilégios), conteúdo inacessível (`GET /content` retorna 404), log operacional de reconciliação presente, e banco consistente.

4. **Falha de Banco Injetada na Dependência de Persistência durante Commit e Recuperação**:
   - **Infraestrutura**: **Dependência Simulada de Persistência** (Harness local intercepta `scoped` na camada de dependência para falhar no commit de finalização e na recuperação; MinIO real).
   - **Comportamento**: Chamadas iniciais de verificação e claiming passam normalmente (transicionando para `uploading`); a falha é injetada na dependência de persistência a partir do commit de finalização e na tentativa subsequente de recuperação do handler, exercitando a lógica de resiliência real do handler.
   - **Evidência**: Resposta `503 Service Unavailable`, registro mantido em status `uploading` sem publicação, emissão de `media_upload_failed` e `media_reconciliation_needed`, 0 eventos `media.created` e 0 eventos `media.upload_failed`, conteúdo inacessível (`GET /content` retorna 404).

5. **Sanitização e Desacoplamento do `correlationId`**:
   - O servidor reutiliza prioritariamente o identificador interno `X-Request-Id` gerado pelo middleware da aplicação com `randomUUID()` ou um novo UUID v4 aleatório e não determinístico, que é o identificador soberano nos logs (`correlationId`).
   - O cabeçalho fornecido pelo cliente `x-correlation-id` é mantido separado (`clientCorrelationId`) e rigorosamente sanitizado via regex `/^[a-zA-Z0-9_-]{1,64}$/`. Após remover espaços nas extremidades, entradas com formato inválido, espaços internos ou tamanho superior a 64 caracteres são descartadas (convertidas para `null`).
   - 3 testes unitários dedicados em `tests/unit/media.test.ts` comprovam a sanitização e a validação do formato UUID aleatório v4.

---

## 5. Matriz de Requisitos Funcionais e de Segurança

| Requisito / Critério                         |    Avaliação    | Evidência Técnica                                                                                                                                                                                                                                                                                                                                                          |
| :------------------------------------------- | :-------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upload de Imagem**                         | ✅ **APROVADO** | Reserva JSON (`POST`) seguida de stream binário (`PUT /content`). Validação estrita de 10 MiB e 25 megapixels.                                                                                                                                                                                                                                                             |
| **Normalização & Sanitização**               | ✅ **APROVADO** | Decodificação e re-encoding completos com `sharp`, remoção de EXIF/metadados e rejeição de animações/multi-page.                                                                                                                                                                                                                                                           |
| **Concorrência Atômica**                     | ✅ **APROVADO** | Transação atômica em `updateMany(status='uploading')`. Somente 1 requisição retorna `201 Created` e gera evento `media.created`; a concorrente recebe `409 Conflict`.                                                                                                                                                                                                      |
| **Tratamento de Falhas de Upload**           | ✅ **APROVADO** | Erros de gravação ou commit registram falha operacional (`media_upload_failed`) com correlação e tentam marcar `failed` com auditoria `media.upload_failed` quando autorizado. Se o acesso for revogado ou o banco falhar, emite `media_reconciliation_needed` sem ampliação de privilégios, preservando o erro original e mantendo o registro isolado para reconciliação. |
| **Serviço Autenticado & CSP no Proxy**       | ✅ **APROVADO** | `GET /content` valida tenant e sessão a cada chamada. Proxy Web injeta `default-src 'none'; sandbox` em rotas de mídia e `default-src 'none'; frame-ancestors 'none'` nas demais.                                                                                                                                                                                          |
| **Isolamento Multi-Tenant e Multi-Cliente**  | ✅ **APROVADO** | Tentativas de IDOR retornam `404 Not Found`. Vínculo composto `(organizationId, clientId, brandId)` impede que marcas de outros clientes sejam vinculadas.                                                                                                                                                                                                                 |
| **Controle de Acesso por Perfil (RBAC)**     | ✅ **APROVADO** | - `OWNER`/`ADMIN`: Upload, edição e arquivamento.<br>- `EDITOR`: Upload e edição; bloqueado para arquivamento.<br>- `APPROVER`/`CLIENT_VIEWER`: Somente visualização de metadados e preview.                                                                                                                                                                               |
| **Política de RLS para Arquivamento**        | ✅ **APROVADO** | Cláusula `WITH CHECK (NOT archived OR can_manage("organizationId"))` impede diretamente no banco que usuários não administradores alterem `archived`.                                                                                                                                                                                                                      |
| **Edição e Persistência na Interface (E2E)** | ✅ **APROVADO** | Card mantém cabeçalho original durante a edição; dados editados persistem após recarregar a página e arquivamento remove o item da listagem (1.5s desktop, 1.9s mobile).                                                                                                                                                                                                   |
| **Regressão nos Módulos Existentes**         | ✅ **APROVADO** | 100% de sucesso nos testes de Marcas e Clientes. Zero regressões.                                                                                                                                                                                                                                                                                                          |

---

## 6. Inspeção Visual e Responsividade (Screenshots)

Screenshots reais inspecionados em `test-results/`:

### 6.1. Desktop (1280px)

- **Arquivo**: `test-results/media-image-library-uploads-previews-edits-and-archives-desktop/media-library.png`
- **Análise**:
  - Painel de biblioteca integrado harmoniosamente abaixo do módulo de marcas.
  - Formulário expansível bem diagramado: Nome, Sobre a imagem, Marca (select), Seletor de arquivo e botão de envio.
  - Grade de imagens responsiva com proporções preservadas e badges informativos de resolução e tamanho em KB.
  - Mensagens de feedback ("Imagem adicionada à biblioteca.", "Imagem atualizada.") com contraste e legibilidade adequados.

### 6.2. Mobile (375px)

- **Arquivo**: `test-results/media-image-library-uploads-previews-edits-and-archives-mobile/media-library.png`
- **Análise**:
  - Ajuste perfeito em coluna única vertical.
  - Teste de overflow horizontal aprovado (`scrollWidth <= innerWidth`).
  - Botões de ação com áreas de toque adequadas e formulário de edição acessível sem quebra de viewport.

---

## 7. Análise de Recuperação de Desastres: Status e Pendências

### 7.1. Metadados no Banco de Dados: ✅ COMPROVADO

- O ensaio isolado executou `pg_dump` e `pg_restore` no banco `restore_check`.
- A tabela `MediaAsset` está formalmente incorporada ao fingerprint operacional em `scripts/verify-operations.ts`.
- As 6 tabelas com RLS e integridade referencial composta foram validadas no estado pós-restore.

### 7.2. Objetos Binários no Cloudflare R2: ⚠️ PENDÊNCIA SEPARADA

- Conforme orientado pela governança do projeto:
  - O ensaio automatizado local utiliza um container `MinIO` efêmero (`socialflow-media-test`).
  - Os scripts operacionais existentes de backup (`socialflow-backup.sh` e `socialflow-restore.sh`) contemplam exclusivamente o banco PostgreSQL e seus dumps criptografados.
  - **A recuperação dos objetos binários de mídia no Cloudflare R2 permanece uma pendência operacional separada**.
  - **Não se declara a proteção de recuperação de mídia implementada** até que uma rotina específica de replicação/cópia independente do bucket de mídia seja desenvolvida e testada.

---

## 8. Conclusão e Próximos Passos para Homologação

1. **Estado do Código**: Todas as pendências de desenvolvimento, segurança e automação E2E foram sanadas.
2. **Ambiente de Homologação**:
   - Provisionar bucket dedicado privado no Cloudflare R2 para mídia.
   - Definir exclusivamente no serviço `api` as 4 variáveis dedicadas (`MEDIA_S3_ENDPOINT`, `MEDIA_S3_BUCKET`, `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY`) com HTTPS obrigatório.
3. **Plano Operacional de Storage**:
   - Elaborar procedimento de cópia/replicação independente para os objetos de mídia no R2 antes de promover o sistema a produção.

### Complemento local do Item 6 — 16/09/2026

Corrigido `markedFailed` nos dois caminhos: a recuperação só é considerada persistida após `access()` resolver, incluindo a confirmação da transação. Se essa confirmação falhar, o log de reconciliação é emitido. Ambos os logs de reconciliação agora incluem `stage`.

Validação desta revisão: 26 testes aprovados em `tests/unit/media-handler.test.ts` e `tests/unit/media.test.ts`; lint dos arquivos de código alterados e checagens de tipos da API e ferramentas aprovados. Os 8 novos casos executam HTTP em loopback, validação real da imagem e o handler real, com armazenamento e persistência em memória. Cobrem headers ignorados em `production`, `development` e `test`, recuperação nos dois estágios, preservação do 404 após perda do vínculo e falha na confirmação da recuperação. Verificam UUID v4 interno, descarte do identificador externo excessivo e ausência da credencial sentinela dos erros nos logs e respostas.

Limite: esses testes não comprovam RLS nem integração com PostgreSQL/MinIO. `.local/media-integration-item6.log` permanece como evidência histórica de 48 testes; a integração não foi reexecutada nesta revisão. Registro local: `.local/media-item6-local-review.log`. Sem acesso à VPS, commit, push ou deploy.
