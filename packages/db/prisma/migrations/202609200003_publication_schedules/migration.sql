-- CreateEnum: PublicationScheduleStatus
CREATE TYPE "PublicationScheduleStatus" AS ENUM (
  'SCHEDULED',
  'ENQUEUED',
  'PROCESSING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'CANCELLED',
  'DEAD_LETTER',
  'REQUIRES_RECONCILIATION'
);

-- CreateTable: PublicationSchedule
CREATE TABLE "PublicationSchedule" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "targetAccountIds" TEXT[] NOT NULL,
  "mediaAssetId" TEXT,
  "scheduledTimezone" TEXT NOT NULL,
  "scheduledLocalTime" TEXT NOT NULL,
  "scheduledForUtc" TIMESTAMP(3) NOT NULL,
  "status" "PublicationScheduleStatus" NOT NULL DEFAULT 'SCHEDULED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "jobId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "cancellationReason" TEXT,
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PublicationSchedule_pkey" PRIMARY KEY ("id")
);

-- AlterTable: PublicationAttempt
ALTER TABLE "PublicationAttempt" ADD COLUMN IF NOT EXISTS "scheduleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PublicationSchedule_organizationId_id_key" ON "PublicationSchedule"("organizationId", "id");
CREATE UNIQUE INDEX "PublicationSchedule_organizationId_clientId_id_key" ON "PublicationSchedule"("organizationId", "clientId", "id");
CREATE INDEX "PublicationSchedule_organizationId_clientId_status_scheduledForUtc_idx" ON "PublicationSchedule"("organizationId", "clientId", "status", "scheduledForUtc");
CREATE INDEX "PublicationSchedule_postId_status_idx" ON "PublicationSchedule"("postId", "status");
CREATE INDEX "PublicationSchedule_jobId_idx" ON "PublicationSchedule"("jobId");

CREATE INDEX IF NOT EXISTS "PublicationAttempt_organizationId_clientId_scheduleId_idx" ON "PublicationAttempt"("organizationId", "clientId", "scheduleId");

-- AddForeignKey
ALTER TABLE "PublicationSchedule" ADD CONSTRAINT "PublicationSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationSchedule" ADD CONSTRAINT "PublicationSchedule_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationSchedule" ADD CONSTRAINT "PublicationSchedule_organizationId_clientId_postId_fkey" FOREIGN KEY ("organizationId", "clientId", "postId") REFERENCES "Post"("organizationId", "clientId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicationSchedule" ADD CONSTRAINT "PublicationSchedule_organizationId_mediaAssetId_fkey" FOREIGN KEY ("organizationId", "mediaAssetId") REFERENCES "MediaAsset"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublicationSchedule" ADD CONSTRAINT "PublicationSchedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_organizationId_clientId_scheduleId_fkey" FOREIGN KEY ("organizationId", "clientId", "scheduleId") REFERENCES "PublicationSchedule"("organizationId", "clientId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row Level Security & Triggers
ALTER TABLE "PublicationSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicationSchedule" FORCE ROW LEVEL SECURITY;

CREATE POLICY publication_schedule_read ON "PublicationSchedule"
  FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationSchedule"."clientId"
        AND c."organizationId" = "PublicationSchedule"."organizationId"
        AND c.active
    )
  );

CREATE POLICY publication_schedule_create ON "PublicationSchedule"
  FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationSchedule"."clientId"
        AND c."organizationId" = "PublicationSchedule"."organizationId"
        AND c.active
    )
  );

CREATE POLICY publication_schedule_update ON "PublicationSchedule"
  FOR UPDATE TO socialflow_runtime
  USING (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationSchedule"."clientId"
        AND c."organizationId" = "PublicationSchedule"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationSchedule"."clientId"
        AND c."organizationId" = "PublicationSchedule"."organizationId"
        AND c.active
    )
  );

CREATE OR REPLACE FUNCTION protect_publication_schedule_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."postId" IS DISTINCT FROM OLD."postId" THEN
    RAISE EXCEPTION 'PublicationSchedule scope is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_protect_publication_schedule_scope ON "PublicationSchedule";
CREATE TRIGGER trg_protect_publication_schedule_scope
  BEFORE UPDATE ON "PublicationSchedule"
  FOR EACH ROW
  EXECUTE FUNCTION protect_publication_schedule_scope();

-- Grants
GRANT SELECT, INSERT, UPDATE ON "PublicationSchedule" TO socialflow_runtime;
GRANT UPDATE ("scheduleId") ON "PublicationAttempt" TO socialflow_runtime;

-- Update AuditLog RLS policies to support PublicationSchedule and APPROVER interactions on PublicationAttempt
DROP POLICY IF EXISTS audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR ("actorUserId" = current_actor() AND (
    can_read_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_read_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_read_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_read_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_read_client(p."organizationId", p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id = "AuditLog"."entityId" AND sa."organizationId" = "AuditLog"."organizationId" AND can_read_client(sa."organizationId", sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id = "AuditLog"."entityId" AND pa."organizationId" = "AuditLog"."organizationId" AND can_read_client(pa."organizationId", pa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id = "AuditLog"."entityId" AND ps."organizationId" = "AuditLog"."organizationId" AND can_read_client(ps."organizationId", ps."clientId"))
  ))
);

DROP POLICY IF EXISTS audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_edit_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_edit_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_edit_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_interact_post(p."organizationId", p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id = "AuditLog"."entityId" AND sa."organizationId" = "AuditLog"."organizationId" AND can_edit_client(sa."organizationId", sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id = "AuditLog"."entityId" AND pa."organizationId" = "AuditLog"."organizationId" AND can_interact_post(pa."organizationId", pa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id = "AuditLog"."entityId" AND ps."organizationId" = "AuditLog"."organizationId" AND can_interact_post(ps."organizationId", ps."clientId"))
  )
);

