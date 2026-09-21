-- Renderer execution identity and tenant scope helper. This deliberately does
-- not alter can_edit_client(), so the technical actor gains no ambient access.
CREATE OR REPLACE FUNCTION current_actor() RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT id FROM "User" WHERE id = nullif(current_setting('app.user_id', true), '') AND active),
    CASE
      WHEN current_setting('app.user_id', true) = 'system:scheduler' THEN 'system:scheduler'
      WHEN current_setting('app.user_id', true) = 'system:renderer' THEN 'system:renderer'
      ELSE NULL
    END
  )
$$;

CREATE FUNCTION renderer_in_scope(org text, client text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT current_setting('app.user_id', true) = 'system:renderer'
    AND current_setting('app.renderer_org_id', true) = org
    AND current_setting('app.renderer_client_id', true) = client
$$;
REVOKE ALL ON FUNCTION renderer_in_scope(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renderer_in_scope(text, text) TO socialflow_runtime;

-- The renderer needs just enough tenant visibility for asRendererActor() to
-- validate its scope. No write capability is added to either table.
DROP POLICY IF EXISTS organization_read ON "Organization";
CREATE POLICY organization_read ON "Organization" FOR SELECT TO socialflow_runtime USING (
  active AND (
    (current_setting('app.user_id', true) = 'system:scheduler' AND current_setting('app.scheduler_org_id', true) = id) OR
    (current_setting('app.user_id', true) = 'system:renderer' AND current_setting('app.renderer_org_id', true) = id) OR
    EXISTS (SELECT 1 FROM "Membership" m WHERE m."organizationId" = "Organization".id AND m."userId" = current_actor() AND m.active)
  )
);

DROP POLICY IF EXISTS client_read ON "Client";
CREATE POLICY client_read ON "Client" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", id) OR renderer_in_scope("organizationId", id)
);

-- Replace the ambiguous source relation with two tenant-safe media relations.
ALTER TABLE "RenderJob" RENAME COLUMN "sourceMediaAssetId" TO "backgroundMediaAssetId";
ALTER TABLE "RenderJob" ADD COLUMN "logoMediaAssetId" TEXT;
ALTER TABLE "RenderJob" ADD COLUMN "queueJobId" TEXT;
ALTER TABLE "RenderJob" ADD COLUMN "executionToken" TEXT;
CREATE UNIQUE INDEX "RenderJob_queueJobId_key" ON "RenderJob"("queueJobId");
CREATE INDEX "RenderJob_backgroundMediaAssetId_idx" ON "RenderJob"("backgroundMediaAssetId");
CREATE INDEX "RenderJob_logoMediaAssetId_idx" ON "RenderJob"("logoMediaAssetId");
CREATE UNIQUE INDEX "MediaAsset_organizationId_clientId_id_key"
  ON "MediaAsset"("organizationId", "clientId", "id");

ALTER TABLE "RenderJob" DROP CONSTRAINT "RenderJob_organizationId_sourceMediaAssetId_fkey";
ALTER TABLE "RenderJob" DROP CONSTRAINT "RenderJob_organizationId_outputMediaAssetId_fkey";
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_backgroundMediaAssetId_fkey"
  FOREIGN KEY ("organizationId", "clientId", "backgroundMediaAssetId")
  REFERENCES "MediaAsset"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_logoMediaAssetId_fkey"
  FOREIGN KEY ("organizationId", "clientId", "logoMediaAssetId")
  REFERENCES "MediaAsset"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_organizationId_clientId_outputMediaAssetId_fkey"
  FOREIGN KEY ("organizationId", "clientId", "outputMediaAssetId")
  REFERENCES "MediaAsset"("organizationId", "clientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Templates and immutable versions are readable only inside the renderer scope.
DROP POLICY IF EXISTS design_template_read ON "DesignTemplate";
CREATE POLICY design_template_read ON "DesignTemplate" FOR SELECT TO socialflow_runtime USING (
  (can_read_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId"))
  AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="DesignTemplate"."clientId" AND c."organizationId"="DesignTemplate"."organizationId" AND c.active)
);

DROP POLICY IF EXISTS design_template_version_read ON "DesignTemplateVersion";
CREATE POLICY design_template_version_read ON "DesignTemplateVersion" FOR SELECT TO socialflow_runtime USING (
  (can_read_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId"))
  AND EXISTS (SELECT 1 FROM "DesignTemplate" t WHERE t.id="DesignTemplateVersion"."templateId" AND t."organizationId"="DesignTemplateVersion"."organizationId" AND t."clientId"="DesignTemplateVersion"."clientId")
);

-- Users may still create an immutable PENDING request. Operational mutation is
-- reserved exclusively for the scoped renderer actor.
DROP POLICY IF EXISTS render_job_read ON "RenderJob";
CREATE POLICY render_job_read ON "RenderJob" FOR SELECT TO socialflow_runtime USING (
  can_read_client("organizationId", "clientId") OR renderer_in_scope("organizationId", "clientId")
);

DROP POLICY IF EXISTS render_job_create ON "RenderJob";
CREATE POLICY render_job_create ON "RenderJob" FOR INSERT TO socialflow_runtime WITH CHECK (
  can_edit_client("organizationId", "clientId")
  AND status='PENDING' AND "attemptNumber"=0 AND "createdById"=current_actor()
  AND "queueJobId" IS NULL AND "executionToken" IS NULL AND "leaseExpiresAt" IS NULL
  AND "outputMediaAssetId" IS NULL AND "errorCode" IS NULL AND "errorMessage" IS NULL AND "completedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "DesignTemplateVersion" v WHERE v.id="RenderJob"."templateVersionId" AND v."organizationId"="RenderJob"."organizationId" AND v."clientId"="RenderJob"."clientId")
  AND ("postId" IS NULL OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id="RenderJob"."postId" AND p."organizationId"="RenderJob"."organizationId" AND p."clientId"="RenderJob"."clientId"))
  AND ("backgroundMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."backgroundMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND m.status='ready' AND NOT m.archived))
  AND ("logoMediaAssetId" IS NULL OR EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."logoMediaAssetId" AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND m.status='ready' AND NOT m.archived))
);

DROP POLICY IF EXISTS render_job_update ON "RenderJob";
CREATE POLICY render_job_update ON "RenderJob" FOR UPDATE TO socialflow_runtime
USING (renderer_in_scope("organizationId", "clientId"))
WITH CHECK (
  renderer_in_scope("organizationId", "clientId")
  AND ("outputMediaAssetId" IS NULL OR EXISTS (
    SELECT 1 FROM "MediaAsset" m WHERE m.id="RenderJob"."outputMediaAssetId"
      AND m."organizationId"="RenderJob"."organizationId" AND m."clientId"="RenderJob"."clientId" AND NOT m.archived
  ))
);
GRANT UPDATE ("queueJobId", "executionToken") ON "RenderJob" TO socialflow_runtime;

CREATE OR REPLACE FUNCTION protect_render_job_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId"
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

-- Ready, non-archived source media is readable within the exact renderer tenant.
-- Output media uses the render job id as its deterministic id/storage suffix.
DROP POLICY IF EXISTS media_read ON "MediaAsset";
CREATE POLICY media_read ON "MediaAsset" FOR SELECT TO socialflow_runtime USING (
  (can_read_client("organizationId","clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active))
  OR (renderer_in_scope("organizationId", "clientId") AND status='ready' AND NOT archived)
  OR (renderer_in_scope("organizationId", "clientId") AND EXISTS (
    SELECT 1 FROM "RenderJob" r WHERE r.id="MediaAsset".id AND r."organizationId"="MediaAsset"."organizationId" AND r."clientId"="MediaAsset"."clientId"
  ))
);

DROP POLICY IF EXISTS media_create ON "MediaAsset";
CREATE POLICY media_create ON "MediaAsset" FOR INSERT TO socialflow_runtime WITH CHECK (
  (can_edit_client("organizationId","clientId") AND status='pending' AND NOT archived AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active))
  OR (renderer_in_scope("organizationId", "clientId") AND status='pending' AND NOT archived AND "brandId" IS NULL
    AND id IN (SELECT r.id FROM "RenderJob" r WHERE r."organizationId"="MediaAsset"."organizationId" AND r."clientId"="MediaAsset"."clientId" AND r."outputMediaAssetId" IS NULL))
);

DROP POLICY IF EXISTS media_update ON "MediaAsset";
CREATE POLICY media_update ON "MediaAsset" FOR UPDATE TO socialflow_runtime
USING (
  (can_edit_client("organizationId","clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active))
  OR (renderer_in_scope("organizationId", "clientId") AND id IN (SELECT r.id FROM "RenderJob" r WHERE r."organizationId"="MediaAsset"."organizationId" AND r."clientId"="MediaAsset"."clientId"))
)
WITH CHECK (
  (can_edit_client("organizationId","clientId") AND (NOT archived OR can_manage("organizationId")) AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active))
  OR (renderer_in_scope("organizationId", "clientId") AND NOT archived AND "brandId" IS NULL
    AND id IN (SELECT r.id FROM "RenderJob" r WHERE r."organizationId"="MediaAsset"."organizationId" AND r."clientId"="MediaAsset"."clientId"))
);

CREATE OR REPLACE FUNCTION protect_media_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'Media scope is immutable' USING ERRCODE='42501';
  END IF;
  IF current_actor() = 'system:renderer' AND (
    NEW.name IS DISTINCT FROM OLD.name OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW."brandId" IS DISTINCT FROM OLD."brandId" OR NEW.archived IS DISTINCT FROM OLD.archived
  ) THEN
    RAISE EXCEPTION 'Renderer may only finalize output media' USING ERRCODE='42501';
  END IF;
  IF NEW.archived IS DISTINCT FROM OLD.archived AND NOT can_manage(OLD."organizationId") THEN
    RAISE EXCEPTION 'Only administrators may archive media' USING ERRCODE='42501';
  END IF;
  IF OLD.status IN ('ready','failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height OR NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
    RAISE EXCEPTION 'Finalized media bytes are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION renderer_can_audit(org text, entity text, audit_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT current_setting('app.user_id', true) = 'system:renderer'
    AND current_setting('app.renderer_org_id', true) = org
    AND audit_action IN ('render.started','render.completed','render.failed','render.recovered')
    AND EXISTS (
      SELECT 1 FROM "RenderJob" r
      WHERE r.id=entity AND r."organizationId"=org
        AND r."clientId"=current_setting('app.renderer_client_id', true)
    )
$$;
REVOKE ALL ON FUNCTION renderer_can_audit(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renderer_can_audit(text, text, text) TO socialflow_runtime;

-- Scoped audit creation and visibility for renderer lifecycle events.
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
  )) OR ("actorUserId"='system:renderer' AND EXISTS (
    SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND (renderer_in_scope(rj."organizationId",rj."clientId") OR can_read_client(rj."organizationId",rj."clientId"))
  ))
);

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
      EXISTS (SELECT 1 FROM "RenderJob" rj WHERE rj.id="AuditLog"."entityId" AND rj."organizationId"="AuditLog"."organizationId" AND can_edit_client(rj."organizationId",rj."clientId"))
    ))
  )
);

-- Minimal bootstrap discovery. The database remains the source of truth.
CREATE FUNCTION discover_reconcilable_render_jobs()
RETURNS TABLE (
  "renderJobId" text,
  "organizationId" text,
  "clientId" text,
  "status" "RenderJobStatus",
  "queueJobId" text,
  "leaseExpiresAt" timestamp(3),
  "updatedAt" timestamp(3)
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.id, r."organizationId", r."clientId", r.status, r."queueJobId", r."leaseExpiresAt", r."updatedAt"
  FROM "RenderJob" r
  JOIN "Client" c ON c.id=r."clientId" AND c."organizationId"=r."organizationId"
  JOIN "Organization" o ON o.id=r."organizationId"
  WHERE c.active AND o.active
    AND (r.status='PENDING' OR (r.status='PROCESSING' AND r."leaseExpiresAt" < CURRENT_TIMESTAMP))
  ORDER BY r."updatedAt" ASC;
$$;
REVOKE ALL ON FUNCTION discover_reconcilable_render_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_reconcilable_render_jobs() TO socialflow_runtime;
