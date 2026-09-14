# Revisão Independente — Fase 2 (Incremento 1): Marcas por Cliente

Data da revisão: 14/09/2026
Revisor: Agente independente (não é o autor da implementação)
Commit revisado: estado de working tree em `master` no momento da revisão (mudanças não commitadas: `apps/api/src/app.ts`, `apps/web/app/page.tsx`, `apps/web/app/styles.css`, `packages/contracts/src/index.ts`, `packages/db/prisma/schema.prisma`, `scripts/verify-operations.ts`, mais os arquivos novos de migration/testes/documentação listados no `git status`)

> Este documento não aceita `PHASE2-BRANDS-IMPLEMENTATION.md` como prova. Todas as afirmações relevantes do relatório do implementador foram reexecutadas de forma independente (build, lint, typecheck, testes unitários, e o "foundation drill" completo — containers isolados, migração, seed, testes de integração reais contra PostgreSQL, testes E2E e ensaio de backup/restore) ou verificadas lendo o código/SQL diretamente.

---

## Resumo do parecer

**Nenhuma falha bloqueadora foi encontrada.** O incremento é aditivo, mantém FORCE RLS com a role não privilegiada `socialflow_runtime`, impõe a matriz de permissões por perfil de forma consistente entre API e banco, impede transferência de escopo de marca em múltiplas camadas independentes, preserva a auditoria de clientes e estende corretamente a revogação imediata para marcas.

Foram identificados **2 riscos não bloqueadores** (um de robustez de teste, outro de UX responsiva) e **4 observações/sugestões opcionais**, detalhados abaixo. Nenhum deles impede a promoção para QA.

**Declaração: APROVADO PARA QA**, condicionado a registrar os riscos residuais na seção 4 como pendências de acompanhamento (não bloqueiam o incremento atual).

---

## 1. Checks executados e limitações

| #   | Check                                      | Como foi executado                                                                                                                                                                                         | Resultado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm format:check`                        | Local, node 24.19.0 / pnpm 11.19.0                                                                                                                                                                         | Falhou (ver achado F-3) — 1 arquivo Markdown fora do padrão                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | `pnpm lint`                                | Local                                                                                                                                                                                                      | Passou, 0 erros/avisos                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | `pnpm typecheck`                           | Local, 6/6 pacotes + tools                                                                                                                                                                                 | Passou sem erros                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4   | `pnpm test` (Vitest unitário)              | Local                                                                                                                                                                                                      | 15/15 passaram                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | `pnpm test:foundation` (drill completo)    | Local, Docker Desktop, containers isolados por execução (`socialflow-acceptance-<timestamp>-<hash>`), portas efêmeras, sem tocar a VPS/homologação                                                         | **Passou de ponta a ponta**: build das 4 imagens, `verify empty`, `prisma migrate deploy` (4 migrations aplicadas), `verify seed`, bootstrap em banco isolado (`bootstrap_check`), `verify bootstrap`, `pnpm test:integration` → **27/27 passaram** (`brands.test.ts` + `foundation.test.ts`), `pnpm test:e2e` → **12/12 passaram** (desktop + mobile, `brands.spec.ts` + `clients.spec.ts`), `pg_dump`/`pg_restore` em banco separado + `verify restore`, containers derrubados ao final |
| 6   | Leitura completa do código                 | `apps/api/src/app.ts`, `apps/web/app/page.tsx`, `packages/contracts/src/index.ts`, `packages/db/prisma/schema.prisma`, migration SQL completa, `packages/db/src/index.ts` (`asActor`, `assertRuntimeRole`) | Analisado linha a linha, comparado com as migrations anteriores da fundação (`202609110002_isolation`, `202609120001_audit_revocation`) para checar coerência das funções `can_read_client`/`can_edit_client`/`can_manage`/`current_actor`                                                                                                                                                                                                                                                |
| 7   | Inspeção visual da screenshot E2E mobile   | `test-results/brands-mobile.png` (gerada pela própria execução do drill nesta revisão)                                                                                                                     | Confirma visualmente o achado F-2 (grade de 2 colunas em viewport de celular)                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | Busca por segredos/dados sensíveis em logs | Grep por `console.(log                                                                                                                                                                                     | error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | info | warn)`em`app.ts` | Nenhum log inclui corpo de requisição, senha, token ou stack trace |
| 9   | Checagem de referências de documentação    | Grep por "Brand"/"marca" em `docs/`                                                                                                                                                                        | `THREAT-MODEL.md` e `API-MATRIX.md` não foram atualizados (achado O-2)                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Limitações desta revisão:**

- Não foi feita validação na VPS/homologação, conforme instruído — todos os testes automatizados rodaram exclusivamente em containers Docker locais e efêmeros, criados e destruídos por esta revisão.
- Não executei fuzzing/pentest manual de payloads (SQLi, XSS) além da leitura de código; a proteção contra XSS depende do escape automático do React (confirmado: nenhum `dangerouslySetInnerHTML` no arquivo) e a proteção contra SQLi depende do Prisma parametrizado (nenhuma raw query com interpolação de string foi introduzida por este incremento).
- Não testei condições de carga/concorrência (race conditions em updates simultâneos da mesma marca); o Prisma não usa locking otimista aqui, mas o comportamento (last-write-wins dentro de uma transação) é idêntico ao já aceito para `Client` na fundação, então não é uma regressão introduzida por este incremento.
- Os volumes Docker (`postgres_data`, `redis_data`) da execução do drill desta revisão foram preservados em `.local/socialflow-acceptance-1789397799065-a2d1aa/` — mesmo comportamento do script original (`foundation-drill.mjs` nunca remove volumes). Nenhum dado de homologação/produção foi tocado.

---

## 2. Verificação item a item (conforme solicitado)

**1. Coerência com o escopo (listagem, consulta, criação, edição textual).**
Confirmado. Os 4 endpoints (`GET .../brands`, `GET .../brands/:id`, `POST .../brands`, `PATCH .../brands/:id`) cobrem exatamente o escopo descrito, sem arquivamento/exclusão/mídia (`apps/api/src/app.ts:365-550`). O schema Zod (`packages/contracts/src/index.ts:47-54`) é `strictObject` com apenas os 4 campos textuais documentados.

**2. Relação organização/cliente/marca, inclusive no banco.**
Confirmado em múltiplas camadas independentes:

- FK simples `Brand.organizationId → Organization.id`.
- FK **composta** `("organizationId","clientId") → Client("organizationId","id")` (migration.sql:22-26), que torna impossível no banco vincular uma marca a um cliente de outra organização, mesmo bypassando a aplicação.
- Teste de integração `cross-organization isolation` (`brands.test.ts:78-114`) tenta inserir via Prisma direto um `Brand` com `organizationId:"org-b", clientId:"client-b"` como ator `admin-a` e confirma rejeição pela RLS.

**3. Autorização por perfil na API e RLS/FORCE RLS com `socialflow_runtime`.**
Confirmado e redundante (defesa em profundidade):

- API: `listBrands`/`detailBrand` permitem qualquer papel vinculado ativo; `createBrand`/`updateBrand` exigem `admin` (OWNER/ADMIN) ou papel `EDITOR` vinculado ao cliente da URL (`app.ts:377-387`, `443-458`, `503-518`) — bate exatamente com a matriz do relatório.
- Banco: `ALTER TABLE "Brand" ENABLE/FORCE ROW LEVEL SECURITY` + políticas `brand_read`/`brand_create`/`brand_update` usando `can_read_client`/`can_edit_client` já existentes da fundação (migration.sql:29-72).
- Reexecutei o teste que comprova a role runtime não é superuser/owner/bypassrls (`brands.test.ts:63-76`) — passou.

**4. Proteção contra IDOR (IDs de recursos de outros clientes/organizações).**
Confirmado por leitura de código, com uma lacuna de cobertura de teste (ver **R-1** abaixo):

- `detailBrand`/`updateBrand` buscam a marca com `findFirst({ id: brandId, organizationId: org, clientId })` (`app.ts:421-424`, `519-522`) — se o `brandId` pertence a outro cliente (mesma org) ou outra organização, a consulta retorna vazio e o endpoint responde 404, independentemente do papel do usuário.
- Reforço no banco: mesmo se a aplicação tivesse um bug e omitisse o filtro `clientId`, a política `brand_read`/`brand_update` já reprova via `can_read_client`/`can_edit_client` quando o cliente da marca não é o vinculado ao ator.
- Testado meia-por-meio: o teste `same-org cross-client isolation` (`brands.test.ts:116-160`) comprova isso no nível de Prisma direto (bypassando a API), e o teste `EDITOR ... blocked on unassigned clients` (`brands.test.ts:391-448`) comprova via HTTP que um clientId totalmente não vinculado dá 404. **Não existe, porém, um teste HTTP que combine "clientId da URL ao qual o ator TEM acesso" + "brandId pertencente a outro cliente da mesma org"** — esse é exatamente o cenário 1.25/1.26 da suíte de fundação para clientes, e não tem equivalente para marcas. Ver **R-1**.

**5. Impossibilidade de transferir marca alterando campos de vínculo.**
Confirmado em 4 camadas independentes:

- Contrato Zod `strictObject` sem `organizationId`/`clientId`/`id` — corpo com campo extra é rejeitado com 400 (testado em `brands.test.ts:534-540`).
- `tx.brand.update` na API nunca passa esses campos no `data` (`app.ts:530-538`).
- Privilégio de coluna no Postgres: `GRANT UPDATE (name, description, "targetAudience", "toneOfVoice", "updatedAt") ON "Brand"` — não concede UPDATE em `organizationId`/`clientId`/`id` (migration.sql:86).
- Trigger `protect_brand_scope` (migration.sql:74-82) barra qualquer alteração desses campos com `ERRCODE 42501`, testado diretamente via Prisma bypassando a API em `brands.test.ts:162-196` (passou no drill local).

**6. Revogação imediata com sessão aberta.**
Confirmado. `scoped()` reconsulta `Membership`/`Organization` a cada requisição dentro de uma transação nova (`app.ts:112-139`), sem cache de sessão-para-autorização. Teste `revocation with open session` (`brands.test.ts:543-584`) desativa o vínculo em runtime e reutiliza o cookie ainda válido — passou (404 imediato) no drill local.

**7. Bloqueio para usuário/organização/cliente inativo.**
Confirmado: `actor()` valida `User.active` (`app.ts:105-109`); `scoped()` valida `Membership.active` e `Organization.active` (`app.ts:123-132`); todos os 4 endpoints de marca revalidam `Client.active` explicitamente (`app.ts:373-376`, `406-409`, `439-442`, `499-502`) antes de prosseguir — sem isso, um cliente arquivado continuaria expondo suas marcas via papel EDITOR/APPROVER/VIEWER.

**8. Atomicidade entre alteração e auditoria.**
Confirmado. `asActor` (`packages/db/src/index.ts:25-39`) envolve toda a função de rota, incluindo a mutação da marca **e** o `tx.auditLog.create`, em um único `db.$transaction`. Uma falha em qualquer uma das duas operações desfaz ambas — não há como persistir a marca sem o registro de auditoria correspondente (ou vice-versa).

**9. Leitura de auditoria de marcas sem quebrar a de clientes / sem vazar após revogação.**
Confirmado, com uma ressalva estrutural anotada como observação opcional (**O-1**): as políticas `audit_read`/`audit_create` foram reescritas com `DROP POLICY` + `CREATE POLICY` preservando o branch original de clientes (`can_read_client(org, entityId)`) e adicionando um branch novo via `EXISTS (... FROM "Brand" b WHERE b.id = entityId ...)` (migration.sql:88-116). O teste de regressão `regression: client audit logs remain functional and enforce revocation` (`brands.test.ts:291-327`) passou no drill local, confirmando que a auditoria de clientes não regrediu. O teste `brand audit log creation, visibility, and immediate revocation` (`brands.test.ts:222-289`) confirma revogação imediata também para eventos de marca — passou.

**10. Migration aditiva, preservação de dados, compatibilidade com a fundação.**
Confirmado. A migration só usa `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`/`GRANT`/`CREATE POLICY`/`CREATE TRIGGER`, mais dois `DROP POLICY`+`CREATE POLICY` (não há `DROP TABLE`/`DROP COLUMN`/`ALTER COLUMN` destrutivo). `scripts/verify-operations.ts` foi atualizado corretamente (contagem de migrations 3→4, `Brand` incluída no fingerprint e no check de RLS de 5 tabelas). Reexecutei o drill completo, que aplica as 4 migrations em um banco limpo e depois faz um `pg_dump`/`pg_restore` completo com sucesso — não há incompatibilidade com a fundação.

**11. Validação de entrada, texto simples, limites, erros, ausência de secrets em logs.**
Confirmado. Limites batem com o documentado (nome 2-120, descrição ≤2000, público/tom ≤1000, todos `trim()` antes da validação de tamanho, string vazia normalizada para `null`). Testes de rejeição (nome curto, nome longo, descrição longa, campo extra) passaram no drill local. Logs (`app.ts:69-78`, `163`) não incluem corpo de requisição nem stack trace — apenas `requestId`/`method`/`status` ou um evento genérico `request_failed`.

**12. Interface acessível, responsiva e consistente.**
Majoritariamente confirmado: labels associados a todos os campos, `role="alert"`/`role="status"` para erro/sucesso, `aria-expanded`/`aria-controls` nos toggles de formulário, skip-link, foco visível herdado do restante do app, preservação da digitação em caso de erro (nem `createBrand` nem `updateBrand` limpam o estado do formulário no `catch`). Encontrei uma lacuna real de responsividade em telas estreitas — ver **R-2**.

**13. Qualidade dos testes (cenários negativos, ausência de alterações indevidas).**
Boa cobertura geral: isolamento cross-org e cross-client, DELETE físico negado, tentativa de troca de escopo, os 5 perfis via HTTP, validação de entrada, revogação com sessão aberta. Os testes negativos verificam efeito nulo (`count.count === 0`, `findMany` vazio) e não apenas o código de status — bom sinal de rigor. A lacuna identificada é a ausência do teste IDOR específico via HTTP descrito em **R-1**.

**14. Preservação da arquitetura Docker/Coolify e correções operacionais existentes.**
Confirmado. Nenhum arquivo de `compose*.yaml`, `infra/`, ou correções de porta/proxy das últimas 3 correções (`c924ea9`, `e2ca464`, `0a12470`) foi tocado por este incremento. O drill completo (que sobe a mesma topologia de containers usada em produção/homologação, só que localmente) buildou e rodou as 4 imagens sem qualquer ajuste.

---

## 3. Achados

### R-1 (Risco não testado, severidade moderada) — IDOR de marca entre clientes da mesma organização não tem teste HTTP direto

- **Onde:** `apps/api/src/app.ts:396-428` (`detailBrand`) e `apps/api/src/app.ts:489-550` (`updateBrand`); ausência em `tests/integration/brands.test.ts`.
- **Cenário:** um EDITOR vinculado ao `client-a` conhece (ou adivinha) o `brandId` de uma marca pertencente ao `client-a2` da mesma organização e chama `GET/PATCH /api/organizations/org-a/clients/client-a/brands/<brandId-do-client-a2>`.
- **Situação real (não é uma falha):** o código já bloqueia esse cenário corretamente, pois a busca da marca exige `clientId` igual ao da URL (`{ id: brandId, organizationId: org, clientId }`), e a RLS do banco reforça o mesmo isolamento de forma independente. Verifiquei isso lendo o código e também via teste equivalente em nível de Prisma direto (`brands.test.ts:116-160`).
- **Por que ainda assim é um achado:** não há nenhum teste que exercite exatamente essa combinação (clientId autorizado da URL + brandId de outro cliente) através da API HTTP, que é a superfície real de ataque. Os testes existentes cobrem "clientId totalmente não vinculado" (que dá 404 antes mesmo de chegar à marca) — um caminho de código diferente do que protege este cenário específico.
- **Correção recomendada:** adicionar ao `brands.test.ts` um teste espelhando os cenários 1.25/1.26 da suíte de fundação: EDITOR de `client-a` chamando `GET` e `PATCH` em `/clients/client-a/brands/<brandId-do-client-a2>` e esperando 404 em ambos.

### R-2 (Risco de UX, severidade baixa) — grade de 2 colunas de "Público-alvo"/"Tom de voz" não colapsa em telas estreitas

- **Onde:** `apps/web/app/styles.css:296-303` (`.brand-grid { grid-template-columns: 1fr 1fr; ... }`), fora do bloco `@media (max-width: 720px)` (`apps/web/app/styles.css:377-...`), que já colapsa `.fields` para uma coluna mas não menciona `.brand-grid`.
- **Cenário/evidência:** confirmei visualmente rodando o E2E mobile desta revisão (`test-results/brands-mobile.png`, viewport iPhone 13 ≈390px) — mesmo com textos curtos de teste, "Público-alvo" e "Tom de voz" já ficam bem apertados lado a lado. Com conteúdo real usando o limite documentado (até 1000 caracteres em cada campo), essa grade de 2 colunas ficaria extremamente estreita (~130-150px), forçando quebras de linha excessivas — não é um "quebra" de layout (não há overflow horizontal, o teste `scrollWidth <= innerWidth` passa porque o texto quebra em vez de vazar), mas é uma degradação real de legibilidade em celular.
- **Correção recomendada:** incluir `.brand-grid { grid-template-columns: 1fr; }` dentro do `@media (max-width: 720px)` já existente, mesma abordagem usada para `.fields`.

### O-1 (Observação/sugestão opcional) — `AuditLog` sem coluna discriminadora de tipo de entidade

- **Onde:** `packages/db/prisma/schema.prisma:123-131` (modelo `AuditLog`, sem `entityType`); `packages/db/prisma/migrations/202609140001_brands/migration.sql:88-116` (políticas `audit_read`/`audit_create`).
- **Descrição:** as políticas de RLS de auditoria agora testam se `entityId` corresponde a um `clientId` OU a um `Brand.id`, via dois `EXISTS`/branches distintos, sem qualquer coluna que diga explicitamente "este evento é sobre um cliente" ou "sobre uma marca". Isso funciona corretamente hoje porque os IDs são UUIDv4 gerados independentemente (colisão entre os dois espaços de ID é estatisticamente irrelevante), mas é um padrão que não escala bem: cada novo tipo de entidade auditável na Fase 2 (ativos de mídia, campanhas, agendamentos, etc.) exigirá mais um branch acrescentado a essas duas políticas, aumentando a complexidade e o risco de erro humano ao editá-las.
- **Não é uma falha comprovada nem um risco de segurança ativo** — é uma sugestão de design para antes que mais tipos de entidade sejam adicionados à auditoria.
- **Sugestão:** considerar adicionar uma coluna `entityType` ao `AuditLog` em um incremento futuro, substituindo os `EXISTS` heurísticos por um `CASE`/lookup direto por tipo.

### O-2 (Observação/sugestão opcional) — documentação de arquitetura não acompanhou o novo escopo

- **Onde:** `docs/discovery/API-MATRIX.md` e `docs/discovery/THREAT-MODEL.md` (nenhuma menção a "Brand"/"marca" encontrada).
- **Descrição:** o novo incremento tem seu próprio documento (`PHASE2-BRANDS-IMPLEMENTATION.md`), mas os dois documentos "vivos" de referência da arquitetura (matriz de API e modelo de ameaças) não foram atualizados para incluir os novos endpoints e a ameaça equivalente de troca de ID de marca. Não é uma falha de código, mas cria risco de esses documentos ficarem desatualizados como fonte única de verdade à medida que a Fase 2 avança.
- **Sugestão:** adicionar as linhas correspondentes de `Brand` a `API-MATRIX.md` e replicar a linha de ameaça "Editor A troca ID da URL para ler/alterar cliente B" do `THREAT-MODEL.md` para o caso de marcas, já que a defesa aplicada é estruturalmente a mesma.

### O-3 (Observação/sugestão opcional) — relatório do implementador supersestima conformidade de formatação

- **Onde:** `docs/discovery/PHASE2-BRANDS-IMPLEMENTATION.md` (linha "Prettier (`pnpm format:check`): 100% em conformidade").
- **Descrição:** ao reexecutar `pnpm format:check` nesta revisão, o Prettier reportou o próprio arquivo `PHASE2-BRANDS-IMPLEMENTATION.md` como fora do padrão de formatação. Não afeta código de produção (é um Markdown), mas é uma instância concreta e verificável de o relatório do implementador afirmar 100% de conformidade quando isso não era verdade no momento da entrega — reforça a orientação da tarefa de não aceitar o relatório como prova suficiente sem reexecução independente.
- **Sugestão:** rodar `pnpm format --write` no arquivo antes de mesclar, e adicionar um lembrete de que `format:check` cobre toda a árvore, não apenas código-fonte.

### O-4 (Observação/sugestão opcional) — `brandUpdate` exige o objeto completo (sem update parcial)

- **Onde:** `packages/contracts/src/index.ts:54` (`export const brandUpdate = brandInput;`).
- **Descrição:** como `brandUpdate` é um alias direto de `brandInput`, um `PATCH` precisa reenviar `name` (obrigatório, 2-120 caracteres) mesmo que o chamador só queira alterar `toneOfVoice`. O cliente web atual sempre popula o formulário de edição com os valores atuais antes de submeter (`startEditingBrand`, `apps/web/app/page.tsx:213-223`), então não há perda de dado hoje — mas é uma armadilha em potencial para qualquer futuro consumidor de API (app mobile, integração) que tente enviar um PATCH parcial e acabe sendo rejeitado (nome ausente) ou, pior, apagando campos que não pretendia tocar.
- **Sugestão:** documentar explicitamente que o PATCH é "substituição completa" (full-replace), ou migrar para `.partial()` caso updates parciais sejam esperados em consumidores futuros.

---

## 4. Riscos residuais a acompanhar

Mesmo com o parecer de aprovação, ficam registrados para acompanhamento no próximo incremento da Fase 2:

1. Cobertura de teste HTTP para o cenário IDOR específico descrito em R-1.
2. Ajuste de CSS responsivo descrito em R-2 antes de expor telas de marca com conteúdo real longo.
3. Decisão arquitetural sobre `entityType` em `AuditLog` (O-1) antes de adicionar mais tipos de entidade auditável.
4. Atualização de `API-MATRIX.md`/`THREAT-MODEL.md` (O-2).

---

## 5. Declaração final

**Falha comprovada:** nenhuma.
**Risco não testado:** R-1 (IDOR de marca sem teste HTTP direto, mitigado por código e por RLS).
**Risco de UX:** R-2 (grade de 2 colunas não responsiva para conteúdo longo, confirmado por screenshot).
**Sugestões opcionais:** O-1, O-2, O-3, O-4.

**Parecer: APROVADO PARA QA.** Nenhuma falha bloqueadora foi encontrada nos 14 pontos verificados; os riscos e sugestões acima não impedem a promoção do incremento, mas devem ser tratados como pendências de acompanhamento.
