# Regras para TODOS os agentes

1.  Leia README, PRODUCT, ARCHITECTURE, ROADMAP, TESTING e ADR antes de
    alterar arquitetura.
2.  Antes de construir algo relevante, pesquise GitHub, documentação
    oficial e skills disponíveis.
3.  Prefira SDK/API oficial para publicação social.
4.  Não use scraping/browser automation para substituir API oficial.
5.  Não invente endpoints, scopes, limites ou requisitos de review.
6.  Nunca exponha secrets. `.env.example` só contém placeholders.
7.  Toda query multi-tenant deve ser tenant-scoped no servidor.
8.  Toda publicação deve ser idempotente.
9.  Migrations devem ser reversíveis quando razoável e revisadas.
10. Toda feature inclui testes, logs úteis e documentação.
11. Não faça refatorações grandes fora do escopo da tarefa.
12. Ao terminar: execute lint, typecheck, unit, integration e build;
    relate comandos e resultados.
13. Se encontrar open source útil, registre URL, licença, última
    atividade, riscos e decisão no ADR.
14. Commits pequenos e semânticos.
