# Decisões e pesquisa de reutilização

Consulta: 11/09/2026. “Proposto” não significa dependência instalada. Atividade abaixo é evidência observada, não certificação de segurança nem garantia de última versão. Antes de instalar, registrar tag/commit exato, licença nessa revisão, advisories e lockfile.

## ADR-001 — Postiz: avaliar integração; preservar core planejado

Status: PROPOSTO para integração, sem incorporação de código.

O [repositório](https://github.com/gitroomhq/postiz-app) declara AGPL-3.0 e usa pnpm, Next.js, NestJS, Prisma/PostgreSQL e Temporal. Há API pública e recursos de agendamento e colaboração. A atividade observada inclui [release v2.23.0 em 4 de agosto](https://github.com/gitroomhq/postiz-app/releases) e [advisories publicados em agosto de 2026](https://github.com/gitroomhq/postiz-app/security). A existência de correções publicadas exige conferir versões afetadas/corrigidas; não aprova automaticamente a imagem mais recente.

Fit: alto para avaliar publicação e calendário; isolamento por cliente, aprovações, importação em lote e permissões precisam de prova. Uma integração por [API](https://docs.postiz.com/public-api/introduction) evita acoplar tabelas, mas não é uma conclusão sobre obrigações de licença. Revisar o texto AGPL na revisão escolhida e a forma de uso antes de distribuir adaptações ou disponibilizar uma versão modificada por rede.

Alternativas: implementação modular prevista; integração externa; fork completo. Preferência nesta etapa: manter fundação e realizar spike de integração antes das Fases 3/4. O fork amplia manutenção e muda o escopo. Temporal seria uma mudança de infraestrutura que não está autorizada por esta decisão.

Aceite do spike: dois clientes isolados, chaves/API com escopo demonstrado, aprovação anterior ao envio, rastreamento de ID/status, cancelamento e reprogramação, resultado incerto sem envio duplicado, recursos VPS medidos, versão corrigida e análise de licença concluída. Não operar dois schedulers como donos da mesma publicação.

## ADR-002 — n8n: manter fora da fundação

Status: ADIADO. A [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/) tem restrições; não tratar n8n como MIT ou open source irrestrito. O [help center oficial](https://support.n8n.io/article/can-i-use-your-license-for-my-use-case) distingue hospedar workflows/credenciais de clientes e integração embarcada. Só avaliar notificações internas bem delimitadas; uso multi-cliente precisa de enquadramento contratual antes de adoção. Não adicionar custo/licença nem contactar fornecedor nesta etapa.

Maturidade: ecossistema amplo; [releases](https://github.com/n8n-io/n8n/releases) registram 2.38.6 em 10/09/2026 e 2.39.4 em 11/09/2026. Manutenção ativa não elimina riscos de execução de nodes e exposição de credenciais. Alternativa para eventos internos simples: worker previsto. PostgreSQL continua como fonte de verdade.

## ADR-003 — Remotion: candidato para Fase 7

Status: CONDICIONADO, sem instalação. Bom fit técnico para vídeo em React e render em lote. A [licença](https://www.remotion.dev/docs/license) tem termos próprios e a [página comercial](https://www.remotion.dev/) distingue organizações pequenas, licença de empresa e automação. Não presumir gratuidade: tamanho da organização e modalidade de render ainda desconhecidos. Não fixar orçamento sem esses dados.

Atividade: [release v4.0.522 em 7 de setembro](https://github.com/remotion-dev/remotion/releases); documentação de skills atualizada em 10/09/2026. Usar [skills oficiais](https://www.remotion.dev/docs/ai/skills) no início da Fase 7. CPU/RAM, Chromium, fontes e mídias não confiáveis exigem limites de execução. Alternativa de renderer ainda precisa de benchmark com os templates reais; não construir engine própria antecipadamente.

## ADR-004 — alternativa Mixpost

Status: NÃO SELECIONADO para substituir o stack. O [repositório Lite](https://github.com/inovector/mixpost) declara MIT e usa Laravel/PHP; Pro/Enterprise são produtos distintos. Não extrapolar licença nem funcionalidades do Lite para as edições comerciais. Há [histórico de releases](https://github.com/inovector/mixpost/releases), incluindo v2.3.0; a data completa da atividade mais recente não foi confirmada no recorte consultado. Avaliação de advisories também pendente. Oferece alternativa reutilizável, mas não há evidência suficiente para justificar migrar o plano TypeScript. Reavaliar se o spike Postiz falhar.

## ADR-005 — isolamento e autenticação

Status: DETALHAMENTO PROPOSTO da arquitetura existente.

Organization representa a agência; Client é o tenant de conteúdo. Todo acesso global é relativo à organização do vínculo. Um usuário pode ter mais de um vínculo, mas cada requisição precisa de contexto validado no servidor. Nunca aceitar role/organizationId/clientId enviados pelo navegador como prova de autorização.

Para PostgreSQL, [RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) permite políticas de leitura e escrita; superuser, BYPASSRLS e dono da tabela têm tratamento especial. Implementar role de runtime separada de migration e contexto dentro de transação para evitar vazamento em pools. A política deverá verificar memberships e não só um clientId arbitrário. Testes devem provar bypass por ID e relacionamento impossível entre organizações.

Autenticação: comparar [Passport na documentação NestJS](https://docs.nestjs.com/security/authentication) com [Better Auth e adapter Prisma](https://better-auth.com/docs/adapters/prisma). Ambos são candidatos, não escolhas aprovadas de dependência. A pesquisa atual confirma integração documentada; licença, manutenção e advisories da versão candidata são gate do PR-03. Evitar implementar sessão, hashing ou recuperação de senha do zero. Não confundir identidade autenticada com autorização por tenant.

## ADR-006 — publicação confiável

Status: PROPOSTO para detalhamento nas Fases 3/4.

Os [jobs idempotentes do BullMQ](https://docs.bullmq.io/patterns/idempotent-jobs) ajudam no retry, mas o domínio precisa controlar o efeito remoto. Proposta: Publication com chave lógica por destino e revisão aprovada; PublicationAttempt com contador único por Publication; outbox na mesma transação da intenção. Cada tentativa persiste estado e identificadores recuperáveis. Timeout após envio vira UNKNOWN/RECONCILING, não retry automático cego. Cancelamento e reprogramação invalidam a revisão antiga, inclusive em workers já iniciados. A garantia depende das capacidades de cada API; não prometer exactly-once remoto.

## Skills verificadas

O [diretório skills.sh](https://skills.sh/) foi consultado antes de considerar instalação. Contagens observadas são aproximadas e mutáveis.

| Skill/fonte | Evidência | Aplicação e decisão |
| --- | --- | --- |
| find-skills, já disponível localmente | SKILL.md lido nesta sessão | Utilizada para orientar esta pesquisa. |
| vercel-react-best-practices, [Vercel](https://github.com/vercel-labs/agent-skills) | Cerca de 705 mil instalações; repositório oficial com 31 mil estrelas e MIT | Candidata para PR web; revisar instruções e fixar revisão antes de instalar. |
| remotion-best-practices, [Remotion](https://github.com/remotion-dev/skills) | Cerca de 520 mil instalações; repositório oficial com 4,5 mil estrelas | Candidata para Fase 7; confirmar licença do pacote de skills na revisão escolhida, separada da licença do renderer. |
| impeccable, já disponível localmente | Catálogo local | Aplicar quando houver dashboard a desenhar; não é necessária para a auditoria documental. |

Nenhuma skill externa foi instalada. Popularidade não substitui inspeção de instruções, procedência e permissões. Não há motivo para criar uma skill nova nesta fase.
