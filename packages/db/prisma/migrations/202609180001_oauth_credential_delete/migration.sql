-- RLS Policy and Grant for deleting OAuthCredential upon account disconnection
CREATE POLICY oauth_credential_delete ON "OAuthCredential" FOR DELETE TO socialflow_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "SocialAccount" sa
      JOIN "Client" c ON c.id = sa."clientId" AND c."organizationId" = sa."organizationId"
      WHERE sa.id = "OAuthCredential"."socialAccountId"
        AND can_edit_client(sa."organizationId", sa."clientId")
        AND c.active
    )
  );

GRANT DELETE ON "OAuthCredential" TO socialflow_runtime;
