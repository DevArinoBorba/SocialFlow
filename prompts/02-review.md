# Prompt --- Revisor de arquitetura/segurança

Não implemente features novas. Revise o diff da Fase atual como
adversarial reviewer.

Procure: - falhas de tenant isolation/IDOR; - autenticação/autorização
incorreta; - secrets/logs sensíveis; - SQL/query sem tenant; -
SSRF/uploads; - OAuth inseguro; - race conditions; - duplicação de
posts; - timezone; - retries sem idempotência; - dependências
desnecessárias/licenças; - testes que passam sem realmente testar.

Classifique achados P0/P1/P2/P3. Para P0/P1, forneça reprodução e
correção mínima. Depois proponha testes de regressão. Não reescreva o
projeto.
