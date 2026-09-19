-- CreateTable
CREATE TABLE "OAuthDiscoveryConsumption" (
    "id" TEXT NOT NULL,
    "discoveryId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "selectedAssets" JSONB NOT NULL,
    "connectedAccountIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "OAuthDiscoveryConsumption_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "OAuthDiscoveryConsumption_discoveryId_key" ON "OAuthDiscoveryConsumption"("discoveryId");
CREATE UNIQUE INDEX "OAuthDiscoveryConsumption_organizationId_discoveryId_key" ON "OAuthDiscoveryConsumption"("organizationId", "discoveryId");
CREATE UNIQUE INDEX "OAuthDiscoveryConsumption_organizationId_clientId_discoveryId_key" ON "OAuthDiscoveryConsumption"("organizationId", "clientId", "discoveryId");
CREATE INDEX "OAuthDiscoveryConsumption_org_client_discovery_idx" ON "OAuthDiscoveryConsumption"("organizationId", "clientId", "discoveryId");

-- ForeignKeys
ALTER TABLE "OAuthDiscoveryConsumption" ADD CONSTRAINT "OAuthDiscoveryConsumption_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OAuthDiscoveryConsumption" ADD CONSTRAINT "OAuthDiscoveryConsumption_organizationId_clientId_fkey" FOREIGN KEY ("organizationId", "clientId") REFERENCES "Client"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OAuthDiscoveryConsumption" ADD CONSTRAINT "OAuthDiscoveryConsumption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS and Policies for OAuthDiscoveryConsumption
ALTER TABLE "OAuthDiscoveryConsumption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OAuthDiscoveryConsumption" FORCE ROW LEVEL SECURITY;

CREATE POLICY oauth_discovery_consumption_read ON "OAuthDiscoveryConsumption" FOR SELECT TO socialflow_runtime
  USING (
    can_read_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "OAuthDiscoveryConsumption"."clientId"
        AND c."organizationId" = "OAuthDiscoveryConsumption"."organizationId"
        AND c.active
    )
  );

CREATE POLICY oauth_discovery_consumption_create ON "OAuthDiscoveryConsumption" FOR INSERT TO socialflow_runtime
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "OAuthDiscoveryConsumption"."clientId"
        AND c."organizationId" = "OAuthDiscoveryConsumption"."organizationId"
        AND c.active
    )
  );

-- Grants for socialflow_runtime
GRANT SELECT, INSERT ON "OAuthDiscoveryConsumption" TO socialflow_runtime;
