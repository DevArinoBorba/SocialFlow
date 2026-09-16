CREATE UNIQUE INDEX "Brand_organizationId_clientId_id_key" ON "Brand"("organizationId", "clientId", id);
CREATE TABLE "MediaAsset" (
 id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL REFERENCES "Organization"(id),
 "clientId" TEXT NOT NULL, "brandId" TEXT, name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', "storageKey" TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','ready','failed')),
 "mimeType" TEXT, "byteSize" INTEGER, width INTEGER, height INTEGER, sha256 TEXT,
 archived BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 FOREIGN KEY ("organizationId","clientId") REFERENCES "Client"("organizationId",id),
 FOREIGN KEY ("organizationId","clientId","brandId") REFERENCES "Brand"("organizationId","clientId",id),
 CHECK (length(name) BETWEEN 2 AND 120 AND length(description) <= 2000),
 CHECK ("storageKey" = 'media/' || "organizationId" || '/' || "clientId" || '/' || id),
 CHECK (status <> 'ready' OR ("mimeType" IN ('image/jpeg','image/png','image/webp') AND "byteSize" > 0 AND "byteSize" <= 10485760 AND width > 0 AND height > 0 AND width::bigint*height <= 25000000 AND length(sha256)=64))
);
CREATE UNIQUE INDEX "MediaAsset_organizationId_id_key" ON "MediaAsset"("organizationId",id);
CREATE INDEX "MediaAsset_organizationId_clientId_createdAt_id_idx" ON "MediaAsset"("organizationId","clientId","createdAt",id);
ALTER TABLE "MediaAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MediaAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY media_read ON "MediaAsset" FOR SELECT TO socialflow_runtime USING (
 can_read_client("organizationId","clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active)
);
CREATE POLICY media_create ON "MediaAsset" FOR INSERT TO socialflow_runtime WITH CHECK (
 can_edit_client("organizationId","clientId") AND status='pending' AND NOT archived AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active)
);
CREATE POLICY media_update ON "MediaAsset" FOR UPDATE TO socialflow_runtime USING (
 can_edit_client("organizationId","clientId") AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active)
) WITH CHECK (
 can_edit_client("organizationId","clientId") AND (NOT archived OR can_manage("organizationId")) AND EXISTS (SELECT 1 FROM "Client" c WHERE c.id="MediaAsset"."clientId" AND c."organizationId"="MediaAsset"."organizationId" AND c.active)
);
CREATE FUNCTION protect_media_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
  RAISE EXCEPTION 'Media scope is immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.archived IS DISTINCT FROM OLD.archived AND NOT can_manage(OLD."organizationId") THEN
  RAISE EXCEPTION 'Only administrators may archive media' USING ERRCODE='42501';
 END IF;
 IF OLD.status IN ('ready','failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType" OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize" OR NEW.width IS DISTINCT FROM OLD.width OR NEW.height IS DISTINCT FROM OLD.height OR NEW.sha256 IS DISTINCT FROM OLD.sha256) THEN
  RAISE EXCEPTION 'Finalized media bytes are immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_media_scope BEFORE UPDATE ON "MediaAsset" FOR EACH ROW EXECUTE FUNCTION protect_media_scope();
GRANT SELECT, INSERT ON "MediaAsset" TO socialflow_runtime;
GRANT UPDATE (name,description,"brandId",status,"mimeType","byteSize",width,height,sha256,archived,"updatedAt") ON "MediaAsset" TO socialflow_runtime;
DROP POLICY audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
 can_manage("organizationId") OR ("actorUserId"=current_actor() AND (
  can_read_client("organizationId","entityId") OR
  EXISTS (SELECT 1 FROM "Brand" b WHERE b.id="AuditLog"."entityId" AND b."organizationId"="AuditLog"."organizationId" AND can_read_client(b."organizationId",b."clientId")) OR
  EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="AuditLog"."entityId" AND m."organizationId"="AuditLog"."organizationId" AND can_read_client(m."organizationId",m."clientId"))
 ))
);
DROP POLICY audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
 "actorUserId"=current_actor() AND (
  can_edit_client("organizationId","entityId") OR
  EXISTS (SELECT 1 FROM "Brand" b WHERE b.id="AuditLog"."entityId" AND b."organizationId"="AuditLog"."organizationId" AND can_edit_client(b."organizationId",b."clientId")) OR
  EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id="AuditLog"."entityId" AND m."organizationId"="AuditLog"."organizationId" AND can_edit_client(m."organizationId",m."clientId"))
 )
);
