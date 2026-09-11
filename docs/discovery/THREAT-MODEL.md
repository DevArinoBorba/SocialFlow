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

RLS é defesa adicional, não substituto de auth/RBAC. O runtime não pode conectar como superuser, dono com bypass efetivo ou role BYPASSRLS; referência: [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html). Políticas precisam tratar leitura e escrita e não permitir recursão acidental ao consultar memberships.

Fase 1 deve cobrir as seis primeiras linhas e separação de papéis do banco. As demais são gates das respectivas fases, não justificativa para adicionar todos os serviços agora. O portal somente leitura requer também negar exportações ou agregações que revelem dados alheios.
