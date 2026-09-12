# Fase 1 — registro de implementação

Atualização: o fechamento de 12/09/2026, correções e evidências atuais estão em
[FOUNDATION-CLOSURE.md](FOUNDATION-CLOSURE.md). Os resultados abaixo permanecem
como histórico da rodada anterior.

Iniciada em 11/09/2026, seguindo PR-01 a PR-06. O Master Pack foi preservado. O remoto informado, https://github.com/DevArinoBorba/SocialFlow, não retornou refs na consulta inicial. Nenhum deploy externo autorizado ou realizado.

## ADR-007 — dependências e reutilização

Decisão: manter Next.js/React, NestJS sobre Express, PostgreSQL/Prisma e BullMQ. Better Auth administra hashing, login, cookies e revogação; autorização de negócio permanece na API e em RLS. Passport foi comparado: é maduro e integrado ao Nest, mas exigiria montar e manter mais partes de senha/sessão. Não adicionar o wrapper comunitário Nest de Better Auth: usar o handler Node oficial antes do body parser do Nest.

Versões candidatas consultadas diretamente no registro npm antes da instalação: Node 24.19.0 (LTS local), pnpm 11.19.0, Next 16.3.4, React 19.3.0, Nest 12.0.1, Prisma 7.10.0 (estável; rejeitada tag latest 8 RC), Better Auth 1.7.4, BullMQ 6.3.4, Zod 4.6.2. TypeScript 6.0.3 respeita peer <6.1 do typescript-eslint 8.70.0; não adotar TS7 automaticamente. Lockfile e testes são a evidência final de compatibilidade.

Licenças: Prisma Apache-2.0; Next/React/Nest/Better Auth/BullMQ/Zod/pnpm MIT; PostgreSQL PostgreSQL License. Redis 8 é oferecido também sob AGPLv3: escolher essa opção para o serviço sem modificações, isolado, mantendo avisos; não presumir BSD para Redis moderno. Avaliar atualizações das imagens e advisories antes de produção.

Atividade npm observada: Better Auth 10/09/2026, Next 10/09/2026, Prisma 10/09/2026, Nest 27/08/2026, BullMQ e Zod 10/09/2026. Datas de modificação do pacote não equivalem à última correção de segurança. Better Auth publicou correções em junho e mudança de Account em setembro; validar o contrato exato instalado e executar audit antes do aceite.

Fontes: [Better Auth segurança](https://better-auth.com/docs/reference/security), [advisories](https://github.com/better-auth/better-auth/security/advisories), [adapter Prisma](https://better-auth.com/docs/adapters/prisma), [handler Express](https://better-auth.com/docs/integrations/express), [Passport/Nest](https://docs.nestjs.com/security/authentication), [Prisma releases](https://github.com/prisma/orm/releases), [BullMQ conexões](https://docs.bullmq.io/guide/connections), [Redis licenças](https://redis.io/legal/licenses/), [RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [Coolify healthchecks](https://coolify.io/docs/applications/configuration/health-checks).

Skills: find-skills e impeccable locais lidas; skill oficial [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md) avaliada via fonte oficial e skills.sh. Reutilizar recomendações de payload pequeno, evitar waterfalls e dependências visuais desnecessárias. Nenhuma skill externa instalada. A UI desta fase é operacional: login, sessão e clientes reais; sem calendário e integrações simuladas.

## ADR-008 — fronteiras de identidade e dados

Runtime não é dono, superuser nem BYPASSRLS. Migration/seed usam credencial separada, nunca injetada em web/api/worker. As tabelas de identidade são acessadas internamente pelo Better Auth; não há rota pública de enumeração. Organization, Client, Membership e AuditLog usam RLS. Contexto é userId autenticado dentro de transação, não um tenant alegado pelo browser. Membership tem FK composta, unique parcial para clientId nulo e CHECK de papel/escopo. OWNER/ADMIN limitam-se à organização; EDITOR pode renomear seu cliente; APPROVER e VIEWER só leem nesta fase, pois aprovação de conteúdo pertence à Fase 2.

Risco residual: RLS protege queries esquecidas, não execução arbitrária com a credencial runtime. Essa credencial pertence ao backend confiável; SQL injection continua proibida. Sessões não usam cookie cache, para revogação/desativação imediata. Migrations destrutivas exigem migration corretiva ou restore; não se promete reversão de dados apagados.

## Retomada e validação local — 11/09/2026

Corrigida a formatação de `scripts/run-tests.mjs`, que bloqueava a CI.
Adicionados overrides de segurança e lockfile atualizado conforme ADR-009.
Playwright aceita `PLAYWRIGHT_CHANNEL=chrome` para usar o Chrome instalado;
o padrão da CI continua sendo Chromium gerenciado pelo Playwright.
README, roadmap e planejamento agora apontam para o estado implementado.

Comandos executados com `npx.cmd --yes pnpm@11.19.0` no Windows:

| Verificação                                       | Resultado                                                    |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `lint`, `typecheck`, `format:check`               | Passaram                                                     |
| `test`                                            | 10/10 unitários                                              |
| `build`                                           | Passou localmente; repetido no Docker com lockfile corrigido |
| `db:generate`                                     | Passou com DeepmergeTS 8                                     |
| `exec node scripts/run-tests.mjs migrate`         | Duas migrations registradas; nenhuma pendente                |
| `exec node scripts/run-tests.mjs seed` duas vezes | Ambas concluídas                                             |
| `test:integration`                                | 12/12, repetidos contra os containers reconstruídos          |
| `test:e2e` com `PLAYWRIGHT_CHANNEL=chrome`        | 4/4, desktop e mobile emulado                                |
| `audit --prod --audit-level high`                 | Passou; 1 low remanescente, ver ADR-009                      |

`docker compose --env-file .local/test.env -f compose.yaml -f compose.test.yaml -p socialflow-test up --build --wait --wait-timeout 180`
concluiu com web/API/worker/PostgreSQL/Redis saudáveis e migration encerrada
com sucesso. O build instalou dependências com `--frozen-lockfile`.
Os volumes existentes foram preservados: esta retomada não demonstra migration
em banco vazio nem restore de backup.

O download padrão de Chromium e a tentativa headless com timeout ampliado
falharam por timeout do CDN. A primeira execução E2E falhou por executável
ausente; a execução posterior com Chrome instalado passou. Capturas em
`test-results/clients-desktop.png` e `test-results/clients-mobile.png`.

Memória após testes, observada por `docker stats --no-stream`: web 158,1 MiB,
API 270,9 MiB, worker 184 MiB, PostgreSQL 46,41 MiB e Redis 18,11 MiB.
Total aproximado 678 MiB, excluindo daemon, build e sistema operacional;
não representa dimensionamento de produção ou teste de carga.

Estado: fundação funcional validada localmente em http://localhost:3000.
Ainda NO-GO para clientes reais: CI remota não executada nesta retomada,
deploy Coolify e restore não homologados, bootstrap de produção pendente.
Próxima entrega recomendada: PR de aceite da fundação, validação em ambiente
limpo na CI e homologação operacional antes de avançar para conteúdo/mídia.
