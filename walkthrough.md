# Walkthrough: Revisão e Endurecimento da Publicação Manual (Fase 3)

Este documento descreve a arquitetura final, a estratégia de segurança, os fluxos por plataforma e os testes executados para a funcionalidade de publicação manual controlada na Meta (Facebook e Instagram) no SocialFlow, revisada após o commit `3095c0b`.

---

## 1. Arquitetura Final

A arquitetura de publicação foi dividida em três etapas estritamente desacopladas para evitar locks transacionais longos, respeitar timeouts de banco de dados e garantir atomicidade e isolamento multi-tenant:

```
[Cliente HTTP]
      │ POST /publish (com idempotencyKey)
      ▼
[Etapa 1: Transação Curta no PostgreSQL (asActor / RLS)]
   - Validação de Post APPROVED
   - Validação de pertencimento das Contas Sociais ao Cliente
   - Verificação de tentativas prévias (PUBLISHED / PENDING / UNCERTAIN)
   - Decriptação dos tokens OAuth em memória
   - Reserva da tentativa em estado PROCESSING (rejeita concorrência via partial unique index)
      │
      ▼ (Fim da transação DB - conexão liberada)
[Etapa 2: Chamadas Externas à Meta Graph API (Fora de Transação)]
   - Criação de Ticket de Mídia Opaco no Redis (TTL de 60m)
   - Chamadas HTTP isoladas para cada plataforma (Facebook / Instagram)
   - Header Authorization: Bearer <token> (URLs 100% limpas de segredos)
   - Polling de processamento de container Instagram (se aplicável)
   - Captura de timeouts -> estado UNCERTAIN para reconciliação
   - Captura de erro 190 -> marcação da conta como EXPIRED
      │
      ▼
[Etapa 3: Transações Curtas de Finalização e Auditoria (asActor / RLS)]
   - Transação curta para persistir PUBLISHED, UNCERTAIN ou FAILED
   - Registro de container criado (CONTAINER_CREATED) em transação atômica própria
   - Registro de auditoria em AuditLog para cada transição
   - Cache da resposta final no Redis (TTL 24h)
```

---

## 2. Fluxo de Publicação por Plataforma

### 2.1 Facebook Page

- **Texto e Imagem**: Chamada `POST /v21.0/{page-id}/photos` com `caption` e `url` (apontando para o endpoint público opaco).
- **Apenas Texto**: Chamada `POST /v21.0/{page-id}/feed` com `message`.
- **Cabeçalho**: `Authorization: Bearer <page_access_token>`.
- **Retorno**: Extração de `postId` e composição do `permalink` canônico (`https://www.facebook.com/{postId}`).

### 2.2 Instagram Business

- **Pré-requisito**: Exige obrigatoriamente uma imagem aprovada da biblioteca de mídia.
- **Verificação de Container Existente**:
  - Se a tentativa anterior falhou mas registrou um `creationContainerId`, a retomada primeiro consulta `GET /v21.0/{container-id}?fields=status_code,status`.
  - Se o container estiver `FINISHED`, não recria o container e avança diretamente para a publicação.
  - Se estiver `IN_PROGRESS`, continua o polling do container existente.
  - Se estiver `EXPIRED` ou `ERROR`, descarta o container e cria um novo.
- **Criação do Container**: `POST /v21.0/{ig-user-id}/media` com `image_url` e `caption`. Registra imediatamente `creationContainerId` e status `CONTAINER_CREATED` no banco em transação curta.
- **Polling**: Aguarda status `FINISHED` com intervalo configurável (`pollDelayMs`) e limite de tentativas (`pollMaxAttempts`).
- **Publicação**: `POST /v21.0/{ig-user-id}/media_publish` com `creation_id`.
- **Permalink**: Consulta adicional a `GET /v21.0/{media-id}?fields=permalink` para salvar o link público no Instagram.

---

## 3. Estados e Retomadas

### 3.1 Ciclo de Estados (`PublicationAttemptStatus`)

- `PENDING`: Tentativa reservada inicial.
- `PROCESSING`: Tentativa ativamente em execução (reserva no PostgreSQL).
- `CONTAINER_CREATED`: Container de mídia criado no Instagram; aguardando conclusão do processamento remoto.
- `PUBLISHED`: Publicação confirmada na Meta com ID remoto e permalink.
- `FAILED`: Falha conclusiva identificada (ex.: erro de permissão, formato incompatível, token revogado).
- `UNCERTAIN`: Resultado incerto na Meta (ex.: timeout de conexão, gateway timeout 504).
- `EXPIRED`: Status da conta social quando a Meta retorna erro de autorização 190.

### 3.2 Regras de Retomada

- **Tentativa `PUBLISHED`**: Bloqueio total. Nenhuma publicação subsequente é permitida para aquele `postId + socialAccountId` (retorna HTTP 409).
- **Tentativa Ativa (`PENDING`, `PROCESSING`, `CONTAINER_CREATED`, `UNCERTAIN`)**: Bloqueia qualquer execução concorrente (retorna HTTP 409).
- **Tentativa `FAILED`**: Retomada permitida de forma explícita. O novo registro recebe `attemptNumber = previous.attemptNumber + 1`. Se houver container Instagram criado anteriormente, o status do container é verificado antes de criar outro.

---

## 4. Estratégia de Idempotência

A idempotência foi implementada em duas camadas complementares:

1. **Camada HTTP (Redis)**:
   - Chave: `meta:publish:idempotency:{org}:{clientId}:{postId}:{idempotencyKey}`.
   - Bloqueia duplo clique e repetições imediatas via `SET NX` com TTL de 24h.
   - Retorna o resultado em cache caso a mesma chave seja reenviada após conclusão.

2. **Camada Persistente no PostgreSQL (Restrições de Integridade e Índices Únicos Parciais)**:
   - `PublicationAttempt_single_published_idx`:
     ```sql
     CREATE UNIQUE INDEX "PublicationAttempt_single_published_idx"
     ON "PublicationAttempt" ("postId", "socialAccountId")
     WHERE "status" = 'PUBLISHED';
     ```
     Garante que mesmo que o cliente envie um novo `idempotencyKey` diferente, o banco de dados rejeita qualquer tentativa duplicada para um post já publicado na mesma conta.
   - `PublicationAttempt_single_active_idx`:
     ```sql
     CREATE UNIQUE INDEX "PublicationAttempt_single_active_idx"
     ON "PublicationAttempt" ("postId", "socialAccountId")
     WHERE "status" IN ('PENDING', 'PROCESSING', 'CONTAINER_CREATED', 'UNCERTAIN');
     ```
     Impede corridas e execuções concorrentes entre instâncias paralelas da API, garantindo exclusão mútua na reserva da publicação.

---

## 5. Tratamento de Resultado Remoto Incerto

Quando ocorre uma falha na chamada de publicação final onde não é possível determinar se a Meta processou ou não a postagem (timeouts de rede `ETIMEDOUT`, `ECONNRESET`, erros `AbortError` ou respostas HTTP 504 / 502):

- A tentativa **não** é marcada como `FAILED`.
- O status é registrado como `UNCERTAIN` com código `REMOTE_TIMEOUT`.
- A restrição única parcial no PostgreSQL mantém a conta bloqueada para novas tentativas cegas daquele mesmo post.
- Um registro é inserido no `AuditLog` com a ação `post.publish_uncertain`.
- Permite futura reconciliação por rotina de diagnóstico ou intervenção manual sem risco de post duplicado na rede social.

---

## 6. Segurança dos Tokens e da Mídia

### 6.1 Remoção Total de Tokens das URLs

- Todas as requisições GET e POST à Meta Graph API utilizam o cabeçalho `Authorization: Bearer <token>`.
- Nenhuma URL ou query string contém `access_token`.
- As mensagens de erro e respostas passam por sanitização defensiva (`sanitizeMessage`) que remove padrões de tokens OAuth da Meta antes de qualquer registro em log ou resposta HTTP.

### 6.2 Identificador de Mídia Público Opaco

- O endereço público de mídia substitui o token Base64 anterior por um identificador opaco aleatório de 256 bits criptograficamente seguro (64 caracteres hexadecimais gerados via `crypto.randomBytes(32)`).
- Os metadados de localização e validação (`storageKey`, `mimeType`, `byteSize`, `sha256`) são persistidos no Redis sob a chave `socialflow:media-ticket:{ticketId}` com TTL estrito de 60 minutos.
- A leitura é não-destrutiva para permitir que os servidores da Meta realizem múltiplos downloads durante o processamento do container.
- O endpoint `/api/public/media/:ticketId` valida tamanho e hash SHA-256 da imagem antes de servi-la.
- Requisições com ticket inválido ou expirado retornam HTTP 404 genérico sem expor credenciais de armazenamento, caminhos S3 ou identificadores internos de tenant.

---

## 7. Testes Executados

### 7.1 Testes Unitários

- **`tests/unit/meta-publisher.test.ts`**:
  - Confirmação de cabeçalho `Authorization: Bearer <token>` em todas as rotas (fotos, feed, containers, permalinks).
  - Ausência total de tokens em URLs, query params ou corpos de requisição.
  - Sanitização de tokens em mensagens de erro de autenticação (código 190).
  - Retomada de container Instagram `FINISHED` sem criar novo container.
  - Recriação de container Instagram se o anterior estiver `EXPIRED` ou com `ERROR`.
  - Tratamento de timeout com conversão para `MetaTimeoutError`.
- **`tests/unit/media-ticket.test.ts`**:
  - Geração de ticket opaco com 64 caracteres hexadecimais e TTL de 3600 segundos.
  - Múltiplos downloads válidos sem deleção da chave no Redis.
  - Rejeição e retorno `null` para tickets com formato adulterado, inválido ou expirado.

### 7.2 Testes de Integração

- **`tests/integration/publication.test.ts`**:
  - Duas requisições simultâneas com a mesma chave: concorrência controlada e 1 tentativa criada.
  - Duas requisições com chaves diferentes para o mesmo post e conta: rejeição com HTTP 409 após publicação concluída.
  - Retomada controlada após falha: incremento correto de `attemptNumber = 2` e conclusão com sucesso.
  - Instagram com `creationContainerId` prévio: reutilização do container sem recriação.
  - Resultado remoto incerto após timeout: gravação do status `UNCERTAIN` e bloqueio de novas tentativas até reconciliação.
  - Falha parcial entre Facebook e Instagram: gravação independente de status e marcação da conta expirada como `EXPIRED`.
  - Endpoint de mídia pública: teste de downloads múltiplos no TTL, integridade binária e resposta 404 para identificador expirado/adulterado.
  - Confirmação de que chamadas externas não ocorrem dentro de uma transação longa: hook no momento da publicação comprova que o estado `PROCESSING` já está comitado no banco e outras transações ocorrem livremente sem espera por lock.

---

## 8. Limitações Conhecidas

1. **Reconciliação Automática de Estados `UNCERTAIN`**: O estado `UNCERTAIN` bloqueia novas publicações automáticas duplicadas. A rotina automática de conciliação ativa via consulta de feed da Meta será implementada no próximo incremento de jobs agendados.
2. **Vídeos no Instagram**: O incremento atual contempla publicações de imagens estáticas (JPEG/PNG/WebP) e textos. A publicação de vídeos ou carrosséis em contas de Instagram Business exigirá adaptação para containers do tipo `REELS` ou `CAROUSEL`.
3. **Imutabilidade de Posts Publicados**: Uma vez publicado com sucesso (`PUBLISHED`), o SocialFlow proíbe republicações acidentais do mesmo post na mesma conta social pelo endpoint manual. Para reenviar o mesmo conteúdo, deve-se duplicar o post criando uma nova entidade com status `DRAFT` / `APPROVED`.
