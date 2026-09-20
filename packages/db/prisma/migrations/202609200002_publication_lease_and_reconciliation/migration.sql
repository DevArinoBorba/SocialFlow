-- AlterTable: Adiciona leaseExpiresAt para detecção e retomada de execuções abandonadas
ALTER TABLE "PublicationAttempt" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublicationAttempt_status_leaseExpiresAt_idx" ON "PublicationAttempt" ("status", "leaseExpiresAt");

-- Grant permissions for socialflow_runtime on leaseExpiresAt
GRANT UPDATE ("leaseExpiresAt") ON "PublicationAttempt" TO socialflow_runtime;
