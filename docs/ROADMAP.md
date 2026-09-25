# Roadmap e gates

## Fase 0 --- Discovery técnico

Saída: ADR sobre Postiz/n8n/Remotion; matriz de requisitos das APIs
Meta/TikTok; modelo de ameaças. Gate: nenhuma dependência escolhida sem
licença e manutenção verificadas.

## Fase 1 --- Fundação

Monorepo, lint/format/typecheck, testes, Docker, Postgres, Redis,
migrations, auth local, RBAC, tenant isolation, CI. Gate:
`docker compose up` sobe tudo; testes verdes; tenant A não acessa tenant
B.

## Fase 2 --- Conteúdo e mídia

Clientes, marcas, biblioteca, templates, CSV/XLSX import, preview, lote,
estados draft/review/approved. Gate: importar 100 linhas com relatório
de erros sem quebrar lote.

## Fase 3 --- Meta

OAuth, Facebook Page/Instagram profissional, seleção de contas,
publicação de mídia suportada, refresh/reconexão, logs. Gate: publicar
em conta de teste e confirmar ID remoto sem duplicação.

## Fase 4 --- Scheduler

BullMQ, retries, idempotência, timezone, cancelamento, reprogramação,
dead-letter. Gate: teste de concorrência e reinício do worker sem posts
duplicados.

## Fase 5 --- TikTok

OAuth + Content Posting API, validação de mídia, status assíncrono.
Gate: vídeo/foto de teste publicado pela API oficial e status
persistido.

## Fase 6 --- Geração em lote

Templates, variáveis, fontes, safe areas 1:1/4:5/9:16, render PNG/JPEG.
Gate: lote de 100 artes consistente e reprodutível.

## Fase 7 --- Vídeo

Remotion/renderer aprovado, composição 9:16, texto animado, imagem/vídeo
de fundo, áudio licenciado. Gate: render concorrente controlado sem
derrubar API/web.

## Fase 8 --- Portal cliente

CLIENT_VIEWER, dashboard somente leitura, calendário, posts e métricas
do próprio tenant. Gate: testes de autorização e ausência total de
vazamento cross-tenant.

## Fase 9 --- Analytics e operação

Snapshots, relatórios, alertas, auditoria, backup/restore,
observabilidade. Gate: restore testado e runbook de incidentes.

## Fase 10 --- Escala

Separar workers de render, storage externo, tuning DB/Redis, horizontal
scaling. Só executar após métricas reais demonstrarem necessidade.


## Estado operacional — 21/09/2026

- **Fase 0 (Discovery técnico)**: Concluída.
- **Fase 1 (Fundação)**: Concluída e testada.
- **Fase 2 (Conteúdo e mídia)**: Concluída e testada.
- **Fase 3 (Meta — Facebook e Instagram)**: Concluída, testada com publicações reais controladas em homologação e implantada em produção. O fluxo inclui OAuth, seleção explícita de contas, publicação manual, idempotência, leases, reconciliação e auditoria.
- **Fase 4 (Scheduler com BullMQ)**: Concluída, testada com agendamento real controlado em homologação e implantada em produção. O fluxo inclui jobs determinísticos, retries persistentes, reconciliação, timezone IANA, cancelamento, reprogramação e prevenção de duplicações.
- **Infraestrutura de entrega**: Build externo no GitHub Actions, imagem imutável no GHCR e deploy por digest validados em homologação e produção. A VPS não compila a aplicação durante o deploy.
- **Fase 5 (TikTok)**: Adiada até confirmar elegibilidade e aprovação do aplicativo na Content Posting API oficial. A avaliação pode prosseguir em paralelo, sem bloquear o produto.
- **Fase 6 (Geração em lote)**: Incrementos 1–3 implementados e validados localmente, incluindo o gate automatizado de 100 artes. Próximo passo: Incremento 4 — observabilidade, limites operacionais, retenção e homologação controlada conforme [PHASE6-IMPLEMENTATION-PLAN.md](PHASE6-IMPLEMENTATION-PLAN.md). A Fase 6 só será concluída após o aceite operacional do gate.
- **Fases 7 a 10**: Planejadas e ainda não iniciadas. A Fase 7 é Vídeo; Portal do Cliente consta na Fase 8.
