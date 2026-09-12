-- Historic authorship must not outlive current tenant/client authorization.
DROP POLICY audit_read ON "AuditLog";
CREATE POLICY audit_read ON "AuditLog" FOR SELECT TO socialflow_runtime USING (
  can_manage("organizationId") OR
  ("actorUserId" = current_actor() AND can_read_client("organizationId", "entityId"))
);
