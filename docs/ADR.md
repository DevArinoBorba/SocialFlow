# Architecture Decision Records

## ADR-012 — renderer estático da Fase 6 (21/09/2026)

**Decisão:** adotar Satori `0.33.4` para transformar a árvore declarativa de
layout em SVG e Sharp `0.35.4` para rasterizar o SVG em PNG/JPEG. O renderer será
um pacote puro, sem HTML/CSS arbitrário, rede ou navegador. Fontes aprovadas e
mídias autorizadas serão fornecidas como bytes; a versão do renderer e o hash da
especificação farão parte da identidade idempotente do resultado.

O spike comparou SVG manual + Sharp, Satori + Sharp e Chromium/Playwright com o
mesmo layout, fonte e formatos 1080×1080, 1080×1350 e 1080×1920. Todos produziram
hash estável em três repetições. Satori + Sharp foi o caminho mais rápido após o
aquecimento (51–84 ms por arte no protótipo) e gerou arquivos menores que o
navegador. Um lote sequencial de 100 artes 1080×1350 terminou em 5,77 s, média de
57,71 ms, hash único e pico de RSS do processo Node de aproximadamente 129 MiB.
Os números são referência local, não promessa de capacidade da VPS.

SVG manual + Sharp foi tecnicamente rápido, mas a tipografia dependeu do
renderizador de fontes e ficou visualmente inconsistente. Corrigir isso exigiria
implementar layout, quebra de linha, fallback e conversão de texto para paths,
duplicando responsabilidades já cobertas pelo Satori. Chromium apresentou a
maior latência (aproximadamente 389–433 ms por arte no teste quente), arquivos de
409–607 KB e exige navegador e dependências de sistema. A documentação oficial
do Playwright também alerta para configuração própria de memória compartilhada e
sandbox em Docker; esse custo não se justifica para templates estáticos.

Satori usa um subconjunto de HTML/CSS baseado em Flexbox e não garante igualdade
total com o navegador. Essa limitação é aceita porque os templates serão
declarativos e controlados pelo produto. O contrato permitirá apenas propriedades
explicitamente suportadas e testadas. Textos longos, acentos, emojis, fallback de
fonte e safe areas terão testes visuais e de overflow antes do aceite.

**Licenças e manutenção observadas:** Satori `0.33.4`, MPL-2.0, publicação npm em
24/08/2026; Sharp `0.35.4`, Apache-2.0, publicação npm em 26/08/2026;
Playwright `1.63.0`, Apache-2.0, avaliado e rejeitado para o renderer. As versões
devem permanecer fixadas no lockfile. Distribuições devem preservar os avisos de
licença aplicáveis; qualquer alteração em arquivos cobertos pela MPL deve ser
reavaliada antes da distribuição.

Fontes e evidências:

- [Satori — documentação e limitações](https://github.com/vercel/satori)
- [Licença MPL-2.0 do Satori](https://github.com/vercel/satori/blob/main/LICENSE)
- [Sharp — composição](https://sharp.pixelplumbing.com/api-composite/)
- [Sharp — cache, concorrência e bloqueio de operações](https://sharp.pixelplumbing.com/api-utility/)
- [Playwright em Docker](https://playwright.dev/docs/docker)
- [Resultado reproduzível do spike](discovery/evidence/phase6-renderer-spike-20260921.json)

## ADR-011 — biblioteca privada de imagens (15/09/2026)

Selecionados @aws-sdk/client-s3 3.1132.0 (Apache-2.0, publicação npm observada
em 14/09/2026) e sharp 0.35.4 (Apache-2.0, atividade npm em 26/08/2026).
O SDK oficial evita implementar assinatura S3. Sharp decodifica e normaliza
os pixels; file-type/image-size isoladamente não comprovam decodificação
completa. Dependências nativas do sharp exigem validação na imagem Docker,
limite de pixels e concorrência. SDK fixado no lockfile; pnpm registrou a
exceção de idade mínima para a versão publicada recentemente.

Fontes: [AWS SDK](https://github.com/aws/aws-sdk-js-v3),
[sharp](https://github.com/lovell/sharp),
[limites do decoder](https://sharp.pixelplumbing.com/api-constructor/),
[URLs assinadas R2](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

URLs assinadas podem ser reutilizadas até expirar. Neste incremento de imagens
pequenas, upload e leitura passam pela API autenticada; isso permite revalidar
permissões sem janela de credencial assinada e evita substituição pós-validação.
Risco: maior uso de memória e tráfego da API. Medir antes de ampliar escala.
MinIO existente é reutilizado apenas no Compose de testes. Impeccable foi
consultada para estender a interface existente, sem redesenho.
Detalhes e limites no [relatório de mídia](discovery/PHASE2-MEDIA-IMPLEMENTATION.md).

## ADR-010 — fechamento operacional da fundação (12/09/2026)

Bootstrap offline com hashing Better Auth, verificação da role runtime,
revogação de leitura de auditoria e ensaio isolado com pg_dump/pg_restore.
Pesquisa, licenças, manutenção, riscos e decisões estão em
[discovery/FOUNDATION-CLOSURE.md](discovery/FOUNDATION-CLOSURE.md).

## ADR-001 --- Plataforma própria vs Postiz

Status: PENDENTE. Investigar funcionalidades, API pública, self-host,
arquitetura, issues recentes, licença AGPL-3.0, segurança e custo de
adaptação.

## ADR-002 --- n8n

Status: PENDENTE. Permitido para notificações/integrações periféricas.
Não deve controlar estado crítico de publicação.

## ADR-003 --- Remotion

Status: PENDENTE. Preferência técnica para vídeos programáticos,
condicionada à revisão da licença aplicável ao uso comercial.

## Template

Contexto / alternativas / evidências / licença / riscos / decisão /
consequências / data.


## Revisão de 11/09/2026

Os registros iniciais acima foram preservados como histórico. A avaliação
atual e as evidências de licença/manutenção estão em
[discovery/DECISIONS.md](discovery/DECISIONS.md):

- ADR-001: integração Postiz proposta para spike, sem incorporação de código.
- ADR-002: n8n adiado, fora da fundação e condicionado ao uso/licença.
- ADR-003: Remotion condicionado à licença e à Fase 7.
- ADR-004: Mixpost avaliado, não selecionado para substituir o stack.
- ADR-005: detalhamento de isolamento e candidatos de autenticação.
- ADR-006: proposta de identidade lógica de publicação e reconciliação.

As decisões da implementação da fundação (ADR-007 e ADR-008) estão em
[discovery/FOUNDATION-IMPLEMENTATION.md](discovery/FOUNDATION-IMPLEMENTATION.md).
As propostas de integrações sociais continuam condicionadas aos gates próprios.

## ADR-009 — correções transitivas de segurança (11/09/2026)

O audit do lockfile encontrou cinco alertas high. Fixar overrides para
deepmerge-ts 8.0.2, mysql2 3.24.4 e multer 2.3.0, mantendo as dependências
diretas. Versões e engines foram consultadas no npm; DeepmergeTS usa
BSD-3-Clause, MySQL2 e Multer usam MIT. Atividade npm observada: 21/08/2026,
08/09/2026 e 28/08/2026, respectivamente. Revisar e remover os overrides quando os mantenedores
incorporarem versões corrigidas.

Fontes: [DeepmergeTS 8](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0),
[Multer 2.3](https://github.com/expressjs/multer/releases/tag/v2.3.0),
[MySQL2 advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr).
DeepmergeTS 8 altera merge de Maps e comportamento de deepmergeInto; a
configuração Prisma deste projeto usa objetos simples. Validar geração,
migrations e build com o override. Não há MySQL nem upload multipart
expostos pela fundação, mas os pacotes fazem parte da árvore instalada.

Após resolução, audit de produção passou no limite high: um alerta low
remanescente em esbuild 0.27.7, associado ao servidor de desenvolvimento
no Windows. Não é executado esse servidor no runtime de produção. Atualização
fica pendente com as dependências de ferramentas; não ignorar o advisory na CI.
