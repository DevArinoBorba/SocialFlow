# SocialFlow --- Master Pack v0.1

Plataforma interna multi-cliente para uma agência de marketing criar
conteúdo em lote, revisar, agendar, publicar e acompanhar resultados em
Instagram, Facebook e TikTok.

## Objetivo do MVP

Validar com uma única conta própria: 1. Login da equipe. 2. Criar um
cliente/marca. 3. Conectar Instagram/Facebook. 4. Importar CSV/XLSX com
frases, legendas, datas, horários e referências de mídia. 5. Gerar
imagens em lote a partir de templates. 6. Revisar/aprovar. 7. Agendar.
8. Publicar via APIs oficiais. 9. Registrar sucesso/falha, URL/ID remoto
e tentativas. 10. Depois adicionar TikTok, vídeo programático, portal do
cliente e analytics.

## Regra de desenvolvimento

Antes de implementar qualquer componente relevante, pesquisar: - solução
open source madura; - biblioteca oficial; - SDK oficial; - Agent Skill
existente; - integração pronta.

Só desenvolver do zero quando a alternativa existente não atender
requisitos, licença, segurança ou manutenção. Registrar a decisão em
`docs/ADR.md`.

## Infra

GitHub -\> Docker -\> Coolify -\> VPS própria da agência. A plataforma é
centralizada. Clientes NÃO recebem código nem VPS. Futuramente podem
receber acesso somente ao portal/dashboard da própria organização.

## Começar

Leia, nesta ordem: 1. `docs/PRODUCT.md` 2. `docs/ARCHITECTURE.md` 3.
`docs/ROADMAP.md` 4. `agents/AGENTS.md` 5. `prompts/00-orchestrator.md`
6. `prompts/01-foundation.md`

Nunca commitar `.env`, tokens OAuth, client secrets ou chaves privadas.


## Continuidade — auditoria de 11/09/2026

Fechamento da fundação de 12/09/2026: veja
[relatório de aceite e roteiro de revisão](docs/discovery/FOUNDATION-CLOSURE.md).

A inspeção local e a pesquisa de reutilização estão documentadas em
[docs/discovery/AUDIT-2026-09-11.md](docs/discovery/AUDIT-2026-09-11.md).
Consulte esse relatório antes de executar os prompts de implementação.
Ele registra decisões propostas, pendências Meta/TikTok, ameaças e seis
entregas para a Fase 1. A fundação está implementada; o estado de validação
está em [docs/discovery/FOUNDATION-IMPLEMENTATION.md](docs/discovery/FOUNDATION-IMPLEMENTATION.md).
As fases de fundação, conteúdo e mídia, publicação Meta e agendamento estão
implantadas em produção. O deploy usa imagem imutável construída no GitHub
Actions e publicada no GHCR; consulte o estado atual em
[docs/ROADMAP.md](docs/ROADMAP.md). O próximo ciclo ativo é a Fase 6, geração de
artes estáticas em lote. A integração TikTok permanece condicionada à
elegibilidade da API oficial.
