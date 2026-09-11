# Arquitetura recomendada

## Estratégia

Começar modular e simples, sem microserviços prematuros.

### Monorepo TypeScript

-   `apps/web`: Next.js + React --- dashboard interno e futuro portal.
-   `apps/api`: Node.js/NestJS --- API, OAuth, RBAC, tenants, conteúdo.
-   `apps/worker`: Node.js --- jobs de render/publicação/analytics.
-   `packages/db`: Prisma + PostgreSQL.
-   `packages/ui`: componentes compartilhados.
-   `packages/contracts`: Zod/types.
-   `packages/social`: adapters Meta/TikTok.
-   `packages/render`: geração de imagens e integração Remotion.
-   `packages/config`: config tipada.

### Serviços

-   PostgreSQL: fonte de verdade.
-   Redis + BullMQ: filas, retries e scheduling.
-   S3-compatible storage: mídia.
-   Docker: execução.
-   Coolify: deploy, domínio, TLS e secrets.
-   Sentry/OpenTelemetry: observabilidade (adicionar quando MVP
    estabilizar).

## Adapter social

Interface única: `connect()`, `refreshToken()`, `validateMedia()`,
`publish()`, `getStatus()`, `fetchMetrics()`.

Implementações: `MetaAdapter`, `TikTokAdapter`.

Nenhum código de domínio deve depender diretamente do payload de uma
rede.

## Scheduler

Post aprovado cria job idempotente. Worker trava por
`postId + platform + scheduledAt`. Falha transitória usa retry
exponencial com jitter. Falha permanente vai para dead-letter/revisão
manual. Nunca duplicar publicação.

## Render

Imagens: template declarativo (JSON + HTML/CSS/SVG ou renderer
equivalente). Vídeos: avaliar Remotion; render em worker separado por
ser CPU/RAM intensivo.

## Open source

Avaliar Postiz como referência e possível componente/integrador, não
copiar cegamente. É AGPL-3.0: revisar implicações antes de incorporar
código ao produto. Avaliar n8n apenas para automações periféricas; não
usar como fonte de verdade do domínio. Remotion é excelente para vídeo
programático, mas possui termos próprios de licença para certos usos
comerciais: validar antes da produção.
