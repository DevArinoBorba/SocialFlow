-- Identity normalization and membership invariants not representable in Prisma.
ALTER TABLE "User" ADD CONSTRAINT user_email_normalized CHECK (email = lower(email));
CREATE UNIQUE INDEX membership_organization_unique ON "Membership" ("userId", "organizationId") WHERE "clientId" IS NULL;
ALTER TABLE "Membership" ADD CONSTRAINT membership_scope CHECK (
  (role IN ('OWNER','ADMIN') AND "clientId" IS NULL) OR
  (role IN ('EDITOR','APPROVER','CLIENT_VIEWER') AND "clientId" IS NOT NULL)
);

CREATE FUNCTION current_actor() RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT id FROM "User" WHERE id = nullif(current_setting('app.user_id', true), '') AND active
$$;
REVOKE ALL ON FUNCTION current_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_actor() TO socialflow_runtime;

ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON "Membership" FOR SELECT TO socialflow_runtime
  USING ("userId" = current_actor() AND active);

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_read ON "Organization" FOR SELECT TO socialflow_runtime USING (
  active AND EXISTS (SELECT 1 FROM "Membership" m WHERE m."organizationId" = "Organization".id AND m."userId" = current_actor() AND m.active)
);

CREATE FUNCTION can_manage(org text) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "Membership" m JOIN "Organization" o ON o.id = m."organizationId"
    WHERE m."organizationId" = org AND m."userId" = current_actor() AND m.active AND o.active AND m."clientId" IS NULL AND m.role IN ('OWNER','ADMIN'))
$$;
CREATE FUNCTION can_read_client(org text, client text) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "Membership" m JOIN "Organization" o ON o.id = m."organizationId"
    WHERE m."organizationId" = org AND m."userId" = current_actor() AND m.active AND o.active
      AND ((m."clientId" IS NULL AND m.role IN ('OWNER','ADMIN')) OR m."clientId" = client))
$$;
CREATE FUNCTION can_edit_client(org text, client text) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT can_manage(org) OR EXISTS (SELECT 1 FROM "Membership" m JOIN "Organization" o ON o.id = m."organizationId"
    WHERE m."organizationId" = org AND m."clientId" = client AND m."userId" = current_actor() AND m.active AND o.active AND m.role = 'EDITOR')
$$;
REVOKE ALL ON FUNCTION can_manage(text), can_read_client(text,text), can_edit_client(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_manage(text), can_read_client(text,text), can_edit_client(text,text) TO socialflow_runtime;

ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Client" FORCE ROW LEVEL SECURITY;
CREATE POLICY client_read ON "Client" FOR SELECT TO socialflow_runtime USING (can_read_client("organizationId", id));
CREATE POLICY client_create ON "Client" FOR INSERT TO socialflow_runtime WITH CHECK (can_manage("organizationId"));
CREATE POLICY client_update ON "Client" FOR UPDATE TO socialflow_runtime
  USING (can_edit_client("organizationId", id)) WITH CHECK (can_edit_client("organizationId", id));
-- Hard delete intentionally has neither a grant nor a policy.
CREATE FUNCTION protect_client_status() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user = 'socialflow_runtime' AND NEW.active IS DISTINCT FROM OLD.active AND NOT can_manage(OLD."organizationId") THEN
    RAISE EXCEPTION 'Only organization administrators can change client status' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_client_status BEFORE UPDATE ON "Client" FOR EACH ROW EXECUTE FUNCTION protect_client_status();

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (can_manage("organizationId") OR "actorUserId" = current_actor());
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND can_edit_client("organizationId", "entityId")
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM socialflow_runtime;
GRANT SELECT ON "User", "Account", "Organization", "Membership", "Client", "AuditLog" TO socialflow_runtime;
GRANT UPDATE (name, email, "emailVerified", image, "updatedAt") ON "User" TO socialflow_runtime;
GRANT UPDATE (password, "updatedAt") ON "Account" TO socialflow_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Session", "Verification", "RateLimit" TO socialflow_runtime;
GRANT INSERT ON "Client", "AuditLog" TO socialflow_runtime;
GRANT UPDATE (name, active) ON "Client" TO socialflow_runtime;
