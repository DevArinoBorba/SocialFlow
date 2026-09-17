-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK_PAGE', 'INSTAGRAM_BUSINESS');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "PublicationAttemptStatus" AS ENUM ('PENDING', 'CONTAINER_CREATED', 'PUBLISHED', 'FAILED');

-- CreateTable SocialAccount
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "avatarUrl" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SocialAccount_name_len_check" CHECK (length(name) BETWEEN 1 AND 150),
    CONSTRAINT "SocialAccount_platformAccountId_len_check" CHECK (length("platformAccountId") BETWEEN 1 AND 120)
);

-- Indexes for SocialAccount
CREATE UNIQUE INDEX "SocialAccount_organizationId_id_key" ON "SocialAccount"("organizationId", "id");
CREATE UNIQUE INDEX "SocialAccount_organizationId_clientId_id_key" ON "SocialAccount"("organizationId", "clientId", "id");
CREATE UNIQUE INDEX "SocialAccount_org_client_platform_account_key" ON "SocialAccount"("organizationId", "clientId", "platform", "platformAccountId");
CREATE INDEX "SocialAccount_organizationId_clientId_status_idx" ON "SocialAccount"("organizationId", "clientId", "status");

-- ForeignKeys for SocialAccount
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable OAuthCredential
CREATE TABLE "OAuthCredential" (
    "id" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "tokenType" TEXT NOT NULL DEFAULT 'PAGE_ACCESS_TOKEN',
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastRefreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconnectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthCredential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OAuthCredential_token_check" CHECK (length("encryptedAccessToken") >= 1),
    CONSTRAINT "OAuthCredential_iv_check" CHECK (length(iv) >= 12),
    CONSTRAINT "OAuthCredential_authTag_check" CHECK (length("authTag") >= 16)
);

-- Indexes for OAuthCredential
CREATE UNIQUE INDEX "OAuthCredential_socialAccountId_key" ON "OAuthCredential"("socialAccountId");

-- ForeignKeys for OAuthCredential
ALTER TABLE "OAuthCredential" ADD CONSTRAINT "OAuthCredential_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable PublicationAttempt
CREATE TABLE "PublicationAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "status" "PublicationAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "creationContainerId" TEXT,
    "remoteMediaId" TEXT,
    "remotePermalink" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicationAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicationAttempt_attemptNumber_check" CHECK ("attemptNumber" >= 1)
);

-- Indexes for PublicationAttempt
CREATE UNIQUE INDEX "PublicationAttempt_organizationId_id_key" ON "PublicationAttempt"("organizationId", "id");
CREATE UNIQUE INDEX "PublicationAttempt_organizationId_clientId_id_key" ON "PublicationAttempt"("organizationId", "clientId", "id");
CREATE INDEX "PublicationAttempt_org_client_status_executedAt_idx" ON "PublicationAttempt"("organizationId", "clientId", "status", "executedAt");
CREATE INDEX "PublicationAttempt_postId_socialAccountId_idx" ON "PublicationAttempt"("postId", "socialAccountId");
CREATE INDEX "PublicationAttempt_creationContainerId_idx" ON "PublicationAttempt"("creationContainerId");

-- ForeignKeys for PublicationAttempt
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_org_client_postId_fkey" FOREIGN KEY ("organizationId", "clientId", "postId") REFERENCES "Post"("organizationId", "clientId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_org_client_socialAccountId_fkey" FOREIGN KEY ("organizationId", "clientId", "socialAccountId") REFERENCES "SocialAccount"("organizationId", "clientId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS and Policies for SocialAccount
ALTER TABLE "SocialAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SocialAccount" FORCE ROW LEVEL SECURITY;

CREATE POLICY social_account_read ON "SocialAccount" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  );

CREATE POLICY social_account_create ON "SocialAccount" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  );

CREATE POLICY social_account_update ON "SocialAccount" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  );

-- RLS and Policies for OAuthCredential
ALTER TABLE "OAuthCredential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OAuthCredential" FORCE ROW LEVEL SECURITY;

CREATE POLICY oauth_credential_read ON "OAuthCredential" FOR SELECT TO socialflow_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND can_edit_client(sa."organizationId", sa."clientId")
        AND c.active
    )
  );

CREATE POLICY oauth_credential_create ON "OAuthCredential" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND can_edit_client(sa."organizationId", sa."clientId")
        AND c.active
    )
  );

CREATE POLICY oauth_credential_update ON "OAuthCredential" FOR UPDATE TO socialflow_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND can_edit_client(sa."organizationId", sa."clientId")
        AND c.active
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND can_edit_client(sa."organizationId", sa."clientId")
        AND c.active
    )
  );

-- RLS and Policies for PublicationAttempt
ALTER TABLE "PublicationAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicationAttempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY publication_attempt_read ON "PublicationAttempt" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  );

CREATE POLICY publication_attempt_create ON "PublicationAttempt" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  );

CREATE POLICY publication_attempt_update ON "PublicationAttempt" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  );

-- Triggers for scope protection
CREATE FUNCTION protect_social_account_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."platform" IS DISTINCT FROM OLD."platform" OR NEW."platformAccountId" IS DISTINCT FROM OLD."platformAccountId" THEN
    RAISE EXCEPTION 'SocialAccount scope and identity are immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_social_account_scope BEFORE UPDATE ON "SocialAccount" FOR EACH ROW EXECUTE FUNCTION protect_social_account_scope();

CREATE FUNCTION protect_publication_attempt_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."postId" IS DISTINCT FROM OLD."postId" OR NEW."socialAccountId" IS DISTINCT FROM OLD."socialAccountId" THEN
    RAISE EXCEPTION 'PublicationAttempt scope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_publication_attempt_scope BEFORE UPDATE ON "PublicationAttempt" FOR EACH ROW EXECUTE FUNCTION protect_publication_attempt_scope();

-- Grants for socialflow_runtime
GRANT SELECT, INSERT ON "SocialAccount", "OAuthCredential", "PublicationAttempt" TO socialflow_runtime;
GRANT UPDATE (name, username, "avatarUrl", status, metadata, "updatedAt") ON "SocialAccount" TO socialflow_runtime;
GRANT UPDATE ("encryptedAccessToken", iv, "authTag", "keyVersion", "tokenType", scopes, "expiresAt", "lastRefreshedAt", "reconnectReason", "updatedAt") ON "OAuthCredential" TO socialflow_runtime;
GRANT UPDATE (status, "creationContainerId", "remoteMediaId", "remotePermalink", "errorCode", "errorMessage", "attemptNumber", "executedAt", "updatedAt") ON "PublicationAttempt" TO socialflow_runtime;

-- Revise AuditLog RLS policies to support SocialAccount and PublicationAttempt entities
DROP POLICY audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR ("actorUserId" = current_actor() AND (
    can_read_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_read_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_read_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_read_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_read_client(p."organizationId", p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id = "AuditLog"."entityId" AND sa."organizationId" = "AuditLog"."organizationId" AND can_read_client(sa."organizationId", sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id = "AuditLog"."entityId" AND pa."organizationId" = "AuditLog"."organizationId" AND can_read_client(pa."organizationId", pa."clientId"))
  ))
);

DROP POLICY audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_edit_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_edit_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_edit_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_interact_post(p."organizationId", p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id = "AuditLog"."entityId" AND sa."organizationId" = "AuditLog"."organizationId" AND can_edit_client(sa."organizationId", sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id = "AuditLog"."entityId" AND pa."organizationId" = "AuditLog"."organizationId" AND can_edit_client(pa."organizationId", pa."clientId"))
  )
);
