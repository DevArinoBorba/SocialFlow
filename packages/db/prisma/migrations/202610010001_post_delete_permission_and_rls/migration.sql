-- Migration: 202610010001_post_delete_permission_and_rls
-- Concede permissão de DELETE na tabela Post para a role socialflow_runtime
-- e estabelece política estrita de Row Level Security (RLS) limitando exclusões
-- exclusivamente a posts em rascunho (DRAFT) pertencentes ao cliente sob gestão do ator autorizado.

-- 1. Grant DELETE permission on Post table to socialflow_runtime
GRANT DELETE ON "Post" TO socialflow_runtime;

-- 2. Define strict RLS delete policy for Post:
-- - Post must be in DRAFT status
-- - Actor must have can_edit_client permission for the organization and client (OWNER, ADMIN, or EDITOR)
-- - Target client must exist, belong to the organization and be active
DROP POLICY IF EXISTS post_delete ON "Post";
CREATE POLICY post_delete ON "Post" FOR DELETE TO socialflow_runtime
  USING (
    status = 'DRAFT' AND
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "Post"."clientId"
        AND c."organizationId" = "Post"."organizationId"
        AND c.active
    )
  );
