# Estratégia de testes

-   Unit: regras de domínio, validações, adapters.
-   Integration: PostgreSQL/Redis reais via containers.
-   Contract: fixtures das APIs externas, sem depender da rede no CI.
-   E2E: login -\> cliente -\> importação -\> aprovação -\> agendamento.
-   Security: tenant isolation, RBAC, IDOR, CSRF/OAuth state, upload,
    secrets.
-   Reliability: retries, timeout, worker crash/restart, idempotência.
-   Load: lotes de 100/1.000 posts e renders com limites definidos.
-   Manual sandbox: contas próprias de teste Meta/TikTok.

Regra: qualquer bug de publicação gera teste de regressão antes do fix
ser considerado concluído.
