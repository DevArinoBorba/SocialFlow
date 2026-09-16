# Aceite Independente — Fase 2 (Incremento 1): Cadastro de Marcas por Cliente

Data de execução: 14/09/2026
Executor: Agente independente de aceite (não é o autor da implementação nem da revisão)
Commit base: `770bcac3e0761267438b9e1f95a0cf82765fda5d` (`master`, "docs: add foundation access acceptance report and operations guide")
Conjunto de alterações testado: working tree não commitado sobre o commit base — `apps/api/src/app.ts`, `apps/web/app/page.tsx`, `apps/web/app/styles.css`, `docs/discovery/API-MATRIX.md`, `docs/discovery/THREAT-MODEL.md`, `packages/contracts/src/index.ts`, `packages/db/prisma/schema.prisma`, `scripts/verify-operations.ts` (modificados) e `packages/db/prisma/migrations/202609140001_brands/`, `tests/integration/brands.test.ts`, `tests/e2e/brands.spec.ts`, `docs/discovery/PHASE2-BRANDS-IMPLEMENTATION.md`, `docs/discovery/PHASE2-BRANDS-REVIEW.md` (novos) — exatamente o mesmo conjunto identificado em `PHASE2-BRANDS-REVIEW.md`, incluindo as correções R-1/R-2.
Ambiente: **Ambiente de Testes Local (Windows 11 / Docker Desktop 29.7.2 / PostgreSQL 17.11-alpine via role `socialflow_runtime`)**, containers isolados e efêmeros criados e destruídos por esta execução. Nenhuma conexão com VPS, homologação ou secrets reais.

> Este relatório não aceita `PHASE2-BRANDS-IMPLEMENTATION.md` nem `PHASE2-BRANDS-REVIEW.md` como prova suficiente. Todo achado abaixo foi reexecutado nesta sessão (comandos, containers, testes automatizados e capturas de tela reais) ou verificado lendo o código/SQL diretamente. Os dois relatórios anteriores foram preservados sem alteração.

---

## 1. Comandos executados nesta sessão e resultados

| #   | Comando                                                             | Onde                                                                                          | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm format:check`                                                 | Host local                                                                                    | **Passou** — 100% conforme (a inconsistência O-3 apontada na revisão, no próprio `PHASE2-BRANDS-IMPLEMENTATION.md`, já não existe mais)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | `pnpm lint`                                                         | Host local                                                                                    | **Passou** — 0 erros, 0 avisos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | `pnpm typecheck`                                                    | Host local                                                                                    | **Passou** — 6/6 pacotes + tools do monorepo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | `pnpm test` (Vitest unitário)                                       | Host local                                                                                    | **Passou** — 15/15                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | `pnpm build`                                                        | Host local                                                                                    | **Passou** — `packages/config`, `packages/contracts`, `packages/db`, `apps/api`, `apps/web` (`next build`, rotas estáticas/dinâmicas geradas), `apps/worker`. Execução nova e explícita nesta sessão — o relatório de correções R-1/R-2 não apresentava uma reexecução do build após as correções, conforme apontado na tarefa.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `pnpm test:foundation` (`scripts/foundation-drill.mjs`)             | Docker Desktop, projeto isolado `socialflow-acceptance-1789398893017-e73eae`, portas efêmeras | **Passou de ponta a ponta** (detalhe na seção 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7   | Script de verificação adicional (autoria desta sessão, ver seção 3) | Docker Desktop, projeto isolado `socialflow-extra-1789399240064-099513`, portas efêmeras      | **Passou** — 15/15 verificações adicionais (detalhe na seção 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | Leitura completa do código                                          | Host local                                                                                    | `packages/db/prisma/migrations/202609140001_brands/migration.sql`, `packages/db/prisma/migrations/202609110002_isolation/migration.sql`, `packages/db/prisma/migrations/202609120001_audit_revocation/migration.sql`, `apps/api/src/app.ts` (endpoints de marca linha a linha, `actor`/`scoped`/`respond`), `packages/db/src/index.ts` (`asActor`, `assertRuntimeRole`), `packages/contracts/src/index.ts` (`brandInput`/`brandUpdate`), `apps/web/app/page.tsx` e `apps/web/app/styles.css` (formulário, grid responsivo, `maxLength`), `tests/integration/brands.test.ts` (as 13 suítes, incluindo o teste R-1 completo), `tests/e2e/brands.spec.ts`, `docs/discovery/API-MATRIX.md`, `docs/discovery/THREAT-MODEL.md`, diff de `packages/db/prisma/schema.prisma` |
| 9   | Inspeção visual de screenshots reais                                | Host local                                                                                    | `test-results/brands-desktop.png`, `test-results/brands-mobile.png` (gerados pelo drill oficial) **e** `test-results/acceptance-longtext-desktop.png`, `test-results/acceptance-longtext-mobile.png` (gerados por esta sessão com texto real próximo aos limites documentados)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Limitações desta execução:**

- Não houve qualquer acesso à VPS/homologação. Tudo rodou em containers Docker locais, efêmeros, com secrets gerados aleatoriamente e portas dinâmicas.
- Não foi feito fuzzing/pentest manual de payloads (SQLi/XSS) além de leitura de código — mesma limitação documentada na revisão independente anterior, e pelas mesmas razões (React escapa por padrão, sem `dangerouslySetInnerHTML`; Prisma parametrizado, sem raw query com interpolação de string neste incremento).
- Não foram testadas condições de concorrência/race em edições simultâneas da mesma marca — mesmo comportamento (last-write-wins dentro de uma transação) já aceito para `Client` na fundação; não é uma regressão deste incremento.
- Os volumes Docker das duas execuções desta sessão foram preservados (comportamento herdado do `foundation-drill.mjs`, que nunca remove volumes) em `.local/socialflow-acceptance-1789398893017-e73eae/` e `.local/socialflow-extra-1789399240064-099513/`. Nenhum dado de homologação/produção foi tocado.
- Backup externo criptografado e ensaio de restauração **na VPS** continuam como pendência operacional separada (já registrada em `FOUNDATION-CLOSURE.md` e reconfirmada em `FOUNDATION-ACCESS-ACCEPTANCE.md`). O que este relatório valida é o `pg_dump`/`pg_restore` local dentro do drill isolado — não substitui esse ensaio remoto.

---

## 2. Resultado do drill completo (`pnpm test:foundation`)

Executado uma única vez, isolado, evidência em `.local/socialflow-acceptance-1789398893017-e73eae/result.json` (`"result": "passed"`, `durationSeconds: 174.996`, `restoreSeconds: 2.507`).

| Etapa                                                                                        | Resultado observado                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build das 4 imagens (api, migrate, web, worker)                                              | Sucesso, incluindo `next build` e `tsc` de todos os pacotes                                                                                                                                                   |
| `verify empty`                                                                               | `user.count()=0`, `organization.count()=0`, 4 migrations aplicadas com `finished_at` não nulo                                                                                                                 |
| `prisma migrate deploy` explícito sobre o banco (já migrado via dependência do `compose up`) | **`No pending migrations to apply.`** — confirma repetição segura do `migrate deploy` num banco já migrado, sem erro e sem alterar dados                                                                      |
| `verify seed`                                                                                | Seed em `NODE_ENV=production` falha corretamente (`exit 1`); seed idempotente preserva edição do operador (fingerprint idêntico antes/depois de reexecutar com senha diferente)                               |
| `bootstrap_check` (banco **vazio** separado)                                                 | `prisma migrate deploy` aplica as 4 migrations do zero: `202609110001_foundation` → `202609110002_isolation` → `202609120001_audit_revocation` → `202609140001_brands`, sem erro                              |
| Bootstrap CLI concorrente (2 execuções simultâneas)                                          | Exatamente 1 sucesso e 1 rejeição (`[0,1].sort()`), sem duplicidade de organização/usuário                                                                                                                    |
| `pnpm test:integration`                                                                      | **28/28 passaram** — `tests/integration/brands.test.ts` (13/13) + `tests/integration/foundation.test.ts` (15/15)                                                                                              |
| `pnpm test:e2e`                                                                              | **12/12 passaram** — `tests/e2e/brands.spec.ts` (4/4, desktop+mobile) + `tests/e2e/clients.spec.ts` (8/8, desktop+mobile)                                                                                     |
| `pg_dump` / `createdb restore_check` / `pg_restore --single-transaction --exit-on-error`     | Sucesso                                                                                                                                                                                                       |
| `verify restore`                                                                             | Fingerprint do banco restaurado idêntico ao original; RLS/FORCE RLS ativos nas 5 tabelas (`Client`, `Brand`, `Organization`, `Membership`, `AuditLog`); isolamento cross-org ainda válido no banco restaurado |
| Teardown                                                                                     | `docker compose down` — containers e rede removidos; volumes preservados para inspeção (nenhum dado real tocado)                                                                                              |

---

## 3. Verificações adicionais independentes (autoria desta sessão)

A tarefa pediu explicitamente para não aceitar os relatórios como prova suficiente. Identifiquei duas lacunas reais de cobertura no material entregue e uma terceira que decidi reforçar mesmo já coberta, e escrevi um script próprio (`.local/acceptance-scripts/acceptance-extra-drill.mjs`, gitignorado, evidência em `.local/socialflow-extra-1789399240064-099513/extra-result.json`) para fechá-las num segundo ambiente Docker isolado e efêmero:

### 3.1. Repetição de `migrate deploy` num banco já populado

O drill oficial já demonstra a repetição segura em um banco **recém-migrado e vazio**. Para fechar explicitamente o pedido da tarefa ("repetição segura de migrate deploy" **com dados**), rodei `prisma migrate deploy` uma segunda vez após popular o banco com o seed de desenvolvimento (6 usuários, 2 organizações, 2 clientes, 6 memberships):

- **Resultado**: `No pending migrations to apply.`
- **Contagem antes**: `{"users":6,"clients":2,"memberships":6}`
- **Contagem depois**: `{"users":6,"clients":2,"memberships":6}` — **idêntica**.

### 3.2. Layout mobile/desktop com texto real no limite documentado

O `PHASE2-BRANDS-IMPLEMENTATION.md` afirma que o E2E foi atualizado para preencher os campos com "textos longos (1000 caracteres)". **Isso não é verdade**: medi programaticamente as strings usadas em `tests/e2e/brands.spec.ts` (linhas 39-44) — `description` tem 146 caracteres, `targetAudience` 115 e `toneOfVoice` 70. Nenhuma chega perto dos limites reais documentados (2000/1000/1000). É uma variação do mesmo padrão já flagrado como O-3 na revisão anterior (relatório afirmando uma cobertura que a reexecução não confirma) — só que desta vez no arquivo de teste, não no `format:check`. Ver achado A-1 na seção 5.

Para validar de fato o comportamento com conteúdo no limite, criei uma marca com `name` de 106 caracteres, `description` de exatamente 2000 caracteres, `targetAudience` e `toneOfVoice` de exatamente 1000 caracteres cada (strings de letra repetida, o pior caso possível para quebra de linha por não ter espaços que ajudem o `overflow-wrap`), e tirei screenshots reais em 1280px (desktop) e 390px (mobile):

- **Desktop**: `.brand-grid` computado com 2 colunas; `scrollWidth <= innerWidth`; bloco de descrição não se sobrepõe ao grid (`descBox.y + descBox.height = 648.06 <= gridBox.y = 664.06`).
- **Mobile**: `.brand-grid` computado com 1 coluna; `scrollWidth <= innerWidth`; bloco de descrição não se sobrepõe ao grid (`descBox.y + descBox.height = 2805.2 <= gridBox.y = 2821.2`).
- **Inspeção visual** (`test-results/acceptance-longtext-desktop.png`, `test-results/acceptance-longtext-mobile.png`): o texto quebra linha corretamente via `overflow-wrap: anywhere` mesmo sem espaços, sem corte, sem sobreposição e sem rolagem horizontal em nenhum dos dois viewports. A correção R-2 (colapso do `.brand-grid` para 1 coluna abaixo de 720px) se sustenta mesmo no cenário mais adverso permitido pelo contrato Zod, não apenas com os textos curtos usados no E2E oficial.
- Nota metodológica: como reusei o mesmo `name` nas duas iterações (desktop e depois mobile) sem limpar entre elas, a screenshot mobile mostra dois cartões de marca (o criado na iteração desktop e o da própria iteração mobile) — isso é um artefato do meu script auxiliar, não um comportamento do produto; ambos os cartões foram removidos ao final e as medições de coluna/overflow foram feitas sobre o primeiro cartão (`.first()`), permanecendo válidas.

### 3.3. Bloqueio para cliente, organização e usuário inativos (específico de marcas)

O `PHASE2-BRANDS-REVIEW.md` confirma por leitura de código que os 4 endpoints de marca revalidam `client.active`, e a suíte `brands.test.ts` testa revogação de **membership**. Não havia, porém, um teste automatizado exercitando `client.active=false`, `organization.active=false` ou `user.active=false` especificamente contra os endpoints de marca (apenas genericamente contra clientes, na fundação). Testei diretamente via HTTP, com `editor-a` mantendo cookie de sessão válido durante todo o processo:

| Cenário                                                                      | Resultado                                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Acesso antes de qualquer alteração                                           | `200`                                                                       |
| `Client.active = false` (org e membership permanecem ativos) → `GET /brands` | `404`                                                                       |
| `Client.active = false` → `POST /brands`                                     | `404`                                                                       |
| `Client.active = true` novamente → `GET /brands`                             | `200` (acesso restaurado)                                                   |
| `Organization.active = false` → `GET /brands`                                | `404`                                                                       |
| `Organization.active = true` novamente → `GET /brands`                       | `200` (acesso restaurado)                                                   |
| `User.active = false` → `GET /brands`                                        | `401` (não 404 — corta na camada `actor()`, antes mesmo de resolver escopo) |

Todos os 7 sub-cenários passaram, confirmando que a proteção descrita no código (`app.ts:373-376`, `406-409`, `439-442`, `499-502` para `client.active`; `scoped()` para `organization.active`/`membership.active`; `actor()` para `user.active`) funciona de fato para os endpoints de marca, não só para clientes.

---

## 4. Verificação item a item das prioridades da tarefa

**1. Teste HTTP combinando `clientId` autorizado com `brandId` de outro cliente.**
Confirmado. `tests/integration/brands.test.ts:450-593` (teste `R-1`) faz exatamente o cenário pedido: `editor-a` autorizado só em `client-a`, chama `GET` e `PATCH` em `/organizations/org-a/clients/client-a/brands/<brandA2.id>`. Reexecutei esse teste dentro do drill isolado (não apenas li o código): **404 em ambos**, mensagem `"Marca não encontrada."`, corpo da resposta não contém nome/descrição/público da marca A2 (asserção explícita `not.toContain`), `brandA2` permanece inalterada no banco (nome, descrição, público, tom verificados campo a campo), zero `AuditLog` com `action: "brand.updated"` para o `entityId` da marca A2. Caso positivo de controle no mesmo teste: o mesmo usuário consulta (`200`) e edita (`200`) a marca autorizada A1 com sucesso. **28/28 testes de integração passaram**, incluindo este.

**2. Layout mobile/desktop com textos longos.**
Confirmado, com uma ressalva de acurácia do relatório do implementador (ver seção 3.2 e achado A-1). O CSS (`.brand-grid` colapsando para 1 coluna abaixo de 720px, `overflow-wrap: anywhere`) funciona corretamente tanto com os textos curtos do E2E oficial quanto — o que testei adicionalmente — com texto real no limite documentado (2000/1000/1000 caracteres, pior caso sem espaços). Sem cortes, sobreposição ou rolagem horizontal em nenhum dos dois cenários. Screenshots reais inspecionadas visualmente, não apenas as asserções automáticas.

**3. Permissões dos cinco perfis; isolamento entre organizações e entre clientes.**
Confirmado via `tests/integration/brands.test.ts`, reexecutado nesta sessão: `OWNER`/`ADMIN` com acesso total (linhas 331-389), `EDITOR` restrito ao cliente vinculado com bloqueio em cliente não vinculado (391-448), `APPROVER`/`CLIENT_VIEWER` com leitura permitida e escrita bloqueada com `403` e mensagem específica (594-648), isolamento cross-org via Prisma direto bypassando a API (78-114), isolamento cross-client na mesma org (116-160). Todos os 5 perfis exercitados via chamada HTTP autenticada real, não apenas checagem de RLS isolada.

**4. Revogação com sessão aberta; bloqueio para usuário/organização/cliente inativo.**
Confirmado. Revogação de membership com cookie ainda válido: `tests/integration/brands.test.ts:687-728` (reexecutado, `404` imediato em `GET`/`POST`, acesso restaurado após reativação). Bloqueio específico de marca para cliente/organização/usuário inativos: não havia teste automatizado dedicado no material entregue — escrevi e executei um (seção 3.3), com resultado 100% conforme ao esperado (404 para cliente/organização inativos, 401 para usuário inativo, todos com o mesmo cookie de sessão nunca renovado).

**5. RLS via `socialflow_runtime`; imutabilidade do vínculo; atomicidade entre alteração e auditoria.**
Confirmado por leitura direta do SQL e reexecução dos testes. `packages/db/prisma/migrations/202609140001_brands/migration.sql:29-72`: `ENABLE`/`FORCE ROW LEVEL SECURITY`, políticas `brand_read`/`brand_create`/`brand_update` usando `can_read_client`/`can_edit_client` (definidas em `202609110002_isolation`) **e** reforçando explicitamente `client.active` dentro da própria policy (redundância proposital). Privilégios da role: `GRANT SELECT, INSERT` e `GRANT UPDATE (name, description, "targetAudience", "toneOfVoice", "updatedAt")` — sem `UPDATE` em `organizationId`/`clientId`/`id`, sem `DELETE`. Trigger `protect_brand_scope` bloqueia com `ERRCODE 42501` qualquer tentativa de alteração de `organizationId`/`clientId` mesmo via Prisma direto bypassando a API — testado em `brands.test.ts:162-196` (reexecutado, passou). `DELETE` físico direto rejeitado — testado em `brands.test.ts:198-220` (reexecutado, passou). Atomicidade: `asActor()` (`packages/db/src/index.ts:25-39`) envolve toda a rota — mutação da marca **e** `auditLog.create` — em um único `db.$transaction`; li o código linha a linha e confirmo que não há caminho para persistir uma marca sem o log correspondente ou vice-versa.

**6. `audit_read`/`audit_create` para marcas e clientes; vínculo com organização/cliente, não apenas "UUID não colide"; revogação bloqueia leitura sem apagar histórico.**
Confirmado, e verifiquei especificamente o ponto que a tarefa pediu para não aceitar de graça: as políticas (`migration.sql:88-116`) **não** dependem apenas de UUIDs não colidirem. O branch de marca em `audit_read`/`audit_create` é `EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_read_client(b."organizationId", b."clientId"))` — ou seja, mesmo que um `entityId` de marca colidisse teoricamente com algum outro id, a política ainda exige que essa marca pertença à mesma organização do log **e** que o ator tenha `can_read_client`/`can_edit_client` sobre o cliente daquela marca especificamente. Não é uma comparação de string solta. Testei a preservação do comportamento de clientes (`brands.test.ts:291-329`, regressão, reexecutada) e a revogação imediata para marcas (`brands.test.ts:222-289`, reexecutada): após desativar a membership, tanto a marca quanto o log de auditoria ficam invisíveis (`findMany` retorna `[]`) para o ator revogado, mas ao reativar a membership o mesmo log volta a aparecer com o mesmo `id` — confirmando que o histórico não foi apagado, apenas ocultado pela RLS.

**7. Migration em banco vazio e sobre a fundação com dados fictícios; preservação de dados; repetição segura de `migrate deploy`.**
Confirmado em três cenários distintos, todos executados nesta sessão: (a) banco completamente vazio → `bootstrap_check` aplica as 4 migrations do zero sem erro (seção 2); (b) banco com a fundação e dados fictícios do seed → `migrate deploy` reexecutado é no-op (`No pending migrations to apply.`) tanto no drill oficial quanto no meu script adicional, sem qualquer erro; (c) contagens de linhas (`users`, `clients`, `memberships`) idênticas antes e depois da segunda execução de `migrate deploy` sobre o banco populado (seção 3.1) — nenhuma perda ou duplicação de dado.

---

## 5. Achados desta sessão

### A-1 (Observação, não bloqueante) — o relatório do implementador supersestima a cobertura de texto longo no E2E oficial

- **Onde:** `docs/discovery/PHASE2-BRANDS-IMPLEMENTATION.md`, seção 5.2 ("O teste E2E foi atualizado para preencher descrições, público-alvo e tom de voz com textos longos (1000 caracteres)"); código real em `tests/e2e/brands.spec.ts:39-44`.
- **Descrição:** medição direta mostra que as strings usadas têm 146 (`description`), 115 (`targetAudience`) e 70 (`toneOfVoice`) caracteres — não 1000. O teste ainda é válido para o que ele cobre (fluxo de criação/edição, presença de 1/2 colunas, ausência de scroll horizontal), mas não exercita o cenário de pior caso que R-2 supostamente corrige. Mesmo padrão do achado O-3 da revisão anterior (afirmação de conformidade não confirmada na reexecução), desta vez no arquivo de teste em vez do relatório de formatação.
- **Não bloqueia o aceite** porque validei manualmente nesta sessão (seção 3.2) que o comportamento real com texto no limite documentado (2000/1000/1000 caracteres) funciona corretamente — a lacuna é de cobertura de teste automatizado e de precisão do relatório, não uma falha de produto.
- **Sugestão:** aumentar as strings de `tests/e2e/brands.spec.ts` para próximo dos limites reais (ou usar `.repeat()` como fiz na verificação ad hoc), e revisar a frase do relatório do implementador para refletir o que o teste de fato cobre.

### A-2 (Observação, não bloqueante) — bloqueio de marca por cliente/organização/usuário inativo não tinha teste automatizado dedicado

- **Onde:** ausência em `tests/integration/brands.test.ts` (existe apenas o teste de revogação de _membership_, `687-728`); o comportamento em si está correto no código (`app.ts:373-376`, `406-409`, `439-442`, `499-502`, `scoped()`, `actor()`).
- **Descrição:** escrevi e executei esse teste nesta sessão (seção 3.3) porque a tarefa pedia explicitamente essa confirmação e ele não existia no material entregue. Todos os 7 sub-cenários passaram.
- **Não bloqueia o aceite.**
- **Sugestão:** incorporar um teste equivalente ao meu script ad hoc (`.local/acceptance-scripts/acceptance-extra-drill.mjs`, preservado localmente e não commitado) em `tests/integration/brands.test.ts`, cobrindo `client.active=false`, `organization.active=false` e `user.active=false` contra os 4 endpoints de marca.

Nenhum achado desta sessão é bloqueador. Ambos são lacunas de cobertura/relato, não falhas de comportamento do produto — em ambos os casos, a reexecução independente confirmou que o comportamento real está correto mesmo onde o teste automatizado ou o relatório eram mais fracos do que afirmavam.

---

## 6. Parecer

> [!IMPORTANT]
> **PARECER: APROVADO PARA IMPLANTAÇÃO EM HOMOLOGAÇÃO.**
>
> Todas as 7 prioridades da tarefa foram verificadas de forma independente nesta sessão — não apenas lidas nos relatórios anteriores — com resultado consistente: proteção contra IDOR de marca confirmada por teste HTTP real e reexecutado; layout responsivo confirmado com screenshots reais, inclusive com texto no limite documentado (mais rigoroso que o teste E2E oficial); matriz de 5 perfis e isolamento entre organizações/clientes confirmados via chamadas HTTP autenticadas; revogação com sessão aberta e bloqueio de usuário/organização/cliente inativo confirmados, inclusive um cenário (cliente/organização inativos especificamente para marcas) que não tinha teste automatizado e foi validado manualmente nesta sessão; RLS/FORCE RLS, imutabilidade de escopo e atomicidade de auditoria confirmadas por leitura de SQL e reexecução de testes que tentam violá-las diretamente via Prisma, bypassando a API; políticas de auditoria de marca confirmadas como vinculadas a organização/cliente reais via `EXISTS`, não a coincidência de UUID; migração testada em banco vazio, em banco populado, e com repetição segura de `migrate deploy` sem perda de dados em ambos os casos.
>
> Os dois achados registrados (A-1, A-2) são observações de cobertura de teste e precisão de relatório, não falhas de comportamento — o comportamento real subjacente foi validado nesta sessão em ambos os casos. Nenhuma falha reproduzível foi encontrada nesta execução.
>
> **Esta aprovação cobre apenas o ambiente local isolado.** Não substitui validação na VPS/homologação — que precisa repetir, no mínimo, os testes de perfis/isolamento (nos moldes de `FOUNDATION-ACCESS-ACCEPTANCE.md`, agora estendidos aos endpoints de marca) contra o domínio real. Backup externo criptografado e ensaio de restauração de desastre na VPS continuam como pendência operacional separada, não coberta por este documento.

---

## 7. Roteiro breve de verificação após um futuro deploy autorizado em homologação

Após um deploy autorizado (fora do escopo desta sessão), repetir manualmente contra `https://homolog-socialflow.oriumdigital.com.br` (ou o domínio de homologação vigente), com dados fictícios prefixados (ex.: `test-brands-*`) e limpeza ao final, nos moldes de `FOUNDATION-ACCESS-ACCEPTANCE.md`:

1. Confirmar as 4 migrations aplicadas (`_prisma_migrations`) e RLS/FORCE RLS ativos em `Brand` na VPS.
2. Repetir o cenário R-1 (IDOR: `clientId` autorizado + `brandId` de outro cliente da mesma org) via HTTPS real, com um EDITOR de teste.
3. Confirmar visualmente (captura de tela real, não só asserção) o layout de `.brand-grid` em mobile e desktop com pelo menos uma marca de conteúdo real longo.
4. Repetir a matriz dos 5 perfis para marcas (list/detail/create/update) contra a organização/cliente de teste.
5. Revogar uma membership de teste com sessão de navegador real aberta e confirmar corte imediato (sem logout) tanto no acesso a marcas quanto na leitura de auditoria via RLS direto.
6. Inativar um cliente de teste (mantendo membership/organização ativas) e confirmar que os endpoints de marca retornam 404 mesmo assim.
7. Confirmar que nenhum dado de teste permanece ativo/visível após a limpeza (mesmo padrão de "Situação Pós-Limpeza" usado em `FOUNDATION-ACCESS-ACCEPTANCE.md`).

---

## 8. Acompanhamento e Fechamento das Pendências A-1 e A-2 (14/09/2026)

Esta seção foi redigida em 14/09/2026 para documentar a consolidação formal da cobertura automatizada e o fechamento definitivo das observações A-1 e A-2 apontadas na seção 5. As seções 1 a 7 anteriores permanecem integralmente preservadas como registro histórico de aceite.

### 8.1. Situação de A-1 e A-2

| Item    | Pendência Original                                                                                   | Situação Atual | Resumo da Consolidação                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A-1** | Textos longos no E2E com pior caso sem espaços nos limites documentados                              | **FECHADO**    | Cenário automatizado versionado em `tests/e2e/brands.spec.ts` testando criação, persistência após reload e edição com strings contínuas sem espaços no limite máximo exato (descrição com 2000 caracteres, público-alvo com 1000 caracteres e tom de voz com 1000 caracteres). Inspeção visual de screenshots reais comprovando 1 coluna no mobile, 2 no desktop, ausência de scroll horizontal e integridade total salva no PostgreSQL.                           |
| **A-2** | Entidades inativas (Cliente, Organização, Usuário) sem teste de integração HTTP dedicado para marcas | **FECHADO**    | Suíte automatizada versionada em `tests/integration/brands.test.ts` testando cliente inativo (`Client.active=false`), organização inativa (`Organization.active=false`) e usuário inativo (`User.active=false`) com sessão autenticada aberta. Todos os 4 endpoints (listagem, detalhe, criação e edição) testados, validando códigos de status (404/401), ausência de vazamento de dados, ausência de mutação no banco e ausência de logs de auditoria indevidos. |

### 8.2. Arquivos Alterados

1. `tests/e2e/brands.spec.ts`:
   - Adicionado teste `admin creates, verifies persistence after reload, and edits brand with long continuous text at field limits`.
   - Exercita criação com `description` (2000 chars contínuos `"D"`), `targetAudience` (1000 chars contínuos `"A"`), `toneOfVoice` (1000 chars contínuos `"T"`).
   - Valida colunas de `.brand-grid` (1 no mobile, 2 no desktop), ausência de scroll horizontal (`scrollWidth <= innerWidth`) e ausência de sobreposição vertical (`descBox.y + descBox.height <= gridBox.y + 4`).
   - Valida integridade do registro no banco via Prisma (`findFirstOrThrow`).
   - Valida persistência após recarregamento da página (`page.reload()` e reabertura do cliente).
   - Executa edição com novo conjunto de limites contínuos (`updatedDesc` 2000 chars `"E"`, `updatedAudience` 1000 chars `"B"`, `updatedTone` 1000 chars `"U"`).
   - Valida persistência da edição no banco e após novo reload da interface.
   - Gera capturas de tela inspecionadas: `test-results/brands-longtext-desktop.png` e `test-results/brands-longtext-mobile.png`.
2. `tests/integration/brands.test.ts`:
   - Adicionado bloco `describe("inactive entities blocking with open session (A-2)")` contendo 3 testes completos e isolados:
     - `inactive client: blocks brand list, detail, creation, and edition with open session without data leakage or mutation` (HTTP 404).
     - `inactive organization: blocks brand list, detail, creation, and edition with open session without data leakage or mutation` (HTTP 404).
     - `inactive user: rejects open session with 401 across brand list, detail, creation, and edition without data leakage or mutation` (HTTP 401).
   - Cada cenário realiza baseline positivo prévio, inativação pontual em banco, 4 tentativas na mesma sessão com asserções de não-vazamento/não-mutação/auditoria inalterada, e restauração em bloco `finally`.
3. `eslint.config.mjs`:
   - Adicionado `".local/**"` aos padrões de ignore do ESLint para espelhar `.gitignore` e garantir conformidade de linting em todo o repositório.

### 8.3. Bateria de Verificações Executada e Resultados

Todos os checks foram executados no ambiente local isolado e passaram com 100% de sucesso:

| Check                       | Comando                 | Resultado                   | Observações                                                                                                                                                                                                                            |
| --------------------------- | ----------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatação                  | `pnpm format:check`     | **Passou**                  | 100% dos arquivos compatíveis com o Prettier.                                                                                                                                                                                          |
| Linting                     | `pnpm lint`             | **Passou**                  | 0 erros, 0 avisos em todo o projeto.                                                                                                                                                                                                   |
| Tipagem estática            | `pnpm typecheck`        | **Passou**                  | 6 pacotes monorepo + ferramentas validados sem erro.                                                                                                                                                                                   |
| Testes unitários            | `pnpm test`             | **Passou**                  | 15/15 testes unitários passaram.                                                                                                                                                                                                       |
| Build monorepo              | `pnpm build`            | **Passou**                  | Build completo de todos os pacotes e apps (`next build` em Turbopack concluído).                                                                                                                                                       |
| Testes de integração        | `pnpm test:integration` | **Passou**                  | **31/31 testes passaram** (15 de foundation + 16 de marcas, incluindo os 3 novos de A-2).                                                                                                                                              |
| Testes E2E (Playwright)     | `pnpm test:e2e`         | **Passou**                  | **14/14 testes passaram** (8 de clients + 6 de marcas, em Chrome desktop e mobile emulado).                                                                                                                                            |
| Ensaio operacional completo | `pnpm test:foundation`  | **Passou de ponta a ponta** | Docker efêmero `socialflow-acceptance-1789412228161-c07a41`: build de 4 imagens, 4 migrations aplicadas, seed, bootstrap concorrente, 31 integrações, 14 E2E, `pg_dump`, `pg_restore` e verificação pós-restore aprovados com saída 0. |

### 8.4. Inspeção Visual das Screenshots

As imagens geradas pela execução oficial do Playwright foram inspecionadas:

- `test-results/brands-longtext-desktop.png` (1280x800): `.brand-grid` perfeitamente alinhado em 2 colunas, texto de 2000 caracteres quebrando continuamente sem estourar o container, texto de 1000 caracteres de público-alvo e tom de voz quebrando sem overflow.
- `test-results/brands-longtext-mobile.png` (390x844): `.brand-grid` colapsado em 1 coluna vertical, todos os textos quebrando perfeitamente dentro dos 390px, sem barra de rolagem horizontal (`scrollWidth <= innerWidth`).

### 8.5. Limitações e Pendências Operacionais Remanescentes

- Backup externo criptografado e ensaio de restauração de desastres **na VPS remota** continuam sendo uma pendência operacional separada (já registrada desde o encerramento da fundação).
- O arquivo `docs/discovery/PHASE2-BRANDS-HOMOLOGATION.md` permanece untracked pelo Git nesta sessão (aguardando autorização explícita do usuário para commit futuro).
