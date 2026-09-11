# Modelo inicial

Organization - id, name, createdAt

Client - id, organizationId, name, slug, status

User - id, email, passwordHash/identityProvider, status

Membership - id, userId, organizationId, clientId nullable, role

Brand - id, clientId, name, timezone, locale

SocialAccount - id, clientId, brandId, provider, externalAccountId,
displayName, status

OAuthCredential - id, socialAccountId, encryptedAccessToken,
encryptedRefreshToken nullable, expiresAt, scopes

MediaAsset - id, clientId, storageKey, mimeType, width, height,
duration, checksum

Template - id, clientId nullable, name, type, definitionJson, version

ContentBatch - id, clientId, brandId, source, status

Post - id, clientId, brandId, batchId nullable, status, scheduledAt,
timezone

PostVariant - id, postId, provider, caption, settingsJson

PublicationAttempt - id, postId, socialAccountId, idempotencyKey UNIQUE,
attempt, status, remotePostId, errorCode, errorJson

MetricSnapshot - id, clientId, postId, provider, capturedAt, metricsJson

AuditLog - id, organizationId, clientId nullable, actorUserId nullable,
action, entityType, entityId, metadataJson, createdAt

Todos os índices/uniques e relações devem ser definidos na
implementação. Toda leitura/escrita de entidade de cliente precisa de
tenant scope no servidor.
