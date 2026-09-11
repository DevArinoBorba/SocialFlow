# Produto

## Perfis

-   OWNER/ADMIN: equipe da agência, acesso global.
-   EDITOR: cria/importa/edita conteúdo.
-   APPROVER: aprova/rejeita conteúdo.
-   CLIENT_VIEWER: somente leitura e apenas do tenant autorizado.

## Entidades

Organization (agência), Client/Tenant, Brand, User, Membership,
SocialAccount, OAuthCredential, MediaAsset, Template, ContentBatch,
Post, PostVariant, Schedule, PublicationAttempt, MetricSnapshot,
AuditLog.

## Fluxo

Importação -\> validação -\> geração -\> rascunho -\> revisão -\>
aprovação -\> agendamento -\> fila -\> publicação -\> confirmação -\>
analytics.

## Conteúdo

-   imagem única;
-   carrossel;
-   vídeo vertical;
-   legenda;
-   hashtags;
-   CTA;
-   primeiro comentário (quando API suportar);
-   variantes por rede.

## Segurança obrigatória

Isolamento por tenant no backend e banco; RBAC; criptografia de tokens
em repouso; OAuth `state`/PKCE quando aplicável; secrets apenas no
Coolify; audit log; rate limit; validação de uploads; URLs assinadas;
backups; mínimo privilégio.

## Não objetivos do MVP

Scraping, automação de navegador para postar, compra de seguidores,
spam, contorno de limites das plataformas.
