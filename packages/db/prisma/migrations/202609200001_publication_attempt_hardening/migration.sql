-- AlterEnum: Add PROCESSING and UNCERTAIN statuses to PublicationAttemptStatus
ALTER TYPE "PublicationAttemptStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
ALTER TYPE "PublicationAttemptStatus" ADD VALUE IF NOT EXISTS 'UNCERTAIN';

-- Unique partial indexes: Ensure persistent idempotency per post and social account
-- 1. A post can only be successfully published once per social account.
CREATE UNIQUE INDEX "PublicationAttempt_single_published_idx" ON "PublicationAttempt" ("postId", "socialAccountId") WHERE "status" = 'PUBLISHED';

-- 2. Only one active or uncertain attempt can exist per post and social account, preventing concurrent or overlapping executions.
CREATE UNIQUE INDEX "PublicationAttempt_single_active_idx" ON "PublicationAttempt" ("postId", "socialAccountId") WHERE "status" IN ('PENDING', 'PROCESSING', 'CONTAINER_CREATED', 'UNCERTAIN');

-- Update RLS policies on PublicationAttempt to allow APPROVER role (via can_interact_post)
DROP POLICY IF EXISTS publication_attempt_create ON "PublicationAttempt";
CREATE POLICY publication_attempt_create ON "PublicationAttempt" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  );

DROP POLICY IF EXISTS publication_attempt_update ON "PublicationAttempt";
CREATE POLICY publication_attempt_update ON "PublicationAttempt" FOR UPDATE TO socialflow_runtime
  USING (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_interact_post("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "PublicationAttempt"."clientId"
        AND c."organizationId" = "PublicationAttempt"."organizationId"
        AND c.active
    )
  );
