CREATE TYPE "DesignFormat" AS ENUM ('SQUARE', 'PORTRAIT', 'STORY');
CREATE TYPE "DesignTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "RenderJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "DesignTemplate" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "DesignTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DesignTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DesignTemplateVersion" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "format" "DesignFormat" NOT NULL,
  "spec" JSONB NOT NULL,
  "specHash" TEXT NOT NULL,
  "rendererVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DesignTemplateVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RenderJob" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "templateVersionId" TEXT NOT NULL,
  "postId" TEXT,
  "sourceMediaAssetId" TEXT,
  "outputMediaAssetId" TEXT,
  "status" "RenderJobStatus" NOT NULL DEFAULT 'PENDING',
  "input" JSONB NOT NULL,
  "inputHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RenderJob_attemptNumber_nonnegative" CHECK ("attemptNumber" >= 0)
);

CREATE UNIQUE INDEX "DesignTemplate_organizationId_id_key" ON "DesignTemplate"("organizationId", "id");
CREATE UNIQUE INDEX "DesignTemplate_organizationId_clientId_id_key" ON "DesignTemplate"("organizationId", "clientId", "id");
CREATE INDEX "DesignTemplate_organizationId_clientId_status_createdAt_idx" ON "DesignTemplate"("organizationId", "clientId", "status", "createdAt");
CREATE UNIQUE INDEX "DesignTemplateVersion_organizationId_id_key" ON "DesignTemplateVersion"("organizationId", "id");
CREATE UNIQUE INDEX "DesignTemplateVersion_organizationId_clientId_id_key" ON "DesignTemplateVersion"("organizationId", "clientId", "id");
CREATE UNIQUE INDEX "DesignTemplateVersion_templateId_version_key" ON "DesignTemplateVersion"("templateId", "version");
CREATE INDEX "DesignTemplateVersion_organizationId_clientId_templateId_version_idx" ON "DesignTemplateVersion"("organizationId", "clientId", "templateId", "version");
CREATE UNIQUE INDEX "RenderJob_outputMediaAssetId_key" ON "RenderJob"("outputMediaAssetId");
CREATE UNIQUE INDEX "RenderJob_organizationId_id_key" ON "RenderJob"("organizationId", "id");
CREATE UNIQUE INDEX "RenderJob_organizationId_clientId_id_key" ON "RenderJob"("organizationId", "clientId", "id");
CREATE UNIQUE INDEX "RenderJob_organizationId_clientId_idempotencyKey_key" ON "RenderJob"("organizationId", "clientId", "idempotencyKey");
CREATE INDEX "RenderJob_organizationId_clientId_status_createdAt_idx" ON "RenderJob"("organizationId", "clientId", "status", "createdAt");
CREATE INDEX "RenderJob_status_leaseExpiresAt_idx" ON "RenderJob"("status", "leaseExpiresAt");
CREATE INDEX "RenderJob_templateVersionId_idx" ON "RenderJob"("templateVersionId");
CREATE INDEX "RenderJob_postId_idx" ON "RenderJob"("postId");

ALTER TABLE "DesignTemplate" ADD CONSTRAINT "DesignTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignTemplate" ADD CONSTRAINT "DesignTemplate_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignTemplateVersion" ADD CONSTRAINT "DesignTemplateVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignTemplateVersion" ADD CONSTRAINT "DesignTemplateVersion_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DesignTemplateVersion" ADD CONSTRAINT "DesignTemplateVersion_organizationId_clientId_templateId_fkey" FOREIGN KEY ("organizationId", "clientId", "templateId") REFERENCES "DesignTemplate"("organizationId", "clientId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_templateVersionId_fkey" FOREIGN KEY ("organizationId", "clientId", "templateVersionId") REFERENCES "DesignTemplateVersion"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_postId_fkey" FOREIGN KEY ("organizationId", "clientId", "postId") REFERENCES "Post"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_sourceMediaAssetId_fkey" FOREIGN KEY ("organizationId", "sourceMediaAssetId") REFERENCES "MediaAsset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_outputMediaAssetId_fkey" FOREIGN KEY ("organizationId", "outputMediaAssetId") REFERENCES "MediaAsset"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DesignTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignTemplate" FORCE ROW LEVEL SECURITY;
ALTER TABLE "DesignTemplateVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignTemplateVersion" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RenderJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RenderJob" FORCE ROW LEVEL SECURITY;

CREATE POLICY design_template_read ON "DesignTemplate" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", "clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="DesignTemplate"."clientId" AND c."organizationId"="DesignTemplate"."organizationId" AND c.active)
);
CREATE POLICY design_template_create ON "DesignTemplate" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId") AND status='ACTIVE' AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="DesignTemplate"."clientId" AND c."organizationId"="DesignTemplate"."organizationId" AND c.active)
);
CREATE POLICY design_template_update ON "DesignTemplate" FOR UPDATE TO socialflow_runtime USING (
  can_edit_client("organizationId", "clientId")
) WITH CHECK (
  can_edit_client("organizationId", "clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="DesignTemplate"."clientId" AND c."organizationId"="DesignTemplate"."organizationId" AND c.active)
);

CREATE POLICY design_template_version_read ON "DesignTemplateVersion" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", "clientId") AND EXISTS (SELECT 1 FROM "DesignTemplate" t WHERE t.id="DesignTemplateVersion"."templateId" AND t."organizationId"="DesignTemplateVersion"."organizationId" AND t."clientId"="DesignTemplateVersion"."clientId")
);
CREATE POLICY design_template_version_create ON "DesignTemplateVersion" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId") AND version > 0 AND EXISTS (SELECT 1 FROM "DesignTemplate" t WHERE t.id="DesignTemplateVersion"."templateId" AND t."organizationId"="DesignTemplateVersion"."organizationId" AND t."clientId"="DesignTemplateVersion"."clientId" AND t.status='ACTIVE')
);

CREATE POLICY render_job_read ON "RenderJob" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", "clientId")
);
CREATE POLICY render_job_create ON "RenderJob" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId") AND status='PENDING' AND "attemptNumber"=0 AND "createdById"=current_actor() AND
  EXISTS (SELECT 1 FROM "DesignTemplateVersion" v WHERE v.id="RenderJob"."templateVersionId" AND v."organizationId"="RenderJob"."organizationId" AND v."clientId"="RenderJob"."clientId") AND
  ("postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id="RenderJob"."postId" AND p."organizationId"="RenderJob"."organizationId" AND p."clientId"="RenderJob"."clientId")) AND
  ("sourceMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."sourceMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND NOT m.archived))
);
CREATE POLICY render_job_update ON "RenderJob" FOR UPDATE TO socialflow_runtime USING (
  can_edit_client("organizationId", "clientId")
) WITH CHECK (
  can_edit_client("organizationId", "clientId") AND
  ("outputMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."outputMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND NOT m.archived))
);

CREATE OR REPLACE FUNCTION protect_design_template_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" THEN
    RAISE EXCEPTION 'DesignTemplate scope is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_design_template_scope BEFORE UPDATE ON "DesignTemplate" FOR EACH ROW EXECUTE FUNCTION protect_design_template_scope();

CREATE OR REPLACE FUNCTION protect_render_job_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId" OR NEW."postId" IS DISTINCT FROM OLD."postId" OR NEW."sourceMediaAssetId" IS DISTINCT FROM OLD."sourceMediaAssetId" OR NEW."input" IS DISTINCT FROM OLD."input" OR NEW."inputHash" IS DISTINCT FROM OLD."inputHash" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'RenderJob scope and input are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_protect_render_job_scope BEFORE UPDATE ON "RenderJob" FOR EACH ROW EXECUTE FUNCTION protect_render_job_scope();

GRANT SELECT, INSERT ON "DesignTemplate", "DesignTemplateVersion", "RenderJob" TO socialflow_runtime;
GRANT UPDATE (name, status, "updatedAt") ON "DesignTemplate" TO socialflow_runtime;
GRANT UPDATE (status, "outputMediaAssetId", "attemptNumber", "leaseExpiresAt", "errorCode", "errorMessage", "completedAt", "updatedAt") ON "RenderJob" TO socialflow_runtime;

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
    EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND can_read_client(rj."organizationId",rj."clientId"))
  )) OR ("actorUserId"='system:scheduler' AND (
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id="AuditLog"."entityId" AND ps."organizationId"="AuditLog"."organizationId" AND can_read_client(ps."organizationId",ps."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id="AuditLog"."entityId" AND pa."organizationId"="AuditLog"."organizationId" AND can_read_client(pa."organizationId",pa."clientId"))
  ))
);

DROP POLICY IF EXISTS audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId"=current_actor() AND (
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
    EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND can_edit_client(rj."organizationId",rj."clientId"))
  )
);
