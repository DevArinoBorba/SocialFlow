#!/usr/bin/env bash
# SocialFlow Disaster Recovery and Restore Verification Script
# Downloads or accepts encrypted backup -> SHA256 check -> GPG decrypt -> Restore to isolated PostgreSQL -> Validate RLS/Schema/Grants
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SRC="${1:-}"
CONFIG_FILE="${BACKUP_CONFIG_FILE:-/root/.config/socialflow/backup.env}"
# Pin the rclone image by tag (not :latest) -- matches socialflow-backup.sh.
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.68.2}"
REMOTE_ALIAS="socialflowr2"
# Path to the postgres role-init script mounted into the isolated recovery
# container. Defaults to the repo-relative path (true when this script is run
# from a checkout, e.g. the local drill). On a standalone deployment (this
# script copied alone to a VPS, with the app checkout living elsewhere, e.g.
# Coolify's /data/coolify/applications/<id>/infra/postgres/init.sh), pass the
# real path explicitly -- the default will not resolve there.
INIT_SQL_SCRIPT="${INIT_SQL_SCRIPT:-${SCRIPT_DIR}/../../infra/postgres/init.sh}"

# RTO starts here, before locating/downloading the artifact: a download step
# skipped from the timer (as the previous version did) understates real
# recovery time, since download is normally the dominant cost.
START_TIME="$(date +%s)"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# Environment resolution: accepts optional argument 2, or SOCIALFLOW_ENV, or APP_ENV, or ENVIRONMENT
RAW_ENV="${SOCIALFLOW_ENV:-${APP_ENV:-${ENVIRONMENT:-${2:-}}}}"
TARGET_ENV=""
if [[ -n "$RAW_ENV" ]]; then
  case "${RAW_ENV,,}" in
    prod|production) TARGET_ENV="prod" ;;
    homolog|homologation|staging) TARGET_ENV="homolog" ;;
    *)
      echo "[ERROR] Invalid target environment '${RAW_ENV}'. Allowed values are 'prod' or 'homolog'." >&2
      exit 1
      ;;
  esac
fi

# Default R2 prefix per target environment
if [[ -z "${R2_PREFIX:-}" ]]; then
  if [[ -n "$TARGET_ENV" ]]; then
    R2_PREFIX="backups/socialflow/${TARGET_ENV}"
  else
    R2_PREFIX="backups/socialflow/prod"
  fi
fi

RECOVERY_DIR="${RECOVERY_DIR:-/tmp/socialflow-recovery-$(date +%s)}"
mkdir -p "$RECOVERY_DIR"
chmod 700 "$RECOVERY_DIR"

cleanup() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Cleaning up temporary recovery files..."
  rm -rf "$RECOVERY_DIR"
}
trap cleanup EXIT INT TERM

# 1. Locate or download backup.
# IMPORTANT: this script must actually exercise the R2 download path to prove
# recovery works from off-site storage. Passing a local BACKUP_SRC path (arg 1)
# or relying on the local archive fallback below only proves decrypt+restore,
# NOT that the R2 copy is retrievable -- treat those runs as partial evidence.
DOWNLOAD_SOURCE="unspecified_local_path"
if [[ -z "$BACKUP_SRC" ]]; then
  if [[ -n "${R2_BUCKET:-}" && -n "${R2_ACCESS_KEY_ID:-}" ]]; then
    echo "[INFO] Downloading latest backup from Cloudflare R2 (prefix: ${R2_PREFIX})..."
    RCLONE_ENV_ARGS=(
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_TYPE=s3"
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_PROVIDER=Cloudflare"
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_ENDPOINT=${R2_ENDPOINT}"
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}"
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}"
      -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_NO_CHECK_BUCKET=true"
    )
    REMOTE_TARGET="${REMOTE_ALIAS}:${R2_BUCKET}/${R2_PREFIX}"
    LATEST_NAME="$(docker run --rm "${RCLONE_ENV_ARGS[@]}" "$RCLONE_IMAGE" lsf "$REMOTE_TARGET" --files-only | grep -E '\.dump\.gpg$' | sort | tail -n 1)"
    if [[ -z "$LATEST_NAME" ]]; then
      echo "[ERROR] No backup found in R2 bucket (${REMOTE_TARGET})." >&2
      exit 1
    fi
    docker run --rm "${RCLONE_ENV_ARGS[@]}" -v "${RECOVERY_DIR}:/data" "$RCLONE_IMAGE" copy "${REMOTE_TARGET}/${LATEST_NAME}" /data/
    docker run --rm "${RCLONE_ENV_ARGS[@]}" -v "${RECOVERY_DIR}:/data" "$RCLONE_IMAGE" copy "${REMOTE_TARGET}/${LATEST_NAME%.dump.gpg}.sha256" /data/
    BACKUP_SRC="${RECOVERY_DIR}/${LATEST_NAME}"
    DOWNLOAD_SOURCE="r2:${R2_BUCKET}/${R2_PREFIX}"
  else
    # Local archive fallback only exists for convenience testing on the VPS
    # itself; it does NOT prove off-site recoverability and must be flagged.
    LOCAL_ARCHIVE="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}/archive${TARGET_ENV:+/$TARGET_ENV}"
    if [[ ! -d "$LOCAL_ARCHIVE" ]]; then
      LOCAL_ARCHIVE="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}/archive"
    fi
    LATEST_BACKUP="$(ls -t "${LOCAL_ARCHIVE}"/*.dump.gpg 2>/dev/null | head -n 1 || true)"
    if [[ -z "$LATEST_BACKUP" ]]; then
      echo "Usage: $0 [path-to-encrypted-backup.dump.gpg] [environment: prod|homolog]" >&2
      echo "(No R2 credentials configured and no local archive found.)" >&2
      exit 1
    fi
    BACKUP_SRC="$LATEST_BACKUP"
    DOWNLOAD_SOURCE="local_archive_NOT_r2"
    echo "[WARNING] R2 not configured; restoring from local VPS archive. This does NOT demonstrate off-site recovery." >&2
  fi
else
  DOWNLOAD_SOURCE="explicit_path_NOT_r2"
fi

if [[ ! -f "$BACKUP_SRC" ]]; then
  echo "[ERROR] Backup file not found: $BACKUP_SRC" >&2
  exit 2
fi

# Detect artifact provenance (production vs homologation)
DETECTED_ENV="unknown"
if [[ "$BACKUP_SRC" =~ (prod|production) || "$DOWNLOAD_SOURCE" =~ (prod|production) || "${R2_PREFIX:-}" =~ (prod|production) ]]; then
  DETECTED_ENV="prod"
elif [[ "$BACKUP_SRC" =~ (homolog|staging) || "$DOWNLOAD_SOURCE" =~ (homolog|staging) || "${R2_PREFIX:-}" =~ (homolog|staging) ]]; then
  DETECTED_ENV="homolog"
fi

echo "================================================================="
echo " SOCIALFLOW DISASTER RECOVERY & RESTORE VERIFICATION"
echo " Target Environment : ${TARGET_ENV:-${DETECTED_ENV^^}}"
echo " Artifact Origin    : ${DETECTED_ENV^^}"
echo " Source Location    : ${DOWNLOAD_SOURCE}"
echo " File Path          : ${BACKUP_SRC}"
echo "================================================================="

if [[ -n "$TARGET_ENV" && "$DETECTED_ENV" != "unknown" && "$TARGET_ENV" != "$DETECTED_ENV" ]]; then
  echo "[WARNING] Environment mismatch: Requested target environment is '${TARGET_ENV^^}', but backup artifact indicates '${DETECTED_ENV^^}' provenance!" >&2
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting recovery verification for: $BACKUP_SRC (source: ${DOWNLOAD_SOURCE})"

# 2. Check SHA256 if .sha256 companion exists
CHECKSUM_FILE="${BACKUP_SRC%.dump.gpg}.sha256"
if [[ ! -s "$CHECKSUM_FILE" ]]; then
  echo '[ERROR] Required checksum companion is missing or empty.' >&2
  exit 3
fi
if [[ -f "$CHECKSUM_FILE" ]]; then
  EXPECTED_SHA256="$(cut -d' ' -f1 < "$CHECKSUM_FILE")"
  ACTUAL_SHA256="$(sha256sum "$BACKUP_SRC" | cut -d' ' -f1)"
  if [[ "$EXPECTED_SHA256" != "$ACTUAL_SHA256" ]]; then
    echo "[ERROR] SHA256 mismatch! Expected $EXPECTED_SHA256, got $ACTUAL_SHA256" >&2
    exit 3
  fi
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] SHA256 verified: $ACTUAL_SHA256"
fi

# 3. Decrypt
DECRYPTED_DUMP="${RECOVERY_DIR}/restored.dump"
if [[ -n "${GPG_PASSPHRASE_FILE:-}" && -f "$GPG_PASSPHRASE_FILE" ]]; then
  gpg --batch --yes --decrypt --passphrase-file "$GPG_PASSPHRASE_FILE" -o "$DECRYPTED_DUMP" "$BACKUP_SRC"
elif [[ -n "${GPG_PRIVATE_KEY_FILE:-}" && -f "$GPG_PRIVATE_KEY_FILE" ]]; then
  # Import private key into ephemeral gpg home
  GNUPG_TMP="${RECOVERY_DIR}/gnupg"
  mkdir -p "$GNUPG_TMP" && chmod 700 "$GNUPG_TMP"
  GNUPGHOME="$GNUPG_TMP" gpg --batch --import "$GPG_PRIVATE_KEY_FILE"
  GNUPGHOME="$GNUPG_TMP" gpg --batch --yes --decrypt -o "$DECRYPTED_DUMP" "$BACKUP_SRC"
else
  # Use current user's keyring
  gpg --batch --yes --decrypt -o "$DECRYPTED_DUMP" "$BACKUP_SRC"
fi

if [[ ! -s "$DECRYPTED_DUMP" ]]; then
  echo "[ERROR] Decrypted dump is missing or empty." >&2
  exit 4
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Decryption successful ($(wc -c < "$DECRYPTED_DUMP") bytes)"

# 4. Spin up isolated recovery container (PostgreSQL 17.11) on a dedicated,
# throwaway network -- never the production compose network -- so an app-level
# smoke test (step F below) can reach it without any path to real data.
PROJECT_NAME="socialflow-recovery-$(date +%s)"
RECOVERY_NETWORK="${PROJECT_NAME}-net"
POSTGRES_PASSWORD="${RECOVERY_POSTGRES_PASSWORD:-recov_pw_$(openssl rand -hex 12)}"
RUNTIME_DB_PASSWORD="${RECOVERY_RUNTIME_PASSWORD:-recov_rt_$(openssl rand -hex 12)}"

if [[ ! -f "$INIT_SQL_SCRIPT" ]]; then
  echo "[ERROR] INIT_SQL_SCRIPT not found: $INIT_SQL_SCRIPT (set INIT_SQL_SCRIPT to the real infra/postgres/init.sh path on this host)" >&2
  exit 10
fi

docker network create "$RECOVERY_NETWORK" >/dev/null

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Launching isolated recovery PostgreSQL..."
CONTAINER_ID="$(docker run -d --rm \
  --name "${PROJECT_NAME}-postgres" \
  --network "$RECOVERY_NETWORK" \
  -e POSTGRES_USER=socialflow_migration \
  -e POSTGRES_DB=socialflow \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e RUNTIME_DB_PASSWORD="$RUNTIME_DB_PASSWORD" \
  -v "${INIT_SQL_SCRIPT}:/docker-entrypoint-initdb.d/10-runtime.sh:ro" \
  postgres:17.11-alpine)"

cleanup_container() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Stopping isolated recovery container..."
  docker stop "$CONTAINER_ID" >/dev/null 2>&1 || true
  docker network rm "$RECOVERY_NETWORK" >/dev/null 2>&1 || true
}
trap 'cleanup_container; cleanup' EXIT INT TERM

# Wait for healthy database
until docker exec "$CONTAINER_ID" pg_isready -U socialflow_migration -d socialflow >/dev/null 2>&1; do
  sleep 1
done

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Isolated PostgreSQL ready. Creating restore_check database..."

# 5. Create restore_check database and run pg_restore
docker exec "$CONTAINER_ID" createdb -U socialflow_migration restore_check

docker cp "$DECRYPTED_DUMP" "${CONTAINER_ID}:/tmp/restore.dump"

docker exec "$CONTAINER_ID" pg_restore \
  -U socialflow_migration \
  -d restore_check \
  --exit-on-error \
  --single-transaction \
  --no-owner \
  /tmp/restore.dump

docker exec "$CONTAINER_ID" rm -f /tmp/restore.dump

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Database restored successfully."

# 6. Validate restored data invariants
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Validating schema and security invariants..."

# A: Check migrations
MIGRATIONS_COUNT="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
if [[ "$MIGRATIONS_COUNT" -lt 4 ]]; then
  echo "[ERROR] Expected at least 4 finished migrations, found $MIGRATIONS_COUNT" >&2
  exit 5
fi

# B: Check RLS and FORCE RLS on sensitive tables
RLS_CHECK="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT count(*) FROM pg_class 
  WHERE relname IN ('Brand', 'Client', 'Organization', 'Membership', 'AuditLog') 
    AND relrowsecurity = true 
    AND relforcerowsecurity = true;
")"
if [[ "$RLS_CHECK" -ne 5 ]]; then
  echo "[ERROR] RLS or FORCE RLS missing on some tables (found $RLS_CHECK/5)" >&2
  exit 6
fi

# C: Check ownership dynamically across ALL public tables (not a hardcoded
# subset -- a hardcoded list silently stops covering new tables, e.g. Brand
# was missing from this check until this revision). Runtime must own nothing.
OWNER_MISMATCH="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT count(*) FROM pg_tables
  WHERE schemaname = 'public' AND tableowner <> 'socialflow_migration';
")"
if [[ "$OWNER_MISMATCH" -ne 0 ]]; then
  echo "[ERROR] $OWNER_MISMATCH public table(s) not owned by socialflow_migration after --no-owner restore" >&2
  docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public' AND tableowner <> 'socialflow_migration';" >&2
  exit 7
fi
RUNTIME_OWNS="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'socialflow_runtime';
")"
if [[ "$RUNTIME_OWNS" -ne 0 ]]; then
  echo "[ERROR] socialflow_runtime owns $RUNTIME_OWNS table(s); runtime must never be a table owner" >&2
  exit 7
fi

# D: Check runtime role attributes (must NOT have any elevated attribute)
RUNTIME_CHECK="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'socialflow_runtime';
")"
if [[ "$RUNTIME_CHECK" != "f" ]]; then
  echo "[ERROR] socialflow_runtime role has an elevated attribute (superuser/bypassrls/createdb/createrole)!" >&2
  exit 8
fi

# D2: Runtime must not hold DELETE on core identity/business tables (only the
# ephemeral/diagnostic tables Session/Verification/RateLimit intentionally
# grant DELETE -- see packages/db/prisma/migrations/202609110002_isolation).
CORE_TABLES=(User Organization Membership Client Brand AuditLog Account)
for tbl in "${CORE_TABLES[@]}"; do
  HAS_DELETE="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
    SELECT has_table_privilege('socialflow_runtime', '\"${tbl}\"', 'DELETE');
  ")"
  if [[ "$HAS_DELETE" != "f" ]]; then
    echo "[ERROR] socialflow_runtime unexpectedly has DELETE on \"${tbl}\" after restore" >&2
    exit 8
  fi
done

# E2: Authenticated access is authorized for the actor's own organization AND
# blocked for a different one -- reproduces exactly the mechanism packages/db
# asActor() uses (set_config('app.user_id', ...) inside a transaction, read
# by the current_actor()/organization_read policy), using a real restored
# identity. This is stronger than the anonymous-401 check in step F: it
# proves row-level authorization on real data, not just "no session = 401".
# Skipped gracefully (not counted as a pass) if the dataset has no user with
# memberships in two distinct organizations to test cross-org blocking with.
ACTOR_TEST="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT m.\"userId\" || '|' || m.\"organizationId\"
  FROM \"Membership\" m
  JOIN \"User\" u ON u.id = m.\"userId\" AND u.active
  WHERE m.active
  ORDER BY m.\"userId\"
  LIMIT 1;
")"
OTHER_ORG="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT id FROM \"Organization\" WHERE active AND id <> '${ACTOR_TEST#*|}' LIMIT 1;
" 2>/dev/null || true)"
if [[ -n "$ACTOR_TEST" && -n "$OTHER_ORG" ]]; then
  ACTOR_USER="${ACTOR_TEST%%|*}"
  ACTOR_ORG="${ACTOR_TEST#*|}"
  # NOTE: `SELECT set_config(...)` itself returns a row (the value set), and
  # -t still prints BEGIN/COMMIT command tags. A marker prefix on the count
  # row avoids any ambiguity, including the edge case of a purely numeric
  # user id colliding with a bare count line.
  OWN_ORG_VISIBLE="$(docker exec "$CONTAINER_ID" psql -U socialflow_runtime -d restore_check -t -A -c "
    BEGIN;
    SELECT set_config('app.user_id', '${ACTOR_USER}', true);
    SELECT 'COUNT_MARKER:' || count(*) FROM \"Organization\" WHERE id = '${ACTOR_ORG}';
    COMMIT;
  " | grep '^COUNT_MARKER:' | cut -d: -f2)"
  OTHER_ORG_VISIBLE="$(docker exec "$CONTAINER_ID" psql -U socialflow_runtime -d restore_check -t -A -c "
    BEGIN;
    SELECT set_config('app.user_id', '${ACTOR_USER}', true);
    SELECT 'COUNT_MARKER:' || count(*) FROM \"Organization\" WHERE id = '${OTHER_ORG}';
    COMMIT;
  " | grep '^COUNT_MARKER:' | cut -d: -f2)"
  if [[ "$OWN_ORG_VISIBLE" != "1" || "$OTHER_ORG_VISIBLE" != "0" ]]; then
    echo "[ERROR] Authenticated cross-org isolation check failed on restored data: own org visible=${OWN_ORG_VISIBLE} (expected 1), other org visible=${OTHER_ORG_VISIBLE} (expected 0)" >&2
    exit 8
  fi
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Authenticated access verified: real actor sees own org, not another org (RLS enforced on restored data)."
else
  echo "[WARNING] Skipped authenticated/cross-org check: dataset has no user+second-organization pair to test with." >&2
fi

# F: Boot the application against the restored database on the isolated
# network and confirm it actually works (health + auth), not just that the
# schema looks right. Best-effort: on a bare recovery host without the app
# image built/pulled, this is skipped and reported as a PENDING gap rather
# than silently counted as passed.
APP_CHECK_STATUS="skipped_no_image"
APP_IMAGE="${SOCIALFLOW_APP_IMAGE:-socialflow-api}"
if docker image inspect "$APP_IMAGE" >/dev/null 2>&1; then
  APP_CHECK_STATUS="failed"
  APP_CONTAINER="${PROJECT_NAME}-api"
  # readConfig() (packages/config) enforces production-grade isolation even in
  # this throwaway container: independent >=24-char DB/Redis passwords, no
  # migration-role leakage, HTTPS APP_URL. Satisfying it here is itself part
  # of proving the restored app boots the way it would in real production.
  APP_SESSION_SECRET="$(openssl rand -hex 32)"
  APP_REDIS_PASSWORD="$(openssl rand -hex 16)"
  docker run -d --rm \
    --name "${PROJECT_NAME}-redis" --network "$RECOVERY_NETWORK" redis:8.10.0-alpine \
    sh -c "exec redis-server --requirepass '${APP_REDIS_PASSWORD}'" >/dev/null 2>&1 || true
  docker run -d --rm \
    --name "$APP_CONTAINER" \
    --network "$RECOVERY_NETWORK" \
    -e NODE_ENV=production \
    -e APP_ENV=production \
    -e APP_URL="https://recovery-drill.invalid" \
    -e SESSION_SECRET="$APP_SESSION_SECRET" \
    -e DATABASE_URL="postgresql://socialflow_runtime:${RUNTIME_DB_PASSWORD}@${PROJECT_NAME}-postgres:5432/restore_check" \
    -e REDIS_URL="redis://:${APP_REDIS_PASSWORD}@${PROJECT_NAME}-redis:6379" \
    "$APP_IMAGE" >/dev/null 2>&1 || true

  APP_READY=false
  for _ in $(seq 1 30); do
    if docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3001/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      APP_READY=true
      break
    fi
    sleep 1
  done

  if [[ "$APP_READY" == "true" ]]; then
    # Unauthenticated request to a protected route must be rejected (401),
    # proving the auth code path queries the restored User/Session tables
    # through socialflow_runtime successfully rather than crashing (500) or
    # silently succeeding.
    AUTH_STATUS="$(docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3001/api/me').then(r=>{console.log(r.status)}).catch(()=>console.log('ERR'))" 2>/dev/null || echo 'ERR')"
    if [[ "$AUTH_STATUS" == "401" ]]; then
      APP_CHECK_STATUS="passed"
    else
      echo "[ERROR] Restored app health passed but /api/me returned '${AUTH_STATUS}' instead of 401" >&2
    fi
  else
    echo "[ERROR] Restored app container did not reach /health/ready in time. Container logs:" >&2
    docker logs "$APP_CONTAINER" 2>&1 | tail -20 >&2 || true
  fi
  docker stop "$APP_CONTAINER" "${PROJECT_NAME}-redis" >/dev/null 2>&1 || true
else
  echo "[PENDING] Application image '${APP_IMAGE}' not available locally; isolamento/autenticacao/funcionamento da aplicacao restaurada NAO foi validado nesta execucao. Set SOCIALFLOW_APP_IMAGE or run this on a host with the image, then re-run." >&2
fi

if [[ "$APP_CHECK_STATUS" == "failed" ]]; then
  echo "[ERROR] Application-level restore validation failed (see above)." >&2
  exit 9
fi

# E: Count records and find latest audit timestamp (RPO point-in-time)
COUNTS="$(docker exec "$CONTAINER_ID" psql -U socialflow_migration -d restore_check -t -A -c "
  SELECT json_build_object(
    'organizations', (SELECT count(*) FROM \"Organization\"),
    'users', (SELECT count(*) FROM \"User\"),
    'clients', (SELECT count(*) FROM \"Client\"),
    'brands', (SELECT count(*) FROM \"Brand\"),
    'memberships', (SELECT count(*) FROM \"Membership\"),
    'auditLogs', (SELECT count(*) FROM \"AuditLog\"),
    'latestAudit', (SELECT max(\"createdAt\") FROM \"AuditLog\")
  );
")"

END_TIME="$(date +%s)"
DURATION=$((END_TIME - START_TIME))

# RPO must be measured against the last CONFIRMED external backup, never
# against a data field like the latest audit-log row (that reflects when the
# source system last wrote data, not when it was last safely copied off-site).
EFFECTIVE_ENV="${TARGET_ENV:-$DETECTED_ENV}"
REMOTE_STATUS_FILE="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}/last_successful_remote_backup_${EFFECTIVE_ENV}.json"
if [[ ! -f "$REMOTE_STATUS_FILE" ]]; then
  REMOTE_STATUS_FILE="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}/last_successful_remote_backup.json"
fi
RPO_NOTE="RPO indeterminado: ${REMOTE_STATUS_FILE} nao encontrado (nenhum envio externo confirmado registrado)."
if [[ -f "$REMOTE_STATUS_FILE" ]]; then
  LAST_REMOTE_TS="$(grep -o '"timestamp": *"[^"]*"' "$REMOTE_STATUS_FILE" | head -n1 | cut -d'"' -f4)"
  if [[ -n "$LAST_REMOTE_TS" ]]; then
    LAST_REMOTE_EPOCH="$(date -u -d "$LAST_REMOTE_TS" +%s 2>/dev/null || echo 0)"
    NOW_EPOCH="$(date -u +%s)"
    AGE_HOURS=$(( (NOW_EPOCH - LAST_REMOTE_EPOCH) / 3600 ))
    RPO_NOTE="Ultimo backup externo confirmado (${EFFECTIVE_ENV^^}): ${LAST_REMOTE_TS} (${AGE_HOURS}h atras)."
  fi
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] RESTORE VERIFICATION PASSED!"
echo "Environment Context: ${EFFECTIVE_ENV^^} (target: ${TARGET_ENV:-none}, provenance: ${DETECTED_ENV})"
echo "Recovery Time (RTO, full procedure from source resolution to validation): ${DURATION}s"
echo "Application-level validation (health/auth): ${APP_CHECK_STATUS}"
echo "Backup source exercised: ${DOWNLOAD_SOURCE}"
echo "${RPO_NOTE}"
echo "Recovered Data Inventory: ${COUNTS}"
