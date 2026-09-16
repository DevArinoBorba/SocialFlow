# Biblioteca de imagens — implementação local

Data: 15/09/2026. Incremento da Fase 2, posterior ao cadastro textual de marcas.

## Escopo e decisões

Imagens JPEG/PNG/WebP estáticas até 10 MiB e 25 milhões de pixels. Cadastro
por cliente com marca opcional, listagem de 24 itens por página, filtro por
marca, preview autenticado, edição de metadados e arquivamento por administrador.
Não há exclusão física, publicação social ou alteração da infraestrutura real.

O banco garante o vínculo composto organização/cliente/marca, RLS e FORCE RLS,
escopo e chave imutáveis. EDITOR gerencia metadados e envia nos clientes vinculados;
OWNER/ADMIN também arquivam. APPROVER/CLIENT_VIEWER apenas leem. Auditoria é
transacional com cada alteração. Revogação e entidades inativas são consultadas
novamente nas operações, inclusive antes de servir bytes já buscados do storage.

O upload usa reserva JSON e envio binário autenticado pela API. Dois uploads
simultâneos por processo, limite de 10 MiB no proxy e na API, decodificação
completa e re-encode pelo sharp removem metadados e rejeitam conteúdo inválido.
Somente o resultado validado é armazenado, em chave aleatória com escrita
condicional If-None-Match. Não existe URL de escrita reutilizável no navegador.
Repetir uma confirmação concluída retorna 409; não duplica objeto/evento created.

O fluxo é pending → uploading → ready. Quando uma falha de gravação no
armazenamento ou de confirmação no banco ocorre e o chamador permanece autorizado,
a aplicação tenta transicionar o registro para failed e registrar media.upload_failed.
Caso a autorização tenha sido revogada ou o banco esteja indisponível, a aplicação não
utiliza privilégios elevados nem garante a transição para failed: emite logs operacionais
(media_upload_failed e media_reconciliation_needed com assetId, storageKey e correlationId),
preservando o erro original para o cliente. Nesses cenários, o registro pode permanecer
em uploading e o objeto privado deve ser reconciliado pelo operador; nenhum registro em
uploading ou failed é publicado ou servido. Reservas vencem para confirmação após uma hora;
não há limpeza física automática. A API limita a 20 reservas recentes pendentes por cliente.
Não existem gatilhos remotos de falha ou manipulação de estado via cabeçalhos HTTP na aplicação;
cenários de falha são testados via injeção de dependências substituíveis (`registerMedia(server, scoped, deps)`)
e revogação determinística real no PostgreSQL pela conexão administrativa do harness. O bootstrap normal
sempre utiliza dependências reais. O identificador de correlação operacional (`correlationId`) utiliza
prioritariamente o identificador soberano gerado pelo servidor (`X-Request-Id` ou `randomUUID()` v4 aleatório);
qualquer cabeçalho fornecido pelo cliente é rigorosamente sanitizado e mantido separado como `clientCorrelationId`.

Imagens são servidas por rota autenticada same-origin, com no-store e nosniff.
URLs não são persistidas nem emitidas como credenciais portadoras. Revogação
bloqueia novas requisições; não apaga bytes que o usuário já recebeu.
O custo dessa decisão é tráfego e processamento na API; medir antes de ampliar
limites, introduzir upload direto ou processamento em workers.

## Configuração para homologação

Definir apenas no serviço api as quatro variáveis MEDIA_S3_ENDPOINT,
MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID e MEDIA_S3_SECRET_ACCESS_KEY.
Bucket privado dedicado a mídia, diferente de socialflow-backups; token
exclusivo com leitura/escrita nesse bucket. HTTPS obrigatório em produção.
Não reutilizar credenciais de backup. Sem configuração, a biblioteca informa
indisponibilidade e a fundação continua funcionando. Nenhuma credencial real
ou bucket foi criado por esta implementação.

compose.test.yaml inclui MinIO exclusivamente local, sem porta pública ou
volume compartilhado com dados existentes. As credenciais desse serviço são
fixtures públicas de teste e não podem ser usadas na homologação.

## Recuperação e arquivos abandonados

O fingerprint operacional agora inclui MediaAsset; são cinco migrations e seis
tabelas com RLS verificados pelo ensaio da fundação. Isso cobre metadados apenas.
Antes de usar mídia real, implementar e validar cópia independente dos objetos
do bucket privado, incluindo arquivados. Uma política que apenas espelha
exclusões não basta como backup. Registrar chave, hash, tamanho e ponto temporal
do banco; recuperar para bucket isolado e verificar cada objeto referenciado
por registros ready contra sha256/byteSize antes de liberar a aplicação.

A chave de storage é imutável e arquivamento não remove objetos; esses atributos
facilitam cópias incrementais. RPO/RTO do backup anterior não se estendem aos
objetos automaticamente. A homologação de mídia real fica pendente dessa
proteção, das credenciais dedicadas e de revisão independente.

Não alterar os scripts de backup em edição por outro agente. A atualização
operacional aqui está em scripts/verify-operations.ts e neste relatório.

## Validação

Resultados finais serão registrados após o ensaio isolado. Não houve commit,
push, deploy, migração na VPS ou modificação de volumes existentes.
