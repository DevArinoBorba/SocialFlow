-- AlterTable
ALTER TABLE "DesignTemplate" ADD COLUMN "systemKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "DesignTemplate_organizationId_clientId_systemKey_key" ON "DesignTemplate"("organizationId", "clientId", "systemKey");

-- Protect systemKey immutability along with scope
CREATE OR REPLACE FUNCTION protect_design_template_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" THEN
    RAISE EXCEPTION 'DesignTemplate scope is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW."systemKey" IS DISTINCT FROM OLD."systemKey" THEN
    RAISE EXCEPTION 'DesignTemplate systemKey is immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
