# Fase 1 — entregas pequenas e critérios de aceite

Planejamento de 11/09/2026. A Fase 1 foi implementada localmente; resultados e pendências estão em [FOUNDATION-IMPLEMENTATION.md](FOUNDATION-IMPLEMENTATION.md). Preservar todos os arquivos do Master Pack e não implementar Meta/TikTok nesta fase. Os PRs abaixo descrevem a sequência de entregas proposta; não representam PRs publicados.

## PR-01 — workspace e verificações

Criar pnpm workspace, TypeScript strict, apps web/api/worker, packages db/contracts/config e scripts de lint, format, typecheck, test e build. Não criar pacotes vazios UI/social/render antes de uso real. Registrar versões compatíveis, licenças e atividade dos mantenedores antes de instalar; gerar lockfile e fixar package manager. Node 24 e pnpm 11 locais são observações, não uma decisão automática de compatibilidade.

Aceite: instalação com lockfile congelado em checkout limpo; lint/typecheck/build executam nos pacotes existentes. CI inicial executa as mesmas verificações, com permissões mínimas e sem secrets de produção. Testes iniciais devem validar comportamento real de config, como rejeição de ambiente inválido, e não apenas existência de arquivos.

## PR-02 — banco e tenants

Prisma/PostgreSQL com Organization, Client, User e Membership. Modelo de identidade deve ser compatível com a decisão de auth do PR-03; fechar esse contrato antes de consolidar a migration. Definir unicidade de email, slug por organização, vínculos sem duplicação, status ativo e constraints para scopes organizacionais/clientes. Nullable clientId exige tratamento explícito de unicidade de membership organizacional.

Implementar consultas scoped e políticas no banco. Separar role de migration e runtime, introduzir contexto validado em transação. Seed somente de desenvolvimento, com duas organizações, dois clientes, admin, editor e viewer; não sobrescrever dados ou habilitar seed de produção.

Aceite: migration em banco vazio e reaplicação sem alteração; seed idempotente; testes PostgreSQL reais de leitura/escrita cross-tenant, vínculos inválidos e pool A/B. Testes executados com a mesma role runtime da aplicação. Documentar rollback por migration corretiva/restore, sem alegar reversibilidade de perda de dados.

## PR-03 — auth e RBAC

Fechar ADR de biblioteca comparando candidatos em DECISIONS; verificar licença, releases e advisories da versão escolhida. Implementar login, sessão, logout e revogação com biblioteca existente; desabilitar cadastro público inicialmente. Rotas de API autorizam a partir de identidade e membership do banco. OWNER/ADMIN administram somente sua organização; EDITOR e APPROVER têm ações explícitas; CLIENT_VIEWER não escreve. Nenhum papel herdado do browser.

Aceite: senha inválida, sessão expirada/revogada, origin/CSRF, rate limit, usuário desativado, enumeração e escalada de privilégios testados. A mesma URL é testada com identidades diferentes; não basta testar uma função de role isoladamente. Logs de erro não contêm senha, cookie ou token.

## PR-04 — web mínimo e API

Tela de login, sessão atual, lista de clientes autorizados e ação mínima de criação de cliente para administrador. Aplicar a skill de UI disponível e avaliar skill oficial Vercel antes da implementação web. Incluir estados carregando, vazio, erro e sessão expirada. Formulários acessíveis e retorno em português. Não entregar calendário falso nem integrações que pareçam conectadas.

Aceite: E2E login → criar cliente → visualizar; viewer não vê ação de escrita e a API também nega tentativa direta. Teste de IDs de outro cliente/organização. Fluxo utilizável por teclado e em tela pequena.

## PR-05 — worker, Docker e Coolify

Adicionar BullMQ/Redis para job de diagnóstico sem efeito social; avaliar licença/versão do Redis e das bibliotecas antes de fixar imagens. Health/readiness verificam dependências reais, com timeouts. Worker encerra graciosamente. Dockerfiles multi-stage, usuário sem root, build reprodutível e contexto sem `.env` real.

Compose centralizado: web/api/worker/postgres/redis e migration de execução única. Volumes persistentes; serviços de dados sem portas públicas em produção. Secrets obrigatórios no Coolify; exemplo local claramente separado. Não usar senha fallback de desenvolvimento em produção. Não instalar n8n, Postiz, Temporal ou render sem decisão específica.

Aceite: `docker compose config` e `docker compose up --build --wait` com ambiente de teste; login funciona; reinício preserva dados; worker processa diagnóstico; indisponibilidade de dependência aparece na readiness. Compose deve declarar healthchecks para Coolify, conforme [documentação oficial](https://coolify.io/docs/knowledge-base/health-checks). Medir memória e documentar recursos mínimos observados, não estimativas como fatos.

## PR-06 — aceite integrado e operação

Consolidar CI com lint, typecheck, unit, integração PostgreSQL/Redis, build e E2E. Pipeline Linux com Docker pode validar containers caso a estação ainda não tenha Docker. Não marcar testes ignorados ou jobs ausentes como aprovação. Manual local/Coolify com migrations, secrets, domínio/TLS, backup, restore e rollback da aplicação. Nenhum deploy externo automático é parte desta entrega.

Gate final: checkout limpo sobe pelo compose, migrations/seed dev funcionam, auth/RBAC/isolamento passam com serviços reais e todos os checks obrigatórios passam no remoto. Até isso ocorrer, status da Fase 1 é NO-GO para clientes reais.

## Antes das Fases 3/4

Executar o spike Postiz descrito em DECISIONS e resolver verificação Meta. Escolher um único responsável pelo agendamento por publicação. A conta própria deve validar primeiro envio controlado e depois agendamento persistente. TikTok mantém gate independente; sua pendência não bloqueia construir e testar a fundação.
