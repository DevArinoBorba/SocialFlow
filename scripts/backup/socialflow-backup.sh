#!/usr/bin/env bash
# SocialFlow Automated Encrypted Backup Script
# Consistent pg_dump -> TOC verify -> GPG asymmetric encryption -> SHA256 -> Remote S3/R2 -> Retention -> Discord Alert
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${BACKUP_CONFIG_FILE:-/root/.config/socialflow/backup.env}"
LOCK_FILE="${BACKUP_LOCK_FILE:-/tmp/socialflow-backup.lock}"

# Concurrency protection
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Backup already running. Exiting." >&2
  exit 1
fi

# Load config if present
if [[ -f "$CONFIG_FILE" ]]; then
  # Verify secure permissions (0600 or 0400)
  PERMS="$(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || stat -f '%Lp' "$CONFIG_FILE" 2>/dev/null || echo '0600')"
  if [[ "$PERMS" != "600" && "$PERMS" != "400" && "$PERMS" != "700" ]]; then
    echo "[WARNING] Config file permissions ($PERMS) are too open. Should be 0600." >&2
  fi
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# Defaults
POSTGRES_USER="${POSTGRES_USER:-socialflow_migration}"
POSTGRES_DB="${POSTGRES_DB:-socialflow}"
GPG_RECIPIENT="${GPG_RECIPIENT:-SocialFlow Backup}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PREFIX="${R2_PREFIX:-backups/socialflow/homolog}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}"
STAGING_DIR="${BACKUP_LOCAL_DIR}/staging"
# Pin the rclone image by tag (not :latest) so an upstream image change cannot
# silently alter upload/retention behavior. Update deliberately, re-run the drill.
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.68.2}"

START_TIME="$(date +%s)"
TIMESTAMP="$(date -u +'%Y%m%d_%H%M%S')"
BACKUP_BASE_NAME="socialflow_backup_${TIMESTAMP}"
RAW_DUMP="${STAGING_DIR}/${BACKUP_BASE_NAME}.dump"
ENCRYPTED_DUMP="${STAGING_DIR}/${BACKUP_BASE_NAME}.dump.gpg"
CHECKSUM_FILE="${STAGING_DIR}/${BACKUP_BASE_NAME}.sha256"
STATUS_FILE="${BACKUP_LOCAL_DIR}/last_backup.json"
# Written ONLY after a verified remote upload. This is the file monitoring/RPO
# checks must read -- last_backup.json alone conflates local-only runs with
# real off-site backups (see REMOTE_UPLOAD_CONFIRMED below).
REMOTE_STATUS_FILE="${BACKUP_LOCAL_DIR}/last_successful_remote_backup.json"
REMOTE_UPLOAD_CONFIRMED=false

# Staging directory setup with restricted permissions (0700)
mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"
umask 077

# Send alert to Discord if configured
send_discord_alert() {
  local status="$1"
  local message="$2"
  local color="$3"
  if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
    local payload
    payload="$(cat <<EOF
{
  "embeds": [{
    "title": "SocialFlow Backup: ${status}",
    "description": "${message}",
    "color": ${color},
    "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
    "footer": { "text": "SocialFlow Automated Backup" }
  }]
}
EOF
)"
    curl -s -S -X POST -H "Content-Type: application/json" -d "$payload" "$DISCORD_WEBHOOK_URL" >/dev/null || true
  fi
}

cleanup() {
  local exit_code=$?
  rm -f "$RAW_DUMP" 2>/dev/null || true
  if [[ $exit_code -ne 0 ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Backup failed with exit code $exit_code" >&2
    rm -f "$ENCRYPTED_DUMP" "$CHECKSUM_FILE" 2>/dev/null || true
    echo "{\"timestamp\": \"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\", \"status\": \"failed\", \"exitCode\": $exit_code}" > "$STATUS_FILE"
    send_discord_alert "FALHA" "O backup falhou com código de saída ${exit_code}. Verifique os logs do servidor." 15158332
  fi
}
trap cleanup EXIT INT TERM

# 1. Discover PostgreSQL container
if [[ -z "${POSTGRES_CONTAINER:-}" ]]; then
  # Look for running postgres container for socialflow
  POSTGRES_CONTAINER="$(docker ps --filter "name=postgres" --format "{{.Names}}" | grep -E "socialflow|4iuijgj7ocivevuow4yga8z7" | head -n 1 || true)"
  if [[ -z "$POSTGRES_CONTAINER" ]]; then
    # Fallback to any healthy container with label or name postgres
    POSTGRES_CONTAINER="$(docker ps --filter "name=postgres" --format "{{.Names}}" | head -n 1 || true)"
  fi
fi

if [[ -z "$POSTGRES_CONTAINER" ]]; then
  echo "[ERROR] Could not detect running PostgreSQL container." >&2
  exit 2
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting backup from container: ${POSTGRES_CONTAINER}"

# 2. Consistent pg_dump
DUMP_TMP="/tmp/${BACKUP_BASE_NAME}.dump"
docker exec "$POSTGRES_CONTAINER" sh -c "pg_dump -U '${POSTGRES_USER}' -d '${POSTGRES_DB}' -Fc -f '${DUMP_TMP}'"
docker cp "${POSTGRES_CONTAINER}:${DUMP_TMP}" "$RAW_DUMP"
docker exec "$POSTGRES_CONTAINER" rm -f "$DUMP_TMP"

# Verify dump is non-empty
if [[ ! -s "$RAW_DUMP" ]]; then
  echo "[ERROR] Dump file is empty or missing." >&2
  exit 3
fi

# 3. Verify dump TOC with pg_restore
docker exec -i "$POSTGRES_CONTAINER" pg_restore -l < "$RAW_DUMP" >/dev/null

DUMP_SIZE="$(stat -c '%s' "$RAW_DUMP" 2>/dev/null || stat -f '%z' "$RAW_DUMP" 2>/dev/null || wc -c < "$RAW_DUMP")"
echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] pg_dump verified successfully (${DUMP_SIZE} bytes)"

# 4. Encrypt with GPG
# Supports GPG asymmetric key recipient or fallback symmetric passphrase file
if [[ -n "${GPG_PASSPHRASE_FILE:-}" && -f "$GPG_PASSPHRASE_FILE" ]]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$GPG_PASSPHRASE_FILE" -o "$ENCRYPTED_DUMP" "$RAW_DUMP"
else
  gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_RECIPIENT" -o "$ENCRYPTED_DUMP" "$RAW_DUMP"
fi

if [[ ! -s "$ENCRYPTED_DUMP" ]]; then
  echo "[ERROR] Encryption failed or produced empty file." >&2
  exit 4
fi

# Shred/remove raw dump immediately after encryption
rm -f "$RAW_DUMP"

# 5. Calculate SHA256
cd "$STAGING_DIR"
sha256sum "$(basename "$ENCRYPTED_DUMP")" > "$CHECKSUM_FILE"
cd - >/dev/null
SHA256_VAL="$(cut -d' ' -f1 < "$CHECKSUM_FILE")"
ENC_SIZE="$(stat -c '%s' "$ENCRYPTED_DUMP" 2>/dev/null || stat -f '%z' "$ENCRYPTED_DUMP" 2>/dev/null || wc -c < "$ENCRYPTED_DUMP")"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Encrypted successfully (${ENC_SIZE} bytes, SHA256: ${SHA256_VAL})"

# 6. Upload to Cloudflare R2 / S3 (if destination configured)
# Credentials are passed as container env vars (RCLONE_CONFIG_*), never as
# CLI arguments: an argv-embedded secret is readable by any local user via
# `docker inspect`/`ps` on the running container, unlike an env var scoped to it.
REMOTE_ALIAS="socialflowr2"
if [[ -n "$R2_BUCKET" && -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
  RCLONE_ENV_ARGS=(
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_TYPE=s3"
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_PROVIDER=Cloudflare"
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_ENDPOINT=${R2_ENDPOINT}"
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}"
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}"
    -e "RCLONE_CONFIG_${REMOTE_ALIAS^^}_NO_CHECK_BUCKET=true"
  )
  REMOTE_TARGET="${REMOTE_ALIAS}:${R2_BUCKET}/${R2_PREFIX}"

  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Uploading to R2: ${R2_BUCKET}/${R2_PREFIX}"

  UPLOAD_OK=true
  docker run --rm "${RCLONE_ENV_ARGS[@]}" \
    -v "${STAGING_DIR}:/data:ro" \
    "$RCLONE_IMAGE" \
    copy "/data/$(basename "$ENCRYPTED_DUMP")" "$REMOTE_TARGET" --no-check-dest || UPLOAD_OK=false

  docker run --rm "${RCLONE_ENV_ARGS[@]}" \
    -v "${STAGING_DIR}:/data:ro" \
    "$RCLONE_IMAGE" \
    copy "/data/$(basename "$CHECKSUM_FILE")" "$REMOTE_TARGET" --no-check-dest || UPLOAD_OK=false

  if [[ "$UPLOAD_OK" != "true" ]]; then
    echo "[ERROR] Upload to R2 failed. Backup remains local-only; no external copy exists." >&2
    exit 5
  fi

  # Verify the actual bytes, not only object metadata. Preserve the previous
  # success marker if either object cannot be read back or has changed.
  REMOTE_SIZE="$(docker run --rm "${RCLONE_ENV_ARGS[@]}" "$RCLONE_IMAGE" size "$REMOTE_TARGET/$(basename "$ENCRYPTED_DUMP")" --json | grep -o '"bytes":[0-9]*' | cut -d: -f2 || echo '0')"
  if [[ ! "$REMOTE_SIZE" =~ ^[0-9]+$ || "$REMOTE_SIZE" -ne "$ENC_SIZE" ]]; then
    echo "[ERROR] Remote verification failed: remote size ($REMOTE_SIZE) does not match local ($ENC_SIZE)" >&2
    exit 5
  fi
  REMOTE_SHA256="$(docker run --rm "${RCLONE_ENV_ARGS[@]}" "$RCLONE_IMAGE" cat "$REMOTE_TARGET/$(basename "$ENCRYPTED_DUMP")" | sha256sum | cut -d' ' -f1)"
  REMOTE_CHECKSUM="$(docker run --rm "${RCLONE_ENV_ARGS[@]}" "$RCLONE_IMAGE" cat "$REMOTE_TARGET/$(basename "$CHECKSUM_FILE")")"
  if [[ "$REMOTE_SHA256" != "$SHA256_VAL" || "$REMOTE_CHECKSUM" != "$(cat "$CHECKSUM_FILE")" ]]; then
    echo '[ERROR] Remote ciphertext/checksum read-back verification failed.' >&2
    exit 5
  fi
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Remote verification passed: ${REMOTE_SIZE} bytes and SHA256 in R2"
  REMOTE_UPLOAD_CONFIRMED=true

  # 7. Retention: delete files older than RETENTION_DAYS strictly inside R2_PREFIX
  if [[ "${RETENTION_DAYS}" -gt 0 ]]; then
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Applying retention (${RETENTION_DAYS} days) on ${R2_BUCKET}/${R2_PREFIX}"
    docker run --rm "${RCLONE_ENV_ARGS[@]}" \
      "$RCLONE_IMAGE" \
      delete "$REMOTE_TARGET" --min-age "${RETENTION_DAYS}d" || true
  fi
else
  # Keep in local backup archive directory if remote not yet configured.
  # This is NOT an external backup: no off-site copy exists, so it must never
  # be reported as backup success to monitoring/RPO, only as a local artifact.
  mkdir -p "${BACKUP_LOCAL_DIR}/archive"
  cp "$ENCRYPTED_DUMP" "${BACKUP_LOCAL_DIR}/archive/"
  cp "$CHECKSUM_FILE" "${BACKUP_LOCAL_DIR}/archive/"
  echo "[WARNING] Remote storage not configured (missing R2 credentials). Encrypted dump stored ONLY locally in ${BACKUP_LOCAL_DIR}/archive/ -- this does NOT satisfy off-site backup / RPO."
fi

END_TIME="$(date +%s)"
DURATION=$((END_TIME - START_TIME))

# Record local-run status (always written; reflects whether a local encrypted
# artifact was produced, NOT whether it left the VPS).
LOCAL_STATUS=$([[ "$REMOTE_UPLOAD_CONFIRMED" == "true" ]] && echo "success_remote" || echo "success_local_only")
cat <<EOF > "$STATUS_FILE"
{
  "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "status": "${LOCAL_STATUS}",
  "remoteUploadConfirmed": ${REMOTE_UPLOAD_CONFIRMED},
  "backupFile": "$(basename "$ENCRYPTED_DUMP")",
  "sizeBytes": ${ENC_SIZE},
  "rawSizeBytes": ${DUMP_SIZE},
  "sha256": "${SHA256_VAL}",
  "durationSeconds": ${DURATION},
  "destination": "${R2_BUCKET:-local_archive}"
}
EOF

if [[ "$REMOTE_UPLOAD_CONFIRMED" == "true" ]]; then
  # Only a verified remote upload updates the "last successful external backup"
  # marker. Monitoring/RPO/staleness checks (check-backup-freshness.sh) must
  # read THIS file, never last_backup.json, so a missing-credential or failed
  # upload run cannot silently count as an off-site backup.
  cat <<EOF > "$REMOTE_STATUS_FILE"
{
  "timestamp": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "backupFile": "$(basename "$ENCRYPTED_DUMP")",
  "sizeBytes": ${ENC_SIZE},
  "sha256": "${SHA256_VAL}",
  "destination": "${R2_BUCKET}/${R2_PREFIX}"
}
EOF
  send_discord_alert "SUCESSO" "Backup diário concluído e enviado ao destino externo.\nArquivo: \`$(basename "$ENCRYPTED_DUMP")\`\nTamanho: $((ENC_SIZE / 1024)) KB\nDuração: ${DURATION}s\nSHA256: \`${SHA256_VAL}\`\nRetenção: ${RETENTION_DAYS} dias" 3066993
else
  send_discord_alert "ATENCAO: SEM ENVIO EXTERNO" "Dump local gerado e criptografado com sucesso, mas NAO foi enviado a nenhum destino externo (credenciais R2 ausentes). Isso NAO conta como backup externo valido para RPO.\nArquivo local: \`$(basename "$ENCRYPTED_DUMP")\`\nDuração: ${DURATION}s\nSHA256: \`${SHA256_VAL}\`" 16776960
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Backup process completed in ${DURATION}s. status=${LOCAL_STATUS} remoteUploadConfirmed=${REMOTE_UPLOAD_CONFIRMED}"
