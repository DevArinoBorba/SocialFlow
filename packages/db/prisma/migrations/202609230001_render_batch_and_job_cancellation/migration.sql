-- ==============================================================================
-- Migration: 202609230001_render_batch_and_job_cancellation
-- Increment 3 - Phase 6: Batch Artwork Generation, Deduplication, and Cooperative Cancellation
--
-- Compatibility & Safety Notes:
-- 1. Target Engine: PostgreSQL 17.
-- 2. Transaction Compatibility: Executed within standard Prisma migration runner.
--    No CREATE INDEX CONCURRENTLY is used because PostgreSQL disallows concurrent
--    index creation inside multi-statement transaction blocks.
-- 3. Enum Rollback Limitation: In PostgreSQL, ALTER TYPE ... ADD VALUE cannot be
--    reversed with ALTER TYPE ... DROP VALUE. To roll back an added enum value in
--    production, a replacement enum type must be created, tables migrated, and the
--    old type dropped.
-- 4. Rollback Plan:
--    a. DROP TRIGGER trg_protect_render_batch_scope ON "RenderBatch";
--    b. DROP FUNCTION protect_render_batch_scope();
--    c. DROP FUNCTION discover_active_render_batches();
--    d. Revert renderer_can_audit(), audit_create, audit_read, render_job_create, render_job_update.
--    e. DROP TABLE "RenderBatch" CASCADE;
--    f. ALTER TABLE "RenderJob" DROP COLUMN "batchId";
--    g. DROP TYPE "RenderBatchStatus";
--    h. DROP TYPE "RenderBatchSourceType";
-- ==============================================================================

-- 1. Expand RenderJobStatus enum to support cooperative cancellation
ALTER TYPE "RenderJobStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- 2. Enums for RenderBatch
CREATE TYPE "RenderBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'CANCELLING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED');
CREATE TYPE "RenderBatchSourceType" AS ENUM ('POSTS_SELECTION', 'CONTENT_BATCH');

-- 3. Create RenderBatch table
CREATE TABLE "RenderBatch" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "templateVersionId" TEXT NOT NULL,
  "sourceType" "RenderBatchSourceType" NOT NULL DEFAULT 'POSTS_SELECTION',
  "contentBatchId" TEXT,
  "parentBatchId" TEXT,
  "format" "DesignFormat" NOT NULL,
  "status" "RenderBatchStatus" NOT NULL DEFAULT 'PENDING',
  "requestHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "totalItems" INTEGER NOT NULL,
  "pendingItems" INTEGER NOT NULL,
  "processingItems" INTEGER NOT NULL DEFAULT 0,
  "completedItems" INTEGER NOT NULL DEFAULT 0,
  "failedItems" INTEGER NOT NULL DEFAULT 0,
  "cancelledItems" INTEGER NOT NULL DEFAULT 0,
  "cancelRequestedAt" TIMESTAMP(3),
  "cancelCompletedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RenderBatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RenderBatch_totalItems_positive" CHECK ("totalItems" > 0),
  CONSTRAINT "RenderBatch_counters_nonnegative" CHECK (
    "pendingItems" >= 0 AND "processingItems" >= 0 AND "completedItems" >= 0 AND "failedItems" >= 0 AND "cancelledItems" >= 0
  )
);

-- 4. Add batchId to RenderJob
ALTER TABLE "RenderJob" ADD COLUMN "batchId" TEXT;

-- 5. Indexes
CREATE UNIQUE INDEX "RenderBatch_organizationId_id_key" ON "RenderBatch"("organizationId", "id");
CREATE UNIQUE INDEX "RenderBatch_organizationId_clientId_id_key" ON "RenderBatch"("organizationId", "clientId", "id");
CREATE UNIQUE INDEX "RenderBatch_organizationId_clientId_idempotencyKey_key" ON "RenderBatch"("organizationId", "clientId", "idempotencyKey");
CREATE INDEX "RenderBatch_organizationId_clientId_status_createdAt_idx" ON "RenderBatch"("organizationId", "clientId", "status", "createdAt");
CREATE INDEX "RenderBatch_organizationId_clientId_parentBatchId_idx" ON "RenderBatch"("organizationId", "clientId", "parentBatchId");

CREATE INDEX "RenderJob_organizationId_clientId_batchId_status_idx" ON "RenderJob"("organizationId", "clientId", "batchId", "status");

-- 6. Foreign Keys
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_organizationId_clientId_templateVersionId_fkey" FOREIGN KEY ("organizationId", "clientId", "templateVersionId") REFERENCES "DesignTemplateVersion"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_organizationId_clientId_contentBatchId_fkey" FOREIGN KEY ("organizationId", "clientId", "contentBatchId") REFERENCES "ContentBatch"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_organizationId_clientId_parentBatchId_fkey" FOREIGN KEY ("organizationId", "clientId", "parentBatchId") REFERENCES "RenderBatch"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderBatch" ADD CONSTRAINT "RenderBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_batchId_fkey" FOREIGN KEY ("organizationId", "clientId", "batchId") REFERENCES "RenderBatch"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 7. Row Level Security for RenderBatch
ALTER TABLE "RenderBatch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RenderBatch" FORCE ROW LEVEL SECURITY;

CREATE POLICY render_batch_read ON "RenderBatch" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId")
);

CREATE POLICY render_batch_create ON "RenderBatch" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId") AND status = 'PENDING' AND "createdById" = current_actor()
  AND "processingItems" = 0 AND "completedItems" = 0 AND "failedItems" = 0 AND "cancelledItems" = 0
  AND "cancelRequestedAt" IS NULL AND "cancelCompletedAt" IS NULL AND "completedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "DesignTemplateVersion" v WHERE v.id = "RenderBatch"."templateVersionId" AND v."organizationId" = "RenderBatch"."organizationId" AND v."clientId" = "RenderBatch"."clientId")
  AND ("contentBatchId" IS NULL OR EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "RenderBatch"."contentBatchId" AND cb."organizationId" = "RenderBatch"."organizationId" AND cb."clientId" = "RenderBatch"."clientId"))
  AND ("parentBatchId" IS NULL OR EXISTS (SELECT 1 FROM "RenderBatch" prb WHERE prb.id = "RenderBatch"."parentBatchId" AND prb."organizationId" = "RenderBatch"."organizationId" AND prb."clientId" = "RenderBatch"."clientId"))
);

CREATE POLICY render_batch_update ON "RenderBatch" FOR UPDATE TO socialflow_runtime USING (
  can_edit_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId")
) WITH CHECK (
  can_edit_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId")
);

-- 8. Protect RenderBatch scope & immutability trigger
CREATE OR REPLACE FUNCTION protect_render_batch_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId"
    OR NEW."sourceType" IS DISTINCT FROM OLD."sourceType"
    OR NEW."contentBatchId" IS DISTINCT FROM OLD."contentBatchId"
    OR NEW."parentBatchId" IS DISTINCT FROM OLD."parentBatchId"
    OR NEW."format" IS DISTINCT FROM OLD."format"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."totalItems" IS DISTINCT FROM OLD."totalItems"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'RenderBatch scope, fingerprint and specification are immutable' USING ERRCODE='42501';
  END IF;

  -- Protect counters: only system:renderer or authorized background actor can update counters and completion timestamps
  IF current_setting('app.user_id', true) IS DISTINCT FROM 'system:renderer' THEN
    IF NEW."pendingItems" IS DISTINCT FROM OLD."pendingItems"
      OR NEW."processingItems" IS DISTINCT FROM OLD."processingItems"
      OR NEW."completedItems" IS DISTINCT FROM OLD."completedItems"
      OR NEW."failedItems" IS DISTINCT FROM OLD."failedItems"
      OR NEW."cancelledItems" IS DISTINCT FROM OLD."cancelledItems"
      OR NEW."cancelCompletedAt" IS DISTINCT FROM OLD."cancelCompletedAt"
      OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
      RAISE EXCEPTION 'Counters and completion timestamps are protected and can only be updated by the renderer' USING ERRCODE='42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_render_batch_scope BEFORE UPDATE ON "RenderBatch" FOR EACH ROW EXECUTE FUNCTION protect_render_batch_scope();

-- 9. Update protect_render_job_scope to protect batchId
CREATE OR REPLACE FUNCTION protect_render_job_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId"
    OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
    OR NEW."postId" IS DISTINCT FROM OLD."postId"
    OR NEW."backgroundMediaAssetId" IS DISTINCT FROM OLD."backgroundMediaAssetId"
    OR NEW."logoMediaAssetId" IS DISTINCT FROM OLD."logoMediaAssetId"
    OR NEW."input" IS DISTINCT FROM OLD."input"
    OR NEW."inputHash" IS DISTINCT FROM OLD."inputHash"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'RenderJob scope and input are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- 10. Update render_job_create to validate batchId relation
DROP POLICY IF EXISTS render_job_create ON "RenderJob";
CREATE POLICY render_job_create ON "RenderJob" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId")
  AND status='PENDING' AND "attemptNumber"=0 AND "createdById"=current_actor()
  AND "queueJobId" IS NULL AND "executionToken" IS NULL AND "leaseExpiresAt" IS NULL
  AND "outputMediaAssetId" IS NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "completedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "DesignTemplateVersion" v WHERE v.id="RenderJob"."templateVersionId" AND v."organizationId"="RenderJob"."organizationId" AND v."clientId"="RenderJob"."clientId")
  AND ("batchId" IS NULL OR EXISTS (SELECT 1 FROM "RenderBatch" rb WHERE rb.id="RenderJob"."batchId" AND rb."organizationId"="RenderJob"."organizationId" AND rb."clientId"="RenderJob"."clientId"))
  AND ("postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id="RenderJob"."postId" AND p."organizationId"="RenderJob"."organizationId" AND p."clientId"="RenderJob"."clientId"))
  AND ("backgroundMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."backgroundMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND m.status='ready' AND NOT m.archived))
  AND ("logoMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."logoMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND m.status='ready' AND NOT m.archived))
);

-- 11. Update render_job_update to allow cancellation of PENDING jobs by authorized users
DROP POLICY IF EXISTS render_job_update ON "RenderJob";
CREATE POLICY render_job_update ON "RenderJob" FOR UPDATE TO socialflow_runtime
USING (
  renderer_in_scope("organizationId", "clientId")
  OR (can_edit_client("organizationId", "clientId") AND status = 'PENDING')
)
WITH CHECK (
  renderer_in_scope("organizationId", "clientId")
  OR (can_edit_client("organizationId", "clientId") AND status = 'CANCELLED' AND "executionToken" IS NULL AND "outputMediaAssetId" IS NULL AND "completedAt" IS NULL)
);

-- 12. Grants for socialflow_runtime
GRANT SELECT, INSERT ON "RenderBatch" TO socialflow_runtime;
GRANT UPDATE (status, "pendingItems", "processingItems", "completedItems", "failedItems", "cancelledItems", "cancelRequestedAt", "cancelCompletedAt", "completedAt", "updatedAt") ON "RenderBatch" TO socialflow_runtime;

-- 13. Update AuditLog policies for RenderBatch
DROP POLICY IF EXISTS audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR ("actorUserId" = current_actor() AND (
    can_read_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id="AuditLog"."entityId" AND b."organizationId"="AuditLog"."organizationId" AND can_read_client(b."organizationId",b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="AuditLog"."entityId" AND m."organizationId"="AuditLog"."organizationId" AND can_read_client(m."organizationId",m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id="AuditLog"."entityId" AND cb."organizationId"="AuditLog"."organizationId" AND can_read_client(cb."organizationId",cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id="AuditLog"."entityId" AND p."organizationId"="AuditLog"."organizationId" AND can_read_client(p."organizationId",p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id="AuditLog"."entityId" AND sa."organizationId"="AuditLog"."organizationId" AND can_read_client(sa."organizationId",sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id="AuditLog"."entityId" AND pa."organizationId"="AuditLog"."organizationId" AND can_read_client(pa."organizationId",pa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id="AuditLog"."entityId" AND ps."organizationId"="AuditLog"."organizationId" AND can_read_client(ps."organizationId",ps."clientId")) OR
    EXISTS (SELECT 1 FROM "DesignTemplate" dt WHERE dt.id="AuditLog"."entityId" AND dt."organizationId"="AuditLog"."organizationId" AND can_read_client(dt."organizationId",dt."clientId")) OR
    EXISTS (SELECT 1 FROM "DesignTemplateVersion" dv WHERE dv.id="AuditLog"."entityId" AND dv."organizationId"="AuditLog"."organizationId" AND can_read_client(dv."organizationId",dv."clientId")) OR
    EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND can_read_client(rj."organizationId",rj."clientId")) OR
    EXISTS (SELECT 1 FROM "RenderBatch" rb WHERE rb.id="AuditLog"."entityId" AND rb."organizationId"="AuditLog"."organizationId" AND can_read_client(rb."organizationId",rb."clientId"))
  )) OR ("actorUserId"='system:scheduler' AND (
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id="AuditLog"."entityId" AND ps."organizationId"="AuditLog"."organizationId" AND can_read_client(ps."organizationId",ps."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id="AuditLog"."entityId" AND pa."organizationId"="AuditLog"."organizationId" AND can_read_client(pa."organizationId",pa."clientId"))
  )) OR ("actorUserId"='system:renderer' AND (
    EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND (renderer_in_scope(rj."organizationId",rj."clientId") OR can_read_client(rj."organizationId",rj."clientId"))) OR
    EXISTS (SELECT 1 FROM "RenderBatch" rb WHERE rb.id="AuditLog"."entityId" AND rb."organizationId"="AuditLog"."organizationId" AND (renderer_in_scope(rb."organizationId",rb."clientId") OR can_read_client(rb."organizationId",rb."clientId")))
  ))
);

-- 14. Update renderer_can_audit to allow RenderBatch audit actions
CREATE OR REPLACE FUNCTION renderer_can_audit(org text, entity text, audit_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT current_setting('app.user_id', true) = 'system:renderer'
    AND current_setting('app.renderer_org_id', true) = org
    AND (
      (
        audit_action IN ('render.started','render.completed','render.failed','render.recovered')
        AND EXISTS (
          SELECT 1 FROM "RenderJob" r
          WHERE r.id=entity AND r."organizationId"=org
            AND r."clientId"=current_setting('app.renderer_client_id', true)
        )
      ) OR (
        audit_action IN ('batch.started','batch.completed','batch.cancelled','batch.completed_with_failures','batch.reconciled','batch.retried')
        AND EXISTS (
          SELECT 1 FROM "RenderBatch" rb
          WHERE rb.id=entity AND rb."organizationId"=org
            AND rb."clientId"=current_setting('app.renderer_client_id', true)
        )
      )
    )
$$;
REVOKE ALL ON FUNCTION renderer_can_audit(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renderer_can_audit(text, text, text) TO socialflow_runtime;

DROP POLICY IF EXISTS audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId"=current_actor() AND (
    renderer_can_audit("organizationId", "entityId", action) OR
    (current_actor()<>'system:renderer' AND (
      can_edit_client("organizationId", "entityId") OR
      EXISTS (SELECT 1 FROM "Brand" b WHERE b.id="AuditLog"."entityId" AND b."organizationId"="AuditLog"."organizationId" AND can_edit_client(b."organizationId",b."clientId")) OR
      EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="AuditLog"."entityId" AND m."organizationId"="AuditLog"."organizationId" AND can_edit_client(m."organizationId",m."clientId")) OR
      EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id="AuditLog"."entityId" AND cb."organizationId"="AuditLog"."organizationId" AND can_edit_client(cb."organizationId",cb."clientId")) OR
      EXISTS (SELECT 1 FROM "Post" p WHERE p.id="AuditLog"."entityId" AND p."organizationId"="AuditLog"."organizationId" AND can_interact_post(p."organizationId",p."clientId")) OR
      EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id="AuditLog"."entityId" AND sa."organizationId"="AuditLog"."organizationId" AND can_interact_post(sa."organizationId",sa."clientId")) OR
      EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id="AuditLog"."entityId" AND pa."organizationId"="AuditLog"."organizationId" AND can_interact_post(pa."organizationId",pa."clientId")) OR
      EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id="AuditLog"."entityId" AND ps."organizationId"="AuditLog"."organizationId" AND can_interact_post(ps."organizationId",ps."clientId")) OR
      EXISTS (SELECT 1 FROM "DesignTemplate" dt WHERE dt.id="AuditLog"."entityId" AND dt."organizationId"="AuditLog"."organizationId" AND can_edit_client(dt."organizationId",dt."clientId")) OR
      EXISTS (SELECT 1 FROM "DesignTemplateVersion" dv WHERE dv.id="AuditLog"."entityId" AND dv."organizationId"="AuditLog"."organizationId" AND can_edit_client(dv."organizationId",dv."clientId")) OR
      EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND can_edit_client(rj."organizationId",rj."clientId")) OR
      EXISTS (SELECT 1 FROM "RenderBatch" rb WHERE rb.id="AuditLog"."entityId" AND rb."organizationId"="AuditLog"."organizationId" AND can_edit_client(rb."organizationId",rb."clientId"))
    ))
  )
);

-- 15. Endurecimento do Reconciliador de RenderJobs com autorização estrita
-- Apenas system:renderer explícito pode executar descoberta global (privilégio mínimo).
-- Sessões runtime sem contexto ou usuários comuns recebem 42501 (insufficient_privilege).
DROP FUNCTION IF EXISTS discover_active_render_batches();
DROP FUNCTION IF EXISTS discover_reconcilable_render_jobs();

CREATE OR REPLACE FUNCTION discover_reconcilable_render_jobs()
RETURNS TABLE (
  "renderJobId" text,
  "organizationId" text,
  "clientId" text,
  "status" "RenderJobStatus",
  "queueJobId" text,
  "leaseExpiresAt" timestamp(3),
  "updatedAt" timestamp(3),
  "batchId" text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.user_id', true) IS DISTINCT FROM 'system:renderer' THEN
    RAISE EXCEPTION 'insufficient_privilege: discovery requires system:renderer context'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT r.id, r."organizationId", r."clientId", r.status, r."queueJobId", r."leaseExpiresAt", r."updatedAt", r."batchId"
  FROM "RenderJob" r
  JOIN "Client" c ON c.id=r."clientId" AND c."organizationId"=r."organizationId"
  JOIN "Organization" o ON o.id=r."organizationId"
  WHERE c.active AND o.active
    AND (r.status='PENDING' OR (r.status='PROCESSING' AND r."leaseExpiresAt" < CURRENT_TIMESTAMP))
  ORDER BY r."updatedAt" ASC;
END;
$$;

REVOKE ALL ON FUNCTION discover_reconcilable_render_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_reconcilable_render_jobs() TO socialflow_runtime;

-- 16. Descoberta de lotes ativos protegida com autorização estrita
CREATE OR REPLACE FUNCTION discover_active_render_batches()
RETURNS TABLE (
  "batchId" text,
  "organizationId" text,
  "clientId" text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('app.user_id', true) IS DISTINCT FROM 'system:renderer' THEN
    RAISE EXCEPTION 'insufficient_privilege: discovery requires system:renderer context'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT rb.id, rb."organizationId", rb."clientId"
  FROM "RenderBatch" rb
  JOIN "Client" c ON c.id=rb."clientId" AND c."organizationId"=rb."organizationId"
  JOIN "Organization" o ON o.id=rb."organizationId"
  WHERE c.active AND o.active
    AND rb.status IN ('PENDING', 'PROCESSING', 'CANCELLING')
  ORDER BY rb."updatedAt" ASC;
END;
$$;

REVOKE ALL ON FUNCTION discover_active_render_batches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_active_render_batches() TO socialflow_runtime;
