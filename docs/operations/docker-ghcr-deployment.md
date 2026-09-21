# Manual de Operações: Build Externo no GitHub Actions e Deploy no Coolify via GHCR

Este guia documenta o ciclo completo de construção, publicação, configuração e deploy de imagens Docker imutáveis do SocialFlow no GitHub Container Registry (GHCR), eliminando compilações locais na VPS do Coolify.

---

## 1. Arquitetura da Imagem Única

O SocialFlow utiliza uma **única imagem Docker unificada e imutável por commit**. A mesma imagem contém:

- Frontend (`@socialflow/web`)
- Backend API (`@socialflow/api`)
- Worker de background (`@socialflow/worker`)
- Ferramentas de banco e migrações do Prisma (`@socialflow/db`)

### Especificações Técnicas:

- **Base:** `node:24.19.0-bookworm-slim`
- **Gerenciador de Pacotes:** `pnpm@11.19.0`
- **Usuário de Execução:** `node` (UID 1000, não-root)
- **Portas Expostas:** `3000` (Web), `3001` (API), `3002` (Worker)
- **Identificação Primária:** SHA completo de 40 caracteres do commit Git (ex: `ghcr.io/devarinoborba/socialflow:b47e0dc2b465d0b77362a722c001a347b56dee78`).
- **Labels OCI:** Metadados padronizados gravados na imagem com título, descrição, repositório de origem, SHA do commit e timestamp RFC3339 de criação.

---

## 2. Como a Imagem é Construída e Publicada

1. Todo push na branch `master` dispara o workflow `.github/workflows/ci.yml`.
2. O job `foundation` executa a validação completa: linter, format check, typecheck, testes unitários, testes de integração e drill do foundation.
3. Se e somente se todas as validações passarem, o job `docker` é iniciado:
   - Inicializa o Docker Buildx.
   - Autentica no GHCR via token interno efêmero do GitHub Actions (`GITHUB_TOKEN`) com escopo restrito `packages: write`.
   - Compila a imagem injetando o commit SHA como label e tag.
   - Publica a imagem no registro: `ghcr.io/devarinoborba/socialflow:<SHA_COMPLETO>`.
   - Gera attestation de proveniência (`provenance`) e SBOM.
4. Em Pull Requests, a imagem é apenas compilada para validar a integridade do `Dockerfile`, sem efetuar login no GHCR e sem publicar (`push: false`).

---

## 3. Como Localizar a Imagem pelo SHA

1. Obtenha o SHA completo do commit:
   ```bash
   git rev-parse HEAD
   ```
2. No GitHub:
   - Acesse o repositório: `https://github.com/DevArinoBorba/SocialFlow/pkgs/container/socialflow`.
   - Na lista de tags do pacote, procure a tag com o hash de 40 caracteres (ex: `b47e0dc2b465d0b77362a722c001a347b56dee78`).
3. O identificador completo da imagem será:
   ```text
   ghcr.io/devarinoborba/socialflow:<SHA_COMPLETO>
   ```

---

## 4. Configuração Futura no Coolify (Integração com Registro Privado)

Para que o Coolify consiga baixar imagens privadas do GHCR sem expor credenciais no código:

### 4.1. Criar Token de Leitura no GitHub

1. No GitHub, acesse **Settings** ➔ **Developer Settings** ➔ **Personal access tokens** ➔ **Tokens (classic)**.
2. Gere um novo token com o nome `coolify-ghcr-reader`.
3. Selecione exclusivamente a permissão:
   - `read:packages` (Download packages from GitHub Package Registry).
4. Guarde o token gerado com segurança.

### 4.2. Cadastrar Registro no Coolify

1. No painel do Coolify, acesse **Sources** (ou **Registries**).
2. Clique em **Add Registry** e selecione **Docker Engine / Custom Registry**.
3. Preencha os campos:
   - **Name:** `GHCR SocialFlow`
   - **Registry URL:** `ghcr.io`
   - **Username:** `DevArinoBorba` (ou o usuário dono do token)
   - **Password:** `<TOKEN_GHCR_COM_ESCOPO_READ_PACKAGES>`
4. Salve e teste a conexão do registro.

---

## 5. Configuração da Variável `SOCIALFLOW_IMAGE`

Nos ambientes do Coolify (`socialflow-homolog` e `socialflow-production`):

1. Acesse o recurso correspondente (Docker Compose).
2. Na aba **Environment Variables**, configure:
   ```env
   SOCIALFLOW_IMAGE=ghcr.io/devarinoborba/socialflow:<SHA_COMPLETO>
   ```
3. O `compose.yaml` utiliza interpolação obrigatória (`:?`):
   - `image: ${SOCIALFLOW_IMAGE:?Set SOCIALFLOW_IMAGE}`
   - Se a variável estiver ausente, o Docker Compose abortará imediatamente a inicialização, impedindo qualquer deploy acidental sem imagem definida.

---

## 6. Procedimento de Deploy em Homologação

1. Conclua as alterações, commit e faça push para a branch `master`.
2. Aguarde a conclusão com sucesso da action de CI e publicação da imagem no GHCR.
3. Copie o SHA completo publicado.
4. No Coolify, abra o recurso de **Homologação** (`socialflow-homolog`).
5. Atualize a variável `SOCIALFLOW_IMAGE` com a nova tag do SHA.
6. Clique em **Redeploy**.

### Como Confirmar que Nenhum Build Ocorreu na VPS

Execute na VPS:

1. Verifique os logs operacionais do deployment no Coolify:
   - O log deve conter apenas etapas de pull: `Pulling migrate...`, `Pulling api...`, `Pulling worker...`, `Pulling web...`.
   - **Não deve haver** comandos `pnpm install`, `next build`, `tsc` ou `turbo`.
2. Verifique o tempo total do deploy:
   - O deploy levará menos de 30 segundos (tempo exclusivo de download da imagem e inicialização dos containers).
3. Verifique o cache do BuildKit na VPS:
   ```bash
   docker builder du
   ```
   - O contador de build cache permanecerá inalterado.

---

## 7. Procedimento de Promoção para Produção

Após homologação e validação completa no ambiente de teste:

1. Obtenha exatamente o mesmo valor de `SOCIALFLOW_IMAGE` testado e validado em homologação.
2. No Coolify, abra o recurso de **Produção** (`socialflow-production`).
3. Atualize a variável `SOCIALFLOW_IMAGE` com o mesmo SHA exato.
4. Clique em **Redeploy**.
5. **Garantia de Paridade:** Como a imagem é imutável e assinada pelo mesmo digest, homologação e produção executam rigorosamente os mesmos bytes binários.

---

## 8. Procedimento de Rollback Imediato

Se uma versão implantada apresentar instabilidade em produção ou homologação:

1. Identifique o SHA completo da versão anterior estável no histórico do Git ou nos pacotes do GHCR.
2. No Coolify, altere a variável `SOCIALFLOW_IMAGE` para o SHA anterior:
   ```env
   SOCIALFLOW_IMAGE=ghcr.io/devarinoborba/socialflow:<SHA_ANTERIOR>
   ```
3. Clique em **Redeploy**.
4. A reversão é imediata (menos de 20 segundos), pois o Docker reutilizará a imagem prévia em cache local ou fará download direto.

---

## 9. Como Provar que Web, API e Worker Usam a Mesma Imagem

Para auditar e provar matematicamente na VPS que todos os containers estão executando a mesma versão:

```bash
docker inspect --format '{{.Name}}: Image={{.Config.Image}} ImageID={{.Image}}' \
  $(docker ps -q --filter "name=socialflow")
```

**Resultado esperado:**

- Todos os containers (`api`, `web`, `worker`, `migrate`) devem exibir exatamente o mesmo `ImageID` (hash sha256 do Docker).

---

## 10. Como Revogar a Credencial de Leitura do GHCR

Caso o token configurado no Coolify precise ser rotacionado ou revogado:

1. No GitHub, acesse **Settings** ➔ **Developer Settings** ➔ **Personal access tokens** ➔ **Tokens (classic)**.
2. Localize o token `coolify-ghcr-reader` e clique em **Delete**.
3. Imediatamente o token perde a capacidade de autenticar no registro.
4. Crie um novo token com escopo `read:packages` e atualize a configuração no Coolify conforme a Seção 4.2.
