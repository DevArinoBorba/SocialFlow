# Architecture Decision Records

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
