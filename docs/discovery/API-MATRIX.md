# Matriz de APIs oficiais — 11/09/2026

Levantamento de discovery, não especificação congelada. Nenhum app, escopo concedido, token ou conta foi verificado no painel dos provedores. Revalidar documentação e versão da API imediatamente antes da implementação.

## Meta

| Caminho | Evidência e escopo inicial | Pendente antes do conector |
| --- | --- | --- |
| Instagram com Facebook Login | Coleção oficial Meta: conta profissional e Page vinculada; listar Pages e obter identidade/token correspondente. Permissões de publicação a investigar: `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`. | Confirmar conjunto mínimo para endpoints selecionados, tarefas da Page, App Review/Advanced Access, exigência de Business Verification no caso concreto e versão Graph suportada. |
| Instagram com Instagram Login | Coleção oficial distingue este produto e permissões `instagram_business_basic` / `instagram_business_content_publish`. | Confirmar onboarding, renovação e requisitos específicos; não misturar tokens/scopes dos dois fluxos. Não implementar duas opções no primeiro incremento. |
| Facebook Pages | Página oficial de posts não pôde ser lida nesta sessão (HTTP 429). | Leitura oficial de criação de posts/fotos/Reels, scopes mínimos, Page token, review, renovação e limites. Nenhum endpoint ou lista de permissões é aprovado para implementação por este levantamento. |

Fonte consultada: [coleção oficial Instagram da Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-ab559ffb-8e2c-4b0a-b43a-5737b6d2f672). A coleção inclui permissões para funções adicionais: não solicitar mensagens/comentários sem necessidade. Documentação principal a revalidar: [Instagram Publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/) e [Pages Posts](https://developers.facebook.com/docs/pages-api/posts/). O acesso direto à primeira também falhou; a coleção é evidência complementar oficial, não aprovação do app.

A [coleção de exemplos Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) demonstra criação de container de Reel, consulta de processamento e publicação do container. Salvar o container antes da etapa seguinte; HTTP aceito não equivale a publicação confirmada. Limites de mídia, carrosséis, Stories, expiração de containers e quotas devem ser documentados por formato no PR Meta. Não fixar números de memória.

Proposta para MVP: avaliar primeiro Facebook Login para atender conjuntamente Page e Instagram profissional, condicionado à configuração da conta de teste. OAuth exige state vinculado à sessão, uso único, expiração, redirect validado e PKCE quando suportado pelo fluxo escolhido. Persistir scopes efetivos e expiração; token revogado exige reconexão. Não registrar tokens em query strings de logs mesmo quando exemplos de documentação os mostram.

## TikTok

[Getting started oficial](https://developers.tiktok.com/doc/content-posting-api-get-started): Direct Post suporta vídeo/foto, exige app e usuário autorizados para `video.publish`, consulta de creator info e tratamento assíncrono. Aprovação de escopo e auditoria são gates distintos do sucesso de uma chamada de teste.

[Diretrizes Direct Post](https://developers.tiktok.com/doc/content-sharing-guidelines): o uso restrito a contas administradas pela própria equipe é explicitamente incompatível com o uso pretendido. Apps sem auditoria têm publicação privada. A interface precisa respeitar opções atuais do criador, consentimento e seleção de privacidade; URLs de mídia no servidor exigem domínio/prefixo verificado conforme o método aplicável.

Consequência para SocialFlow: **NO-GO para prometer Direct Post público como utilitário interno no desenho atual**. Suporte técnico a fotos não resolve elegibilidade. Reutilizar Postiz self-hosted também não demonstra aprovação do nosso app.

Alternativas a avaliar separadamente: provedor com integração oficialmente aprovada e contrato compatível; fluxo de exportação com publicação manual; produto com experiência adequada a público amplo. Nenhuma foi selecionada, contratada ou implementada. Upload assistido não deve ser apresentado como atalho garantido para auditoria.

## Gates das integrações

1. Fonte oficial acessível e requisitos/versão registrados por formato e fluxo OAuth.
2. Conta própria e permissões demonstradas; revisão do provedor quando aplicável.
3. Tenant e conta social autorizados no backend, inclusive no worker.
4. Tokens criptografados e logs redigidos; revogação/expiração testadas.
5. Fixtures de respostas e erros; processamento pendente, rate limit e timeout testados.
6. Publicação controlada com ID remoto confirmado e tratamento de resultado incerto.

Fases 1/2 podem ser planejadas sem credenciais sociais. Fase 3 continua com verificação Meta pendente; Fase 5 depende da resolução de elegibilidade TikTok.

---

## SocialFlow — Endpoints Internos de Marcas (Fase 2, Incremento 1)

Matriz de contratos internos da aplicação implementados no primeiro incremento da Fase 2.

### Endpoints REST

| Método | Caminho | Descrição | Payloads / Respostas |
| --- | --- | --- | --- |
| `GET` | `/api/organizations/:org/clients/:client/brands` | Listar marcas ativas do cliente | Resposta: `200 OK` com `Brand[]` |
| `GET` | `/api/organizations/:org/clients/:client/brands/:id` | Obter detalhes textuais de uma marca | Resposta: `200 OK` com `Brand` ou `404 Not Found` |
| `POST` | `/api/organizations/:org/clients/:client/brands` | Criar nova marca vinculada ao cliente | Corpo: `brandInput` (Zod `strictObject`). Resposta: `201 Created` com `Brand` |
| `PATCH` | `/api/organizations/:org/clients/:client/brands/:id` | Atualizar campos textuais da marca | Corpo: `brandUpdate` (substituição completa dos campos textuais). Resposta: `200 OK` com `Brand` |

### Matriz de Permissões por Perfil

| Perfil | Escopo | Listar / Detalhe | Criar Marca | Atualizar Marca | Alterar Escopo | Leitura de Auditoria |
| --- | --- | --- | --- | --- | --- | --- |
| **OWNER** | Organização | Permitido (200) | Permitido (201) | Permitido (200) | Negado (400 / 42501) | Todos os logs da org |
| **ADMIN** | Organização | Permitido (200) | Permitido (201) | Permitido (200) | Negado (400 / 42501) | Todos os logs da org |
| **EDITOR** | Cliente vinculado | Permitido (200) | Permitido (201) | Permitido (200) | Negado (400 / 42501) | Apenas logs da marca/cliente ativo |
| **APPROVER** | Cliente vinculado | Permitido (200) | Negado (403) | Negado (403) | Negado (403) | Apenas logs da marca/cliente ativo |
| **CLIENT_VIEWER** | Cliente vinculado | Permitido (200) | Negado (403) | Negado (403) | Negado (403) | Apenas logs da marca/cliente ativo |
| **Sem vínculo / Inativo** | Nenhum | Negado (404 / 401) | Negado (404 / 401) | Negado (404 / 401) | Negado (404 / 401) | 0 linhas (RLS bloqueia) |

### Garantias de Segurança e Contrato

1. **Isolamento entre Organização, Cliente e Marca (Proteção contra IDOR)**:
   - Toda consulta no backend filtra rigidamente por `{ id: brandId, organizationId: org, clientId }`.
   - Se um usuário autenticado tentar consultar ou editar uma marca `brandId` pertencente a outro cliente através da URL de um cliente onde possui permissão, a API responde `404 Not Found`. Nenhum dado é vazado, nenhuma modificação ocorre no banco e nenhum log de auditoria indevido é gerado.
   - Em camada adicional de banco, políticas PostgreSQL RLS (`brand_read`, `brand_create`, `brand_update`) aplicam `can_read_client` e `can_edit_client` para a role não-privilegiada `socialflow_runtime`.
2. **Imutabilidade do Vínculo da Marca**:
   - `organizationId`, `clientId` e `id` são omitidos dos DTOs de mutação Zod (`strictObject` rejeita campos extras com 400).
   - O comando de update da API não inclui campos de vínculo.
   - A role runtime não possui privilégio SQL de `UPDATE` sobre `organizationId`, `clientId` ou `id`.
   - A trigger PostgreSQL `protect_brand_scope` bloqueia no banco qualquer tentativa de transferência de escopo com erro `42501`.
3. **Revogação de Acesso com Sessão Aberta**:
   - A função `scoped()` revalida membresia e status ativo da organização e do cliente a cada requisição em uma transação limpa.
   - Usuários com cookies ou sessões ativas têm o acesso imediatamente cortado (404) assim que o vínculo é inativado ou revogado.
4. **Auditoria Transacional e Limites Atuais**:
   - As alterações de marcas (`brand.created`, `brand.updated`) são registradas atomicamente na tabela `AuditLog` dentro da mesma transação do banco (`asActor`).
   - Políticas RLS de `AuditLog` protegem a leitura dos registros com base no vínculo ativo do cliente da marca.
   - *Limites atuais*: A tabela `AuditLog` não possui coluna discriminadora `entityType` (a validação RLS utiliza `EXISTS` em `Client` ou `Brand`); o contrato `brandUpdate` exige o envio de todos os campos textuais (`name` obrigatório), operando como substituição completa em vez de atualização parcial.
