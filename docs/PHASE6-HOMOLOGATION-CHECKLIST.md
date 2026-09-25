# Checklist de homologação — Fase 6

Use este checklist para promover a imagem validada localmente para o ambiente
de homologação. Nenhum item deste documento autoriza promoção automática para
produção.

## Pré-requisitos

- [ ] Commit aprovado e publicado na branch `master`.
- [ ] Workflow `foundation` verde.
- [ ] Imagem publicada no GHCR com SHA completo do commit.
- [ ] `SOCIALFLOW_IMAGE` aponta para esse SHA, sem usar `latest`.
- [ ] Backup remoto recente confirmado e procedimento de restore disponível.
- [ ] Secrets de homologação independentes dos de produção.

## Deploy controlado

- [ ] Confirmar que o Coolify fará apenas pull da imagem, sem build local.
- [ ] Aplicar migrations com `prisma migrate deploy` antes da API e dos workers.
- [ ] Confirmar que `web`, `api`, `worker` e `render-worker` usam o mesmo SHA.
- [ ] Confirmar que somente o web recebe domínio/TLS público.

## Health checks

- [ ] PostgreSQL e Redis saudáveis.
- [ ] Media storage saudável.
- [ ] API readiness retorna sucesso.
- [ ] Web readiness retorna sucesso.
- [ ] Worker e render-worker iniciam sem erro de credencial ou permissão.
- [ ] Logs não exibem segredos, tokens ou stack traces para o usuário.

## Smoke tests

- [ ] Login de operador de homologação.
- [ ] Isolamento entre duas organizações/clientes.
- [ ] Geração individual nos formatos SQUARE, PORTRAIT e STORY.
- [ ] Geração em lote, histórico, cancelamento e retry idempotente.
- [ ] Download de mídia gerada e verificação de dimensões.
- [ ] Fluxos existentes de conteúdo, aprovação e publicação permanecem verdes.

## Observabilidade e encerramento

- [ ] Registrar duração, memória, erros, filas e uso de storage do ensaio.
- [ ] Confirmar retenção e limpeza de temporários conforme a política.
- [ ] Registrar SHA, horário, operador e resultado dos smoke tests.
- [ ] Abrir aceite operacional da Fase 6 somente com todas as evidências anexadas.
- [ ] Promover para produção somente após aprovação explícita e usando o mesmo SHA.

## Falha ou rollback

- [ ] Interromper a promoção se qualquer health check ou smoke test falhar.
- [ ] Preservar logs e evidências sem incluir segredos.
- [ ] Reverter somente para uma imagem compatível com o schema atual.
- [ ] Não editar migrations aplicadas nem usar reset/destruição de volumes.
- [ ] Se o schema for incompatível, executar migração corretiva ou restore antes
      de trocar a imagem.
