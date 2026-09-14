# Fase 2 (Incremento 1) — Cadastro Textual de Marcas por Cliente

Data de execução: 14/09/2026  
Status: **PRONTO PARA QA** (Aprovado em revisão independente e correções R-1/R-2 aplicadas)  
Ambiente avaliado: **Ambiente de Testes Local (Windows 11 / Docker Desktop / PostgreSQL 17.11-alpine real via role `socialflow_runtime`)**

---

## 1. Escopo Entregue

Este primeiro incremento da Fase 2 do SocialFlow implementa o cadastro e gestão textual de marcas por cliente, permitindo:

- **Listar** marcas vinculadas a um cliente específico.
- **Visualizar** detalhes textuais completos de cada marca.
- **Criar** novas marcas dentro de um cliente autorizado.
- **Editar** campos textuais de uma marca existente mantendo a consistência de escopo.

### Campos Textuais e Limites de Validação

Todos os campos são tratados estritamente como texto simples e validados via Zod (`z.strictObject`), sem permitir injeção de campos extras:

- **Nome (`name`)**: Obrigatório. Texto simples com remoção de espaços nas pontas (`trim`), entre 2 e 120 caracteres.
- **Descrição (`description`)**: Opcional. Texto simples trimado, até 2000 caracteres. Valores vazios são normalizados para `null`.
- **Público-alvo (`targetAudience`)**: Opcional. Texto simples trimado, até 1000 caracteres. Valores vazios normalizados para `null`.
- **Tom de voz (`toneOfVoice`)**: Opcional. Texto simples trimado, até 1000 caracteres. Valores vazios normalizados para `null`.

> [!NOTE]
> Conforme definido nas restrições de escopo, este incremento **não** inclui mídia/arquivos, geração por IA, integrações sociais, calendário, agendamento, publicação, arquivamento ou exclusão de marcas.

---

## 2. Decisões Arquiteturais e Reutilização Open Source

### Pesquisa e Avaliação Open Source

- **Postiz (AGPL-3.0)**: Conforme registrado no ADR-001/ADR-007, foi avaliado como referência de mercado para agendadores sociais. Seu modelo de marcas acopla diretamente conexões sociais OAuth e geração de mídia, além da restrição de licença AGPL-3.0. Decidiu-se **não** incorporar código do Postiz.
- **Nenhuma dependência nova**: A implementação utilizou exclusivamente as dependências estáveis já homologadas no repositório (`zod`, `better-auth`, `@nestjs/common`, `prisma`, `react`, `vitest`, `@playwright/test`).
- **Padrões Reutilizados**:
  - Padrão de chaves compostas no Prisma e PostgreSQL (`[organizationId, clientId]` referenciando `Client([organizationId, id])`).
  - Princípios de design limpo e acessível (`impeccable`), com formulários responsivos, preservação de digitação em caso de erro, alertas ARIA e navegação por teclado.

---

## 3. Migration Aditiva e Row-Level Security (RLS)

A migração `packages/db/prisma/migrations/202609140001_brands/migration.sql` foi desenvolvida de forma estritamente aditiva:

1. **Integridade Estrutural e Chaves Compostas**:
   - Tabela `"Brand"` criada com chave primária UUID `id` e chave única composta `@@unique([organizationId, id])`.
   - Chave estrangeira composta `("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE`, impedindo no nível de banco qualquer marca de ter cliente de outra organização.
2. **Row-Level Security (RLS) e FORCE RLS**:
   - `ALTER TABLE "Brand" ENABLE ROW LEVEL SECURITY;`
   - `ALTER TABLE "Brand" FORCE ROW LEVEL SECURITY;`
   - **`brand_read`**: Apenas se `can_read_client("organizationId", "clientId")` e o cliente correspondente estiver ativo.
   - **`brand_create`**: Apenas se `can_edit_client("organizationId", "clientId")` e o cliente correspondente estiver ativo.
   - **`brand_update`**: Apenas se `can_edit_client("organizationId", "clientId")` e o cliente correspondente estiver ativo.
3. **Privilégios Mínimos e Proteção de Escopo**:
   - Concedido à role `socialflow_runtime`: `SELECT, INSERT` e `UPDATE (name, description, "targetAudience", "toneOfVoice", "updatedAt")`.
   - `organizationId`, `clientId` e `id` **não** possuem concessão de UPDATE no PostgreSQL.
   - Trigger `protect_brand_scope` adicionada para barrar com código de erro `42501` qualquer tentativa de alteração de escopo.
   - Nenhum privilégio de `DELETE` físico concedido à role runtime.
4. **Revisão das Políticas de Auditoria (`AuditLog`)**:
   - Na fundação, `audit_read` e `audit_create` assumiam que `entityId` era sempre um `clientId`.
   - As políticas foram substituídas por versões aprimoradas que verificam se `entityId` é um cliente ou se pertence a uma marca vinculada a um cliente com acesso ativo.
   - Preservada 100% da segurança dos logs de auditoria de clientes e o bloqueio imediato do histórico após revogação de vínculos com a sessão aberta.

---

## 4. Matriz de Permissões por Perfil

| Perfil                    | Escopo            | Listar / Visualizar Marcas  | Criar Marcas     | Editar Marcas    | Alterar Escopo        | Leitura de Auditoria                |
| ------------------------- | ----------------- | --------------------------- | ---------------- | ---------------- | --------------------- | ----------------------------------- |
| **OWNER**                 | Organização       | Qualquer cliente da org     | Permitido (201)  | Permitido (200)  | Bloqueado (400/42501) | Todos os logs da org                |
| **ADMIN**                 | Organização       | Qualquer cliente da org     | Permitido (201)  | Permitido (200)  | Bloqueado (400/42501) | Todos os logs da org                |
| **EDITOR**                | Cliente vinculado | Apenas do cliente vinculado | Permitido (201)  | Permitido (200)  | Bloqueado (400/42501) | Apenas próprios e com vínculo ativo |
| **APPROVER**              | Cliente vinculado | Apenas do cliente vinculado | Negado (403)     | Negado (403)     | Negado (403)          | Apenas próprios e com vínculo ativo |
| **CLIENT_VIEWER**         | Cliente vinculado | Apenas do cliente vinculado | Negado (403)     | Negado (403)     | Negado (403)          | Apenas próprios e com vínculo ativo |
| **Sem vínculo / Inativo** | Nenhum            | Negado (404/401)            | Negado (404/401) | Negado (404/401) | Negado (404/401)      | Negado (0 linhas)                   |

---

## 5. Correções da Revisão Independente (R-1 e R-2)

Após a revisão independente registrada em `docs/discovery/PHASE2-BRANDS-REVIEW.md`, foram aplicadas as seguintes melhorias:

### 5.1. R-1 — Teste HTTP de Isolamento e IDOR Cross-Client na Mesma Organização

- **Cenário Implementado (`tests/integration/brands.test.ts`)**:
  - Criados dois clientes ativos (`client-a1` e `client-a2`) na mesma organização (`org-a`), cada um com sua respectiva marca inicial.
  - Usuário com papel `EDITOR` autorizado estritamente no cliente `client-a1`.
  - Requisição HTTP `GET /api/organizations/org-a/clients/client-a1/brands/<brand-a2-id>` (URL com clientId autorizado de A1, mas brandId de A2).
  - Requisição HTTP `PATCH /api/organizations/org-a/clients/client-a1/brands/<brand-a2-id>` com payload válido de edição.
- **Validações Confirmadas**:
  - Requisições `GET` e `PATCH` negadas com `404 Not Found` ("Marca não encontrada.").
  - Nenhum conteúdo textual ou metadados da marca de A2 foram expostos.
  - Nenhuma alteração foi realizada no banco de dados na marca de A2 (dados e `updatedAt` inalterados).
  - Nenhum registro de auditoria (`AuditLog`) foi gerado pela tentativa negada.
  - **Caso Positivo de Controle**: O mesmo usuário consulta (`GET` 200) e edita (`PATCH` 200) com sucesso a marca autorizada pertencente ao cliente `client-a1`, gerando o respectivo log de auditoria com sucesso.

### 5.2. R-2 — Ajuste de Layout Mobile e Tratamento de Textos Longos

- **Ajuste em `apps/web/app/styles.css`**:
  - A classe `.brand-grid` (Público-alvo e Tom de voz) foi ajustada para colapsar para 1 coluna (`grid-template-columns: 1fr`) no breakpoint móvel (`@media (max-width: 720px)`), preservando a disposição de 2 colunas (`grid-template-columns: 1fr 1fr`) em viewports desktop (>720px).
  - Adicionado `overflow-wrap: anywhere` nas classes `.brand-header h3`, `.brand-description` e `.brand-item p`, garantindo que conteúdos extensos de até 1000/2000 caracteres (ou palavras longas contínuas) quebrem linhas adequadamente, sem sobreposição, corte indevido ou rolagem horizontal da página (`scrollWidth <= innerWidth`).
- **Validação E2E e Evidências Visuais (`tests/e2e/brands.spec.ts`)**:
  - O teste E2E foi atualizado para preencher descrições, público-alvo e tom de voz com textos longos (1000 caracteres).
  - Asserções automáticas confirmam via Playwright que em viewport móvel (390px) o grid possui 1 coluna computada (`grid-template-columns: 1fr`) e em desktop possui 2 colunas.
  - Asserção `scrollWidth <= innerWidth` aprovada em ambos os viewports.
  - Evidências visuais salvas em:
    - `test-results/brands-desktop.png` (Desktop 1280x720)
    - `test-results/brands-mobile.png` (Mobile iPhone 13 390x844)

---

## 6. Sugestões Adiadas (Melhorias Futuras)

Conforme orientação do escopo e diretrizes arquiteturais, as seguintes sugestões da revisão foram **postergadas como melhorias opcionais futuras**, sem alterar os contratos atuais:

1. **O-1: Coluna discriminadora `entityType` em `AuditLog`**:
   - _Decisão_: Não acrescentar `entityType` ao modelo `AuditLog` neste incremento.
   - _Justificativa_: A separação via RLS (`can_read_client` para clientes e `EXISTS` em `Brand` para marcas) é plenamente eficaz, imune a colisões por uso de UUIDs v4 e testada contra regressões. A introdução de `entityType` deve ser avaliada de forma centralizada em um incremento futuro quando novos tipos de entidade auditáveis forem introduzidos na aplicação.
2. **O-4: Atualização Parcial em `brandUpdate`**:
   - _Decisão_: Manter `brandUpdate = brandInput` (substituição completa dos campos textuais).
   - _Justificativa_: A interface web atual sempre envia o formulário preenchido por completo. Manter a validação estrita completa evita o risco de deleções acidentais e mantém consistência com o padrão estabelecido na fundação. A evolução para `.partial()` poderá ser feita quando clientes externos ou integrações exigirem mutações atômicas de campo único.

---

## 7. Arquivos Alterados e Novos

| Arquivo                                                           | Ação       | Descrição                                                                                                 |
| ----------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                                | Modificado | Adicionado modelo `Brand` e relação `brands` em `Client` e `Organization`.                                |
| `packages/db/prisma/migrations/202609140001_brands/migration.sql` | Novo       | Migration SQL com criação de tabela, FKs compostas, RLS/FORCE RLS, trigger e revisão de auditoria.        |
| `packages/contracts/src/index.ts`                                 | Modificado | Schemas Zod `brandInput` e `brandUpdate` (estritos) e tipo `Brand`.                                       |
| `apps/api/src/app.ts`                                             | Modificado | 4 novos endpoints REST para marcas e auditoria na mesma transação.                                        |
| `apps/web/app/page.tsx`                                           | Modificado | Interface para abrir clientes, listar, criar e editar marcas com validação e preservação de dados.        |
| `apps/web/app/styles.css`                                         | Modificado | Estilos responsivos com colapso de `.brand-grid` no mobile e `overflow-wrap: anywhere`.                   |
| `scripts/verify-operations.ts`                                    | Modificado | Inclusão de `Brand` no fingerprint, RLS check (5 tabelas) e migration count (4).                          |
| `tests/integration/brands.test.ts`                                | Novo       | 13 testes de integração cobrindo RLS, isolamento, permissões, escopo, auditoria e teste IDOR R-1.         |
| `tests/e2e/brands.spec.ts`                                        | Novo       | 4 testes Playwright cobrindo criação, edição, validação de grid desktop/mobile e somente leitura.         |
| `docs/discovery/API-MATRIX.md`                                    | Modificado | Adicionada a matriz de endpoints, permissões, isolamento, imutabilidade, revogação e auditoria de marcas. |
| `docs/discovery/THREAT-MODEL.md`                                  | Modificado | Mapeadas ameaças para IDOR de marcas, transferência de escopo, perfis de leitura e revogação.             |
| `docs/discovery/PHASE2-BRANDS-IMPLEMENTATION.md`                  | Modificado | Atualizado com correções R-1/R-2, arquivos, testes, evidências e sugestões adiadas.                       |

---

## 8. Resultados dos Testes Locais

Todos os testes foram executados com sucesso no ambiente local de desenvolvimento e testes:

### 8.1. Formatação e Análise Estática

- **Prettier (`pnpm format:check`)**: 100% em conformidade com o estilo do código em toda a árvore (incluindo documentação Markdown).
- **ESLint (`pnpm lint`)**: 0 erros e 0 warnings.
- **TypeScript (`pnpm typecheck`)**: 6 de 6 pacotes e tools do monorepo checados sem erros.

### 8.2. Testes Unitários

- **`pnpm test` (Vitest)**: 15/15 testes passando (100% de sucesso).

### 8.3. Testes de Integração com PostgreSQL Real (`pnpm test:integration`)

- **`tests/integration/brands.test.ts`**: 13/13 cenários aprovados.
  - Invariantes de role não-privilegiada `socialflow_runtime` e RLS/FORCE RLS ativos na tabela `Brand`.
  - Isolamento cross-organization (Org A não lê, insere nem atualiza marcas da Org B).
  - Isolamento cross-client na mesma org (Editor de Cliente A1 não acessa marcas de Cliente A2).
  - **Cenário R-1**: Prevenção de IDOR HTTP combinando clientId autorizado de A1 com brandId pertencente a A2 (404 em GET/PATCH, sem vazamento, sem mutação, sem auditoria; caso positivo aprovado para marca de A1).
  - Bloqueio estrito de reatribuição de `organizationId` e `clientId` (garantia de imutabilidade de escopo).
  - Rejeição de `DELETE` físico direto pela role runtime.
  - Auditoria transacional de marcas e bloqueio imediato pós-revogação de vínculo.
  - Regressão de auditoria de clientes preservada.
  - Matriz de perfis: OWNER, ADMIN, EDITOR, APPROVER e CLIENT_VIEWER testados com chamadas HTTP autenticadas.
  - Revogação imediata com a mesma sessão aberta (cookies ativos cortados instantaneamente).
  - Validação estrita de inputs e rejeição de campos adicionais.
- **`tests/integration/foundation.test.ts`**: 15/15 cenários da fundação continuam passando sem qualquer regressão.
- **Total de testes de integração**: 28/28 aprovados.

### 8.4. Testes Ponta a Ponta E2E (`pnpm test:e2e`)

- **`tests/e2e/brands.spec.ts`**: 4 testes aprovados (Desktop e Mobile emulado).
  - Admin faz login, abre cliente, cria marca com todos os campos textuais preenchidos e edita tom de voz e descrição com textos longos (1000 caracteres).
  - Asserções de layout: verificação de 1 coluna em viewport móvel (iPhone 13) e 2 colunas em desktop; validação de ausência de overflow horizontal (`scrollWidth <= innerWidth`).
  - Viewer acessa o cliente em modo somente leitura (sem botões de criação ou edição).
  - Capturas de tela geradas em `test-results/brands-desktop.png` e `test-results/brands-mobile.png`.
- **`tests/e2e/clients.spec.ts`**: 8 testes da fundação continuam passando sem regressão.
- **Total de testes E2E**: 12/12 aprovados.

---

## 9. Declaração de Entrega para QA

O incremento referente ao **Cadastro Textual de Marcas por Cliente (Fase 2, Incremento 1)** encontra-se **PRONTO PARA O AGENTE DE QA**.

- Todas as recomendações e riscos identificados na revisão independente (`R-1` e `R-2`) foram devidamente implementados, cobertos por testes automatizados e validados visualmente.
- O relatório original da revisão independente foi preservado integralmente em `docs/discovery/PHASE2-BRANDS-REVIEW.md`.
- Conforme as restrições operacionais, esta validação foi executada estritamente em ambiente de teste local isolado (Docker / PostgreSQL real via role runtime). Nenhuma alteração foi realizada na VPS, volumes de homologação ou dados de produção, e esta declaração não se confunde com aceite final de homologação.
