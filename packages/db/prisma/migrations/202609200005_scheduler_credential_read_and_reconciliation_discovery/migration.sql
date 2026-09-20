-- 1. Leitura limitada de OAuthCredential pelo scheduler para o tenant ativo
DROP POLICY IF EXISTS oauth_credential_read ON "OAuthCredential";
CREATE POLICY oauth_credential_read ON "OAuthCredential" FOR SELECT TO socialflow_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND c.active
        AND (
          can_edit_client(sa."organizationId", sa."clientId")
          OR (
            current_setting('app.user_id', true) = 'system:scheduler'
            AND current_setting('app.scheduler_org_id', true) = sa."organizationId"
            AND current_setting('app.scheduler_client_id', true) = sa."clientId"
          )
        )
    )
  );

-- 2. Atualização de SocialAccount e registro de AuditLog pelo scheduler ao detectar token expirado
DROP POLICY IF EXISTS social_account_update ON "SocialAccount";
CREATE POLICY social_account_update ON "SocialAccount" FOR UPDATE TO socialflow_runtime
  USING (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  );

DROP POLICY IF EXISTS audit_create ON "AuditLog";
CREATE POLICY audit_create ON "AuditLog" FOR INSERT TO socialflow_runtime WITH CHECK (
  "actorUserId" = current_actor() AND (
    can_edit_client("organizationId", "entityId") OR
    EXISTS (SELECT 1 FROM "Brand" b WHERE b.id = "AuditLog"."entityId" AND b."organizationId" = "AuditLog"."organizationId" AND can_edit_client(b."organizationId", b."clientId")) OR
    EXISTS (SELECT 1 FROM "MediaAsset" m WHERE m.id = "AuditLog"."entityId" AND m."organizationId" = "AuditLog"."organizationId" AND can_edit_client(m."organizationId", m."clientId")) OR
    EXISTS (SELECT 1 FROM "ContentBatch" cb WHERE cb.id = "AuditLog"."entityId" AND cb."organizationId" = "AuditLog"."organizationId" AND can_edit_client(cb."organizationId", cb."clientId")) OR
    EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "AuditLog"."entityId" AND p."organizationId" = "AuditLog"."organizationId" AND can_interact_post(p."organizationId", p."clientId")) OR
    EXISTS (SELECT 1 FROM "SocialAccount" sa WHERE sa.id = "AuditLog"."entityId" AND sa."organizationId" = "AuditLog"."organizationId" AND can_interact_post(sa."organizationId", sa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationAttempt" pa WHERE pa.id = "AuditLog"."entityId" AND pa."organizationId" = "AuditLog"."organizationId" AND can_interact_post(pa."organizationId", pa."clientId")) OR
    EXISTS (SELECT 1 FROM "PublicationSchedule" ps WHERE ps.id = "AuditLog"."entityId" AND ps."organizationId" = "AuditLog"."organizationId" AND can_interact_post(ps."organizationId", ps."clientId"))
  )
);

-- 3. Descoberta segura para reconciliação inicial de agendamentos pendentes ou interrompidos
CREATE OR REPLACE FUNCTION discover_reconcilable_schedules()
RETURNS TABLE (
  "scheduleId" text,
  "organizationId" text,
  "clientId" text,
  "status" "PublicationScheduleStatus",
  "version" integer,
  "jobId" text,
  "scheduledForUtc" timestamp(3),
  "leaseExpiresAt" timestamp(3),
  "updatedAt" timestamp(3)
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ps.id AS "scheduleId",
    ps."organizationId",
    ps."clientId",
    ps.status,
    ps.version,
    ps."jobId",
    ps."scheduledForUtc",
    ps."leaseExpiresAt",
    ps."updatedAt"
  FROM "PublicationSchedule" ps
  JOIN "Client" c ON c.id = ps."clientId" AND c."organizationId" = ps."organizationId"
  JOIN "Organization" o ON o.id = ps."organizationId"
  WHERE c.active AND o.active
    AND ps.status IN ('SCHEDULED', 'ENQUEUED', 'PROCESSING')
  ORDER BY ps."scheduledForUtc" ASC;
$$;

REVOKE ALL ON FUNCTION discover_reconcilable_schedules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discover_reconcilable_schedules() TO socialflow_runtime;
