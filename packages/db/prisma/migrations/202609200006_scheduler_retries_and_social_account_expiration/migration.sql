-- Migration: 202609200006_scheduler_retries_and_social_account_expiration

-- 1. Adiciona coluna attemptsMade na tabela PublicationSchedule para rastreamento persistente de tentativas
ALTER TABLE "PublicationSchedule" ADD COLUMN IF NOT EXISTS "attemptsMade" integer NOT NULL DEFAULT 0;

-- 2. Reverte a policy social_account_update para can_edit_client estrito
-- APPROVER e system:scheduler não devem poder alterar nome, username, avatar ou metadata diretamente
DROP POLICY IF EXISTS social_account_update ON "SocialAccount";
CREATE POLICY social_account_update ON "SocialAccount" FOR UPDATE TO socialflow_runtime
  USING (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  )
  WITH CHECK (
    can_edit_client("organizationId", "clientId") AND
    EXISTS (
      SELECT 1 FROM "Client" c
      WHERE c.id = "SocialAccount"."clientId"
        AND c."organizationId" = "SocialAccount"."organizationId"
        AND c.active
    )
  );

-- 3. Cria função SECURITY DEFINER mínima para expiração da conta pelo scheduler
-- Altera estritamente status = 'EXPIRED' e updatedAt = NOW() sem permitir edição de outras colunas
CREATE OR REPLACE FUNCTION mark_social_account_expired(p_account_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer;
BEGIN
  -- Valida que o chamador é o ator técnico do scheduler
  IF current_setting('app.user_id', true) IS DISTINCT FROM 'system:scheduler' THEN
    RAISE EXCEPTION 'Acesso negado: apenas o ator técnico system:scheduler pode invocar mark_social_account_expired';
  END IF;

  -- Valida variáveis de escopo do scheduler
  IF current_setting('app.scheduler_org_id', true) IS NULL OR current_setting('app.scheduler_client_id', true) IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: escopo de organização ou cliente do scheduler não definido';
  END IF;

  -- Atualiza estritamente status = EXPIRED e updatedAt = NOW() para a conta pertencente ao tenant do scheduler com cliente ativo
  UPDATE "SocialAccount" sa
  SET status = 'EXPIRED',
      "updatedAt" = NOW()
  FROM "Client" c
  WHERE sa.id = p_account_id
    AND sa."clientId" = c.id
    AND sa."organizationId" = c."organizationId"
    AND sa."organizationId" = current_setting('app.scheduler_org_id', true)
    AND sa."clientId" = current_setting('app.scheduler_client_id', true)
    AND c.active = true;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Revoga execução de PUBLIC e concede exclusivamente à role runtime
REVOKE EXECUTE ON FUNCTION mark_social_account_expired(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_social_account_expired(text) TO socialflow_runtime;
