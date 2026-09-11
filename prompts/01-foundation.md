# Prompt --- Fase 1 / Implementador principal

Implemente somente a Fase 1 do ROADMAP.

Requisitos: - monorepo pnpm; - TypeScript strict; - apps
web/api/worker; - PostgreSQL + Prisma; - Redis + BullMQ; -
autenticação; - Organization/Client/User/Membership; - RBAC inicial; -
isolamento multi-tenant server-side; - healthchecks; - Dockerfiles +
compose local; - `.env.example`; - CI GitHub: install, lint, typecheck,
test, build; - seed de desenvolvimento; - documentação de setup.

Antes de instalar bibliotecas, pesquise alternativas existentes e
registre decisões importantes. Não implemente Meta/TikTok ainda.

Critérios: `docker compose up` funcional; migrations e seed funcionais;
testes provam que tenant A não lê/escreve tenant B; nenhuma chave real;
CI verde.

Ao final entregue: resumo, árvore alterada, comandos executados,
testes/resultados, riscos e próximo PR recomendado.
