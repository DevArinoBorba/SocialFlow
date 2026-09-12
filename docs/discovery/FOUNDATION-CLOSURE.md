# Fechamento da fundação — 12/09/2026

Escopo exclusivo da Fase 1. Base inspecionada: branch `master`, commit
`38b3b72`, árvore limpa no início. Git permanece sob administração manual do
usuário. Nenhum commit, push, merge, deploy ou acesso a contas sociais.

## Pesquisa e decisão (ADR-010)

Pesquisa realizada antes dos componentes relevantes, sem adicionar dependências.

| Solução/fonte                                                                                                                                                                                   | Licença e manutenção observada em 12/09/2026                                               | Risco e decisão                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Better Auth](https://github.com/better-auth/better-auth), [releases](https://github.com/better-auth/better-auth/releases), [senha](https://better-auth.com/docs/authentication/email-password) | MIT; release 1.7.4 publicada em 10/09/2026                                                 | Reutilizar hashing oficial já instalado; testar login com o handler real. Cadastro público permanece fechado. Ferramenta offline mínima evita introduzir plugin de administração e novas rotas. Compatibilidade do formato de Account deve acompanhar upgrades.               |
| [PostgreSQL](https://github.com/postgres/postgres), [pg_restore 17](https://www.postgresql.org/docs/17/app-pgrestore.html), [RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)      | PostgreSQL License; documentação anuncia 17.11 em 13/08/2026                               | Reutilizar pg_dump/pg_restore da mesma imagem 17.11. Restore transacional, ACLs preservadas, sem --clean/--create. Não inventar copiador SQL. Dumps exigem proteção equivalente ao banco e só podem vir de origem confiável.                                                  |
| [Supabase agent-skills](https://github.com/supabase/agent-skills), [licença](https://github.com/supabase/agent-skills/blob/main/LICENSE), [catálogo](https://skills.sh/)                        | MIT; repositório público acessível; data exata do último commit não confirmada na consulta | Candidato de boas práticas Postgres. Não instalar nem executar: o conteúdo específico não foi recuperado de forma confiável e o projeto não usa Supabase. Aplicar documentação primária de PostgreSQL. Skill local find-skills consultada; nenhuma skill externa incorporada. |
| Prisma migrate deploy existente                                                                                                                                                                 | Apache-2.0; versão 7.10.0 mantida no lockfile, sem atualização nesta rodada                | A página oficial de workflows retornou erro na ferramenta de pesquisa. Usar CLI instalada e migrations versionadas; comprovar aplicação em banco vazio e repetição. Não editar migrations anteriores.                                                                         |

## Comportamentos corrigidos

- AuditLog permitia leitura ao autor mesmo após revogação do vínculo. A terceira
  migration exige autorização atual; há regressão com a role real de runtime.
- API/worker verificam a role conectada, flags privilegiadas, ownership e herança
  de roles antes de iniciar. Configuração de produção recusa credenciais de
  migration, seed habilitado, Redis sem senha e secrets reutilizados/fracos.
- Bootstrap explícito cria somente uma organização, identidade, conta de senha,
  vínculo OWNER e evento de auditoria. Usa transação e advisory lock; recusa banco
  já provisionado, inclusive concorrência, sem redefinir senhas. CLI não imprime
  entradas nem erros do adapter; aceita arquivo de senha do operador.
- Ensaio operacional utiliza nome Compose aleatório, portas livres, credenciais
  próprias e volumes novos. Nunca executa down -v, reset ou restore no banco em uso.
- CI usa o mesmo ensaio: migration vazia/repetida, seed idempotente, bootstrap,
  integração, E2E, dump e restore. Scripts/testes TypeScript entraram no typecheck.
  Arquivos shell têm LF explícito para checkout Windows. Traces com credenciais
  deixam de ser produzidos e não entram nos artifacts.

## Evidências

O relatório anterior com 10/12/4 testes é histórico. Esta versão passou pelo
ensaio completo em 12/09/2026 às 14:26:26 UTC (10:26:26 em Cuiabá).

Ensaio final: `socialflow-acceptance-1789223008118-bc446e`, duração total
178,549 segundos; etapa de dump/restore e verificações: 2,680 segundos, em
volume de dados pequeno de teste. Não representa RTO de produção. Evidência
local sanitizada: `.local/socialflow-acceptance-1789223008118-bc446e/result.json`.

| Etapa do ensaio final                  | Resultado                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose em volumes novos               | web/API/worker/PostgreSQL/Redis saudáveis; migration encerrada com sucesso                                                                                          |
| Migration em banco vazio e reaplicação | 3 migrations aplicadas; repetição sem pendências; nenhuma identidade/org automática                                                                                 |
| Seed                                   | Produção recusada; duas execuções de desenvolvimento preservaram edição existente e todos os dados/hashes, mesmo com senha de entrada diferente                     |
| Bootstrap em outro banco               | Duas CLIs concorrentes em NODE_ENV=production, senha por arquivo: somente uma concluiu; login real passou; repetição não alterou dados                              |
| `pnpm test:integration`                | 15/15: runtime real, RLS/IDOR, leitura/escrita, relações, revogação de sessão/vínculo/auditoria e job aguardando execução                                           |
| `pnpm test:e2e`                        | 8/8 no Chrome instalado, desktop e mobile emulado                                                                                                                   |
| Backup/restore                         | pg_dump custom; restore transacional em restore_check novo; fingerprints de todas as tabelas/migrations iguais; login, RLS/FORCE RLS e escrita proibida confirmados |

O primeiro ensaio também passou (14 integrações, 8 E2E); foi repetido após
acrescentar a cobertura de revogação do job e da CLI por arquivo. Containers
dos ensaios foram removidos por `down`, sem `-v`. Volumes antigos e novos foram
preservados. Os serviços `socialflow-test` anteriores continuaram ativos nas
mesmas portas; a instalação em localhost:3000 não foi atualizada nesta rodada.

Smoke adicional do serviço `compose.bootstrap.yaml` executado em outro projeto
novo (`socialflow-acceptance-1789223008118-bc446e-bootstrap-smoke`), com a imagem
final já construída e secret montado de arquivo. `compose run --rm bootstrap`
criou a organização/OWNER; a segunda execução retornou 1, como esperado. Uma
asserção SQL confirmou exatamente um usuário, uma organização, um OWNER de
escopo organizacional e zero clientes. Containers encerrados, volume preservado.
Evidência: `.local/socialflow-acceptance-1789223008118-bc446e/bootstrap-docker-result.json`.

Preparação e checks locais já concluídos:

| Comando/verificação                    | Resultado                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Docker `version` fora do sandbox       | Client e Server 29.7.2, daemon Linux acessível                                         |
| `pnpm install --frozen-lockfile`       | Passou, lockfile preservado                                                            |
| `pnpm db:generate`                     | Passou                                                                                 |
| `pnpm lint`, `pnpm format:check`       | Passaram                                                                               |
| `pnpm typecheck`                       | Passou, incluindo scripts e testes                                                     |
| `pnpm test`                            | 15/15 unitários                                                                        |
| `pnpm build`                           | Passou localmente e no Docker; imagem instalou sem node_modules/dist/generated do host |
| `pnpm audit --prod --audit-level high` | Passou: 0 high/critical, 1 low                                                         |
| `git diff --check`                     | Passou; avisos de conversão LF/CRLF não são falhas                                     |

O comando usado no Windows foi `npx.cmd --yes pnpm@11.19.0`, com
`DOCKER_BIN` apontando ao Docker Desktop e `PLAYWRIGHT_CHANNEL=chrome` no ensaio.
E2E valida Chrome local e viewport mobile emulado, não Safari/iOS nem o download
do Chromium na CI. Nenhuma pipeline remota foi executada.

Falhas intermediárias: a primeira chamada npm dentro do sandbox falhou EACCES;
a repetição autorizada fora dele funcionou. O caminho Docker histórico também
só ficou acessível fora do sandbox. Ao incluir scripts no typecheck, surgiu uma
incompatibilidade de tipos entre Prisma importado de src e de dist; corrigida
usando o export do pacote no verificador operacional. Não houve falha de dados
no primeiro ensaio. `audit --prod --json` retorna código 1 pelo advisory low
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr),
esbuild 0.27.7; o gate high continua verde. O servidor de desenvolvimento do
esbuild no Windows não faz parte do runtime Linux de produção.

## Arquivos alterados/criados

- Banco e segurança: `packages/db/src/index.ts`, `packages/db/src/bootstrap.ts`,
  `packages/db/src/bootstrap-cli.ts`, `packages/db/package.json`,
  `packages/db/prisma/migrations/202609120001_audit_revocation/migration.sql`,
  `packages/config/src/index.ts`, `apps/api/src/app.ts`, `apps/worker/src/main.ts`,
  `infra/postgres/init.sh`.
- Operação e CI: `compose.bootstrap.yaml`, `compose.test.yaml`,
  `.github/workflows/ci.yml`, `scripts/foundation-drill.mjs`,
  `scripts/verify-operations.ts`, `scripts/run-tests.mjs`, `package.json`,
  `tsconfig.tools.json`, `playwright.config.ts`, `.gitattributes`, `.gitignore`,
  `.dockerignore`.
- Testes: `tests/unit/config.test.ts`, `tests/integration/foundation.test.ts`.
- Documentação: `README.md`, `docs/ADR.md`, `docs/SETUP.md`, `docs/OPERATIONS.md`,
  `docs/discovery/FOUNDATION-IMPLEMENTATION.md` e este relatório.
- Alteração externa observada e preservada durante a rodada:
  `tests/e2e/clients.spec.ts` ganhou cenários de login inválido e organização
  vazia. Não foi implementada por este agente, mas entrou nas verificações.

Não há alteração de dependências/lockfile, migrations anteriores ou frontend
nesta implementação. A topologia continua Docker/Coolify centralizado.

## Pendências para clientes reais

- Execução remota do workflow pelo usuário e revisão do código pelo Claude.
- Homologação Coolify/VPS, domínio/TLS, secrets e bootstrap com dados reais.
- Destino externo de backup criptografado, agendamento, retenção, alertas e
  custódia/teste da chave. Ensaio local não comprova recuperação de desastre da VPS.
- Definir responsáveis por provisionamento/revogação e validar procedimento
  administrativo; não há UI de equipe nem recuperação de senha por e-mail.
- Ingress confiável e rate limit individual antes de ampliar a equipe; o limite
  atual de login é compartilhado pelo proxy web. Não habilitar forwarded headers
  arbitrários para contornar a limitação.
- Revisar advisory low remanescente de esbuild nas ferramentas de desenvolvimento.

## Primeiro incremento proposto da Fase 2 (não implementado)

Cadastro de marca textual por cliente: nome, descrição curta e estado ativo.
Sem mídia, templates, importação, Meta, TikTok, analytics ou vídeo.

Aceite: OWNER/ADMIN criam/arquivam na própria organização; EDITOR altera apenas
marca do cliente vinculado; APPROVER/CLIENT_VIEWER leem apenas seu escopo;
operações são auditadas e validadas no servidor; FK composta e RLS impedem
relações entre organizações; revogação bloqueia acesso na próxima requisição;
E2E cobre criação/edição e testes reais cobrem IDOR e escrita proibida.

## Roteiro para revisão pelo Claude

Ler este relatório e `git diff`, revisar a nova política audit_read e as garantias
do bootstrap, conferir separação de secrets no Compose, executar os comandos de
SETUP e inspecionar result.json. Revisar o diff sem commit automático. O bootstrap
não é ferramenta de convite, reset de senha ou concessão posterior de papéis.
