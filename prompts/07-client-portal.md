# Prompt --- Portal do cliente

Implemente CLIENT_VIEWER somente leitura. O cliente acessa
exclusivamente tenants explicitamente autorizados e visualiza:
calendário, status de posts, previews e métricas disponíveis.

Proibido: editar/agendar/publicar, visualizar credenciais, usuários
internos, outros clientes ou detalhes operacionais sensíveis.

Crie testes E2E e de autorização tentando enumerar IDs de outros
tenants. Qualquer vazamento cross-tenant é bloqueador.
