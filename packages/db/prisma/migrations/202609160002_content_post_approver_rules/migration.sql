-- Evolution of Post lifecycle rules: grant APPROVER interaction rights and enforce content immutability for non-editors

-- 1. Helper function to permit editors, approvers and admins to interact with post lifecycle
CREATE OR REPLACE FUNCTION can_interact_post(org text, client text) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT can_edit_client(org, client) OR EXISTS (
    SELECT 1 FROM "Membership" m JOIN "Organization" o ON o.id = m."organizationId"
    WHERE m."organizationId" = org AND m."clientId" = client AND m."userId" = current_actor() AND m.active AND o.active AND m.role = 'APPROVER'
  )
$$;

REVOKE ALL ON FUNCTION can_interact_post(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_interact_post(text, text) TO socialflow_runtime;

-- 2. Update post_update policy to allow APPROVER to perform allowed status transitions
DROP POLICY IF EXISTS post_update ON "Post";
CREATE POLICY post_update ON "Post" FOR UPDATE TO socialflow_runtime
  USING (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  );

-- 3. Hardening of trigger: ensure non-editors (such as APPROVER) cannot modify post content
CREATE OR REPLACE FUNCTION protect_post_scope() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId" OR NEW."batchId" IS DISTINCT FROM OLD."batchId" THEN
    RAISE EXCEPTION 'Post scope is immutable' USING ERRCODE = '42501';
  END IF;
  -- Defesa em profundidade: papéis sem privilégio de edição de cliente (ex: APPROVER) não podem alterar conteúdo do post
  IF NOT can_edit_client(OLD."organizationId", OLD."clientId") THEN
    IF NEW.title IS DISTINCT FROM OLD.title OR
       NEW.caption IS DISTINCT FROM OLD.caption OR
       NEW.hashtags IS DISTINCT FROM OLD.hashtags OR
       NEW."callToAction" IS DISTINCT FROM OLD."callToAction" OR
       NEW."firstComment" IS DISTINCT FROM OLD."firstComment" OR
       NEW."suggestedDate" IS DISTINCT FROM OLD."suggestedDate" OR
       NEW."brandId" IS DISTINCT FROM OLD."brandId" THEN
      RAISE EXCEPTION 'Only editors and administrators may change post content' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 4. Update AuditLog policy to permit APPROVER to insert audit logs for post transitions
DROP POLICY IF EXISTS audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_edit_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_edit_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_edit_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_interact_post(p."organizationId", p."clientId"))
  )
);
