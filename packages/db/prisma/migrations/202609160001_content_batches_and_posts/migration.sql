-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateTable ContentBatch
CREATE TABLE "ContentBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'CSV',
    "status" "BatchStatus" NOT NULL DEFAULT 'PENDING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "errorReport" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContentBatch_name_len_check" CHECK (length(name) BETWEEN 2 AND 120),
    CONSTRAINT "ContentBatch_counts_check" CHECK ("totalRows" >= 0 AND "validRows" >= 0 AND "invalidRows" >= 0)
);

-- Indexes for ContentBatch
CREATE UNIQUE INDEX "ContentBatch_organizationId_id_key" ON "ContentBatch"("organizationId", "id");
CREATE UNIQUE INDEX "ContentBatch_organizationId_clientId_id_key" ON "ContentBatch"("organizationId", "clientId", "id");
CREATE INDEX "ContentBatch_organizationId_clientId_createdAt_idx" ON "ContentBatch"("organizationId", "clientId", "createdAt");

-- ForeignKeys for ContentBatch
ALTER TABLE "ContentBatch" ADD CONSTRAINT "ContentBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentBatch" ADD CONSTRAINT "ContentBatch_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable Post
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT,
    "brandId" TEXT,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "caption" TEXT NOT NULL,
    "hashtags" TEXT,
    "callToAction" TEXT,
    "firstComment" TEXT,
    "suggestedDate" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Post_caption_len_check" CHECK (length(caption) BETWEEN 1 AND 5000),
    CONSTRAINT "Post_title_len_check" CHECK (title IS NULL OR length(title) <= 120),
    CONSTRAINT "Post_hashtags_len_check" CHECK (hashtags IS NULL OR length(hashtags) <= 1000),
    CONSTRAINT "Post_cta_len_check" CHECK ("callToAction" IS NULL OR length("callToAction") <= 500),
    CONSTRAINT "Post_comment_len_check" CHECK ("firstComment" IS NULL OR length("firstComment") <= 2200),
    CONSTRAINT "Post_rejection_len_check" CHECK ("rejectionReason" IS NULL OR length("rejectionReason") <= 2000)
);

-- Indexes for Post
CREATE UNIQUE INDEX "Post_organizationId_id_key" ON "Post"("organizationId", "id");
CREATE UNIQUE INDEX "Post_organizationId_clientId_id_key" ON "Post"("organizationId", "clientId", "id");
CREATE INDEX "Post_organizationId_clientId_status_createdAt_idx" ON "Post"("organizationId", "clientId", "status", "createdAt");
CREATE INDEX "Post_organizationId_clientId_batchId_idx" ON "Post"("organizationId", "clientId", "batchId");

-- ForeignKeys for Post
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_clientId_batchId_fkey" FOREIGN KEY ("organizationId", "clientId", "batchId") REFERENCES "ContentBatch"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_organizationId_clientId_brandId_fkey" FOREIGN KEY ("organizationId", "clientId", "brandId") REFERENCES "Brand"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- RLS and Policies for ContentBatch
ALTER TABLE "ContentBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ContentBatch" FORCE ROW LEVEL SECURITY;

CREATE POLICY batch_read ON "ContentBatch" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "ContentBatch"."clientId"
        AND c."organizationId" = "ContentBatch"."organizationId"
        AND c.active
    )
  );

CREATE POLICY batch_create ON "ContentBatch" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "ContentBatch"."clientId"
        AND c."organizationId" = "ContentBatch"."organizationId"
        AND c.active
    )
  );

CREATE POLICY batch_update ON "ContentBatch" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "ContentBatch"."clientId"
        AND c."organizationId" = "ContentBatch"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "ContentBatch"."clientId"
        AND c."organizationId" = "ContentBatch"."organizationId"
        AND c.active
    )
  );

-- RLS and Policies for Post
ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Post" FORCE ROW LEVEL SECURITY;

CREATE POLICY post_read ON "Post" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  );

CREATE POLICY post_create ON "Post" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  );

CREATE POLICY post_update ON "Post" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  );

-- Triggers for scope protection
CREATE FUNCTION protect_batch_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" THEN
    RAISE EXCEPTION 'Batch scope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_batch_scope BEFORE UPDATE ON "ContentBatch" FOR EACH ROW EXECUTE FUNCTION protect_batch_scope();

CREATE FUNCTION protect_post_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."batchId" IS DISTINCT FROM OLD."batchId" THEN
    RAISE EXCEPTION 'Post scope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_post_scope BEFORE UPDATE ON "Post" FOR EACH ROW EXECUTE FUNCTION protect_post_scope();

-- Grants for socialflow_runtime
GRANT SELECT, INSERT ON "ContentBatch" TO socialflow_runtime;
GRANT UPDATE (name, "sourceType", status, "totalRows", "validRows", "invalidRows", "errorReport", "updatedAt") ON "ContentBatch" TO socialflow_runtime;

GRANT SELECT, INSERT ON "Post" TO socialflow_runtime;
GRANT UPDATE (title, caption, hashtags, "callToAction", "firstComment", "suggestedDate", "rejectionReason", status, "brandId", "updatedAt") ON "Post" TO socialflow_runtime;

-- Revise AuditLog RLS policies to support ContentBatch and Post entities
DROP POLICY audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR ("actorUserId" = current_actor() AND (
    can_read_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_read_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_read_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_read_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_read_client(p."organizationId", p."clientId"))
  ))
);

DROP POLICY audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_edit_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_edit_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_edit_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_edit_client(p."organizationId", p."clientId"))
  )
);
