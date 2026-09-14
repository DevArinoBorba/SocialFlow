-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "targetAudience" TEXT,
    "toneOfVoice" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_organizationId_id_key" ON "Brand"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Brand_organizationId_clientId_idx" ON "Brand"("organizationId", "clientId");

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS and Policies for Brand
ALTER TABLE "Brand" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Brand" FORCE ROW LEVEL SECURITY;

CREATE POLICY brand_read ON "Brand" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Brand"."clientId"
        AND c."organizationId" = "Brand"."organizationId"
        AND c.active
    )
  );

CREATE POLICY brand_create ON "Brand" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Brand"."clientId"
        AND c."organizationId" = "Brand"."organizationId"
        AND c.active
    )
  );

CREATE POLICY brand_update ON "Brand" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Brand"."clientId"
        AND c."organizationId" = "Brand"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Brand"."clientId"
        AND c."organizationId" = "Brand"."organizationId"
        AND c.active
    )
  );

-- Trigger to protect brand scope against reassignment of organizationId or clientId
CREATE FUNCTION protect_brand_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" THEN
    RAISE EXCEPTION 'Changing brand organization or client scope is forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_brand_scope BEFORE UPDATE ON "Brand" FOR EACH ROW EXECUTE FUNCTION protect_brand_scope();

-- Grants for socialflow_runtime on Brand
GRANT SELECT, INSERT ON "Brand" TO socialflow_runtime;
GRANT UPDATE (name, description, "targetAudience", "toneOfVoice", "updatedAt") ON "Brand" TO socialflow_runtime;

-- Revise AuditLog RLS policies to support brand entities
DROP POLICY audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR
  (
    "actorUserId" = current_actor() AND (
      can_read_client("organizationId", "entityId") OR
      EXISTS (
        SELECT 1 FROM "Brand" b
        WHERE b.id = "AuditLog"."entityId"
          AND b."organizationId" = "AuditLog"."organizationId"
          AND can_read_client(b."organizationId", b."clientId")
      )
    )
  )
);

DROP POLICY audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (
      SELECT 1 FROM "Brand" b
      WHERE b.id = "AuditLog"."entityId"
        AND b."organizationId" = "AuditLog"."organizationId"
        AND can_edit_client(b."organizationId", b."clientId")
    )
  )
);
