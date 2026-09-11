# Executar a fundação

Requisitos: Git, Node 24, pnpm 11.19.0 e Docker Compose v2 com daemon Linux. Todas as contas e organizações vivem na instalação central da agência. Não há conectores Meta/TikTok.

## Primeiro uso local

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm db:generate
node scripts/local-env.mjs
docker compose config --quiet
docker compose up --build --wait
docker compose run --rm seed
```

Abra http://localhost:3000. Usuário `admin-a@socialflow.test`; senha está em `DEV_SEED_PASSWORD` do `.env` local. Os outros acessos são `owner-a`, `editor-a`, `approver-a`, `viewer-a`, `admin-b`, todos no domínio fictício `socialflow.test`. O gerador não exibe as senhas nem sobrescreve arquivos. Nunca envie `.env` ao GitHub. Use senhas hexadecimais geradas para evitar caracteres reservados nas URLs de banco/Redis.

Seed exige development/test, `ALLOW_DEV_SEED=true`, senha explícita e URL de migration. É transacional e idempotente; não altera usuários, senhas ou clientes já existentes. Alterar DEV_SEED_PASSWORD depois do primeiro seed não redefine senhas. Não habilite o profile de ferramentas nem execute seed em produção.

No Windows, use `npm.cmd`/`npx.cmd` quando a política do PowerShell impedir scripts `.ps1`. Nesta estação Docker foi localizado em `C:\Users\arino\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe`. PATH de outra sessão pode ser diferente; `docker version` precisa mostrar Client e Server.

## Verificações

```sh
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
node scripts/local-env.mjs .local/test.env
docker compose --env-file .local/test.env -f compose.yaml -f compose.test.yaml -p socialflow-test up --build --wait
docker compose --env-file .local/test.env -f compose.yaml -f compose.test.yaml -p socialflow-test run --rm seed
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
```

Pare a instalação local antes de subir a de teste: ambas usam porta web 3000. As portas 55432/56379/53001/53002 só existem no override de teste e ficam ligadas a loopback. Não use o override em produção. Os testes não são mocks nem são ignorados se Docker estiver indisponível. Eles exigem seed e serviços reais. `pnpm exec node scripts/run-tests.mjs migrate|seed` executa ferramentas locais no banco de teste; essas credenciais não pertencem ao runtime.

Os testes de constraints usam a role de migration para provar que a própria FK/CHECK rejeita vínculos inválidos; os testes de isolamento e as requisições da aplicação usam `socialflow_runtime`. A mesma role possui apenas leitura de memberships e não pode conceder papéis. UPDATE Client permite somente nome/status, com trigger reservando status ao administrador. Exclusão na API arquiva o cliente. Cada escrita registra evento de auditoria na mesma transação.

Se o download do Chromium estiver indisponível e o Google Chrome já estiver instalado, use no PowerShell `$env:PLAYWRIGHT_CHANNEL='chrome'` antes de `pnpm test:e2e`. Sem essa variável, a CI e a execução padrão continuam usando o Chromium do Playwright. O projeto mobile emula viewport e toque no Chromium; não comprova compatibilidade com Safari/iOS real.

## Topologia e rotas

Browser → web Next → API Nest/Better Auth → PostgreSQL. API → Redis/BullMQ → worker. A web faz proxy somente para API interna fixa, preservando Origin e cookies. Runtime API/worker não recebem senha de migration. Dados não têm portas publicadas no compose base. Healthchecks: web/API/worker `/health/ready`, API/worker `/health/live`.

`/api/me` retorna sessão e vínculos autorizados; `/api/organizations/:org/clients` lista/cria; `/:id` lê/renomeia/arquiva. Listagem é limitada a 100 clientes nesta fundação. OWNER/ADMIN administram a própria organização, EDITOR renomeia seu cliente, APPROVER/CLIENT_VIEWER leem apenas vínculos. Conteúdo/aprovação vêm na Fase 2. `POST /api/organizations/:org/diagnostics` enfileira diagnóstico sem efeito social e exige administrador; worker revalida o vínculo na execução.

Rate limit é persistido pelo Better Auth no PostgreSQL. Headers de IP enviados pelo caller são substituídos pelo peer real da conexão; na topologia com proxy web, o limite de login é conservador e compartilhado por essa instância (5/minuto). Antes de ampliar a equipe, configurar ingress confiável e limitação individual sem confiar em forwarded headers arbitrários. Sessões duram 8 horas; logout, expiração e remoção no banco invalidam o acesso. Desativação de usuário é verificada a cada rota protegida. Cadastro público e demais endpoints de auth estão fechados.

Logs são JSON com evento, requestId, método/status; não registram corpo, URL de consulta, cookie, senha ou token. Erros internos retornam mensagem genérica. Para operação inicial, revogar sessões ou desativar usuários é ação administrativa por acesso controlado ao banco; não existe UI de administração de equipe nesta fase.
