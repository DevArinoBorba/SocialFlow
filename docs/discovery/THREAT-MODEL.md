# Modelo inicial de ameaças

Data: 11/09/2026. Modelo proposto; nenhum controle abaixo já está implementado.

Ativos: credenciais da equipe, vínculos e permissões, tokens sociais, mídias de clientes, aprovações, intenções de publicação e backups. Fronteiras: navegador/API, API/PostgreSQL, API/fila/worker, storage/provedor, operador/Coolify. Browser e payload de job não são autoridades sobre autorização.

| Ameaça concreta | Controle previsto | Evidência obrigatória |
| --- | --- | --- |
| Editor A troca ID da URL para ler/alterar cliente B | Contexto autenticado, membership ativo, consultas scoped e RLS | List/detail/create/update/delete, paginação e contagens sem dados de B; acesso SQL com role runtime também negado |
| ADMIN de organização A atua em organização B | Acesso global limitado à organização do vínculo | Admin A negado em B; admin autorizado acessa clientes da própria organização |
| Cliente muda role ou clientId no corpo | Campos de autorização fora do DTO; concessões em rota específica privilegiada | Mass assignment não promove usuário nem transfere entidade |
| Membership aponta para client de outra organização | FK composta e constraints de papel/escopo | Insert e update inválidos falham no banco real |
| Reuso de conexão preserva tenant anterior | Contexto transacional e falha fechada sem contexto | Alternância A/B com pool pequeno e requisições concorrentes |
| Sessão roubada, fixação ou CSRF | Biblioteca de auth, rotação/revogação, cookies HttpOnly/Secure em produção, proteção CSRF/origin e rate limit | Logout revoga sessão; sessão expirada negada; mutation de origem não permitida falha |
| Worker executa job após revogação/cancelamento | Recarregar intenção, vínculo e revisão válida antes do efeito | Revogar ou cancelar após enqueue impede envio |
| Timeout gera publicação duplicada | Intenção persistida, reconciliação e tentativas rastreáveis | Simular aceitação remota seguida de desconexão; não reenviar cegamente |
| OAuth callback vincula conta ao cliente errado | State de uso único associado a ator/tenant/fluxo | Replay, expiração, troca de tenant e callback não solicitado negados |
| Upload/URL de mídia alcança rede interna | Storage privado, validação de conteúdo/tamanho, controles SSRF e redirects, egress restrito | IP privado, metadata endpoint, redirecionamento e MIME falso bloqueados |
| Render consome toda a VPS | Worker separado, concorrência/tempo/memória limitados, templates declarativos | Job excessivo interrompido; API permanece saudável |
| Logs/backup expõem tokens ou dados de outro cliente | Redação, criptografia, escopo de acesso, retenção e restore controlado | Varredura de logs com credenciais fictícias; restore em ambiente isolado |
| Migração/segredo dev chega à produção | Role de migration distinta, sem seed automático, configuração que falha sem secrets | Compose sem secretos obrigatórios falha; runtime sem privilégios DDL |
| Editor acessa/altera marca de outro cliente via IDOR (mesma org ou cross-org) | Consulta transacional scoped `{ id, organizationId, clientId }` e RLS `brand_read`/`brand_update` com `can_read_client`/`can_edit_client` | HTTP 404 em GET/PATCH para marca alheia; zero dados vazados; zero mutação no banco; zero logs de auditoria; testes `brands.test.ts` (R-1 e RLS) |
| Ator tenta transferir marca para outro cliente ou organização | Schema Zod `strictObject`, campos fora do `data` do Prisma, ausência de privilégio SQL de UPDATE na role runtime e trigger `protect_brand_scope` | Tentativa via API dá 400; tentativa direta via SQL falha com `ERRCODE 42501`; testes em `brands.test.ts` |
| Papéis de leitura (APPROVER / CLIENT_VIEWER) tentam mutar marca | RBAC na camada de API (`createBrand`/`updateBrand` exigem `admin` ou `EDITOR`) + RLS `brand_create`/`brand_update` via `can_edit_client` | Chamadas POST/PATCH retornam HTTP 403; RLS barra inserção/atualização no banco se bypassar API; testes em `brands.test.ts` |
| Usuário com sessão ativa após revogação acessa marcas ou auditoria | Resolução de membership transacional em `scoped()` e políticas RLS de `AuditLog` com `can_read_client(org, clientId)` | Sessão aberta recebe 404 imediato nas rotas de marca e consulta de auditoria retorna zero linhas; testes em `brands.test.ts` |

RLS é defesa adicional, não substituto de auth/RBAC. O runtime não pode conectar como superuser, dono com bypass efetivo ou role BYPASSRLS; referência: [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). Políticas precisam tratar leitura e escrita e não permitir recursão acidental ao consultar memberships.

Fase 1 cobriu as seis primeiras linhas e separação de papéis do banco. A Fase 2 (Incremento 1) implementou os controles de marca (IDOR, escopo imutável, permissões, auditoria transacional e revogação imediata). As demais continuam como gates das respectivas fases.
