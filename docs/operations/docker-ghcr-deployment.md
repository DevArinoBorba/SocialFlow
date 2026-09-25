# Manual de Operações: Build Externo no GitHub Actions e Deploy no Coolify via GHCR

Este guia documenta o ciclo completo de construção, publicação, configuração e deploy de imagens Docker imutáveis do SocialFlow no GitHub Container Registry (GHCR), eliminando compilações locais na VPS do Coolify.

---

## 1. Arquitetura da Imagem Única

O SocialFlow utiliza uma **única imagem Docker unificada e imutável por commit**. A mesma imagem contém:

- Frontend (`@socialflow/web`)
- Backend API (`@socialflow/api`)
- Worker de background (`@socialflow/worker`)
- Worker de renderização (`@socialflow/worker`, processo `start:render`)
- Ferramentas de banco e migrações do Prisma (`@socialflow/db`)

### Especificações Técnicas:

- **Base:** `node:24.19.0-bookworm-slim`
- **Gerenciador de Pacotes:** `pnpm@11.19.0`
- **Usuário de Execução:** `node` (UID 1000, não-root)
- **Portas Expostas pela imagem:** `3000` (Web), `3001` (API), `3002` (Worker), `3003` (Render Worker)
- **Dimensões da Imagem Atual:**
  - **Tamanho compactado (download/transferência):** aproximadamente **351 MB**.
  - **Tamanho descompactado (armazenamento local no Docker daemon):** aproximadamente **1,6 GB** (inclui runtime Node.js, CLI do Prisma, utilitários de migration e dependências da aplicação).
  - _Melhoria futura documentada:_ Criação de uma etapa multi-stage com poda seletiva de ferramentas de build para reduzir o tamanho descompactado em runtime, sem bloquear a entrega atual.
- **Identificação Primária:** SHA completo de 40 caracteres do commit Git (ex: `ghcr.io/devarinoborba/socialflow:5e7c5f66f2951b79055dec91e03cca34f4b04bc4`).
- **Labels OCI:** Metadados padronizados gerados pelo `docker/metadata-action` gravados na imagem com título, descrição, repositório de origem, SHA do commit e timestamp RFC3339 de criação (`org.opencontainers.image.created`).

---

## 2. Como a Imagem é Construída e Publicada

O workflow `.github/workflows/ci.yml` divide a esteira em jobs estritamente separados:

1. **Job `foundation`:** Executado em pushes e Pull Requests para a branch `master`. Roda build, linter, format check, typecheck, testes unitários e auditoria de dependências; o `pnpm test:foundation` executa o drill em containers efêmeros, incluindo suítes de integração e E2E.
2. **Job `docker-validate`:** Executado **exclusivamente em Pull Requests**.
   - Possui apenas permissão `contents: read`.
   - **Não possui** permissão `packages: write`.
   - **Não executa login** no GHCR.
   - Compila a imagem Docker (`push: false`) apenas para validar que o `Dockerfile` constrói com sucesso.
3. **Job `docker-publish`:** Executado **exclusivamente em push na branch `master`** após aprovação do job `foundation`.
   - Possui permissão restrita `packages: write` para publicar no GHCR.
   - Autentica no GHCR via token interno efêmero do GitHub Actions (`GITHUB_TOKEN`).
   - Compila e publica a imagem identificada pelo SHA completo (`${{ github.sha }}`).
   - Gera attestation de proveniência (`provenance`) e SBOM.

---

## 3. Topologia Compose e Desenvolvimento Local

- O arquivo principal `compose.yaml` **não contém nenhuma diretiva `build:`**.
- Todos os serviços de aplicação (`migrate`, `api`, `worker`, `render-worker`, `web` e `seed`) exigem obrigatoriamente a variável `${SOCIALFLOW_IMAGE:?Set SOCIALFLOW_IMAGE}`.
- O arquivo `compose.override.yaml` foi deliberadamente removido do repositório para impedir que ferramentas de orquestração como o Coolify carreguem automaticamente blocos de compilação local.
- Para desenvolvimento local com compilação direta, deve-se invocar explicitamente o arquivo `compose.local.yaml`:
  ```bash
  docker compose -f compose.yaml -f compose.local.yaml up
  ```

---

## 4. Como Localizar a Imagem pelo SHA

1. Obtenha o SHA completo do commit:
   ```bash
   git rev-parse HEAD
   ```
2. No GitHub:
   - Acesse o repositório: `https://github.com/DevArinoBorba/SocialFlow/pkgs/container/socialflow`.
   - Na lista de tags do pacote, localize a tag com o hash de 40 caracteres correspondente ao commit.
3. O identificador completo da imagem será:
   ```text
   ghcr.io/devarinoborba/socialflow:<SHA_COMPLETO>
   ```

---

## 5. Configuração Futura no Coolify (Integração com Registro Privado)

Para que o Coolify consiga baixar imagens privadas do GHCR sem expor credenciais no código:

### 5.1. Criar Token de Leitura no GitHub

1. No GitHub, acesse **Settings** ➔ **Developer Settings** ➔ **Personal access tokens** ➔ **Tokens (classic)**.
2. Gere um novo token com o nome `coolify-ghcr-reader`.
3. Selecione exclusivamente a permissão:
   - `read:packages` (Download packages from GitHub Package Registry).
4. Guarde o token gerado com segurança.

### 5.2. Cadastrar Registro no Coolify

1. No painel do Coolify, acesse **Sources** (ou **Registries**).
2. Clique em **Add Registry** e selecione **Docker Engine / Custom Registry**.
3. Preencha os campos:
   - **Name:** `GHCR SocialFlow`
   - **Registry URL:** `ghcr.io`
   - **Username:** `DevArinoBorba` (ou o usuário dono do token)
   - **Password:** `<TOKEN_GHCR_COM_ESCOPO_READ_PACKAGES>`
4. Salve e teste a conexão do registro.

---

## 6. Configuração da Variável `SOCIALFLOW_IMAGE`

Nos ambientes do Coolify (`socialflow-homolog` e `socialflow-production`):

1. Acesse o recurso correspondente (Docker Compose).
2. Na aba **Environment Variables**, configure:
   ```env
   SOCIALFLOW_IMAGE=ghcr.io/devarinoborba/socialflow:<SHA_COMPLETO>
   ```
3. Se a variável estiver ausente, o Docker Compose abortará imediatamente a inicialização com erro (`Set SOCIALFLOW_IMAGE`), impedindo deploys sem imagem definida.

---

## 7. Procedimento de Deploy em Homologação

1. Faça push das alterações para a branch `master`.
2. Aguarde a conclusão com sucesso do workflow de CI e publicação da imagem no GHCR.
3. Copie o SHA completo do commit publicado.
4. No Coolify, abra o recurso de **Homologação** (`socialflow-homolog`).
5. Atualize a variável `SOCIALFLOW_IMAGE` com o novo SHA.
6. Clique em **Redeploy**.

### Comportamento e Duração do Deploy

- O deploy consiste unicamente no download (`docker pull`) da imagem pré-compilada e na recriação/inicialização dos contêineres.
- A duração do deploy depende da velocidade de tráfego de rede da VPS com o GHCR, do reaproveitamento de camadas já em cache e do tempo de aquecimento dos healthchecks da API e do Web.
- **Nenhum comando de compilação** (`pnpm install`, `next build`, `tsc`, `turbo`) será executado na VPS.

### Como Confirmar que Nenhum Build Ocorreu na VPS

Execute na VPS:

1. Nos logs do Coolify, observe que apenas etapas de pull ocorrem (`Pulling migrate...`, `Pulling api...`, etc.).
2. Verifique o cache do BuildKit na VPS com `docker builder du`: o contador permanecerá inalterado.

---

## 8. Procedimento de Promoção para Produção

Após validação completa em homologação:

1. Obtenha exatamente o mesmo valor de `SOCIALFLOW_IMAGE` testado e validado em homologação.
2. No Coolify, abra o recurso de **Produção** (`socialflow-production`).
3. Atualize a variável `SOCIALFLOW_IMAGE` com o mesmo SHA exato.
4. Clique em **Redeploy**.
5. **Garantia de Paridade:** Homologação e produção executam o mesmo binário imutável, garantindo que o que foi validado é exatamente o que roda em produção.

---

## 9. Procedimento e Restrições de Rollback

Se uma versão implantada apresentar instabilidade:

### 9.1. Regras Críticas de Rollback

> [!WARNING]
>
> - **O rollback de imagem Docker NÃO desfaz migrações de banco de dados (`prisma migrate`).**
> - Um SHA anterior somente pode ser restaurado via `SOCIALFLOW_IMAGE` se o código correspondente for **estritamente compatível** com o schema do banco de dados atualmente aplicado.
> - Se a versão problemática aplicou migrations destrutivas (ex: remoção de colunas/tabelas) ou que introduziram restrições incompatíveis com a versão antiga, o rollback exigirá um procedimento específico de migração reversa ou restauração do backup lógico do banco de dados antes da troca da imagem.

### 9.2. Execução do Rollback

1. Identifique o SHA anterior estável compatível com o banco.
2. No Coolify, altere a variável `SOCIALFLOW_IMAGE` para o SHA anterior:
   ```env
   SOCIALFLOW_IMAGE=ghcr.io/devarinoborba/socialflow:<SHA_ANTERIOR>
   ```
3. Clique em **Redeploy**.
4. O Docker reutilizará a imagem prévia localmente ou fará o download da versão indicada.

---

## 10. Como Provar que Web, API e Worker Usam a Mesma Imagem

Para auditar na VPS que todos os containers estão executando a mesma versão:

```bash
docker inspect --format '{{.Name}}: Image={{.Config.Image}} ImageID={{.Image}}' \
  $(docker ps -q --filter "name=socialflow")
```

**Resultado esperado:**

- Todos os containers (`api`, `web`, `worker`, `migrate`) devem exibir exatamente o mesmo `ImageID` (hash sha256 do Docker).

---

## 11. Como Revogar a Credencial de Leitura do GHCR

Caso o token configurado no Coolify precise ser rotacionado ou revogado:

1. No GitHub, acesse **Settings** ➔ **Developer Settings** ➔ **Personal access tokens** ➔ **Tokens (classic)**.
2. Localize o token `coolify-ghcr-reader` e clique em **Delete**.
3. Imediatamente o token perde a capacidade de autenticar no registro.
4. Crie um novo token com escopo `read:packages` e atualize a configuração no Coolify conforme a Seção 5.2.
