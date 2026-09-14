#!/usr/bin/env bash
# SocialFlow Backup Freshness Watchdog
#
# Independent of socialflow-backup.sh and its cron entry: this script only
# reads the "last successful external backup" marker and alerts if it is
# missing or stale. It must be scheduled as a SEPARATE cron/systemd-timer
# entry (different time of day) from the backup job itself, so that if the
# backup cron entry is ever removed, disabled, or the box's cron daemon dies,
# this watchdog still fires and detects the staleness -- a check that only
# runs as a side effect of the backup script succeeding cannot do that.
#
# Exit codes: 0 = fresh, 1 = stale, 2 = never backed up / marker missing.
set -euo pipefail

CONFIG_FILE="${BACKUP_CONFIG_FILE:-/root/.config/socialflow/backup.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/root/backups/socialflow}"
# Deliberately reads the file socialflow-backup.sh writes ONLY after a
# verified remote upload -- never last_backup.json, which also records
# local-only runs (missing credentials, failed upload) as a local success.
REMOTE_STATUS_FILE="${BACKUP_LOCAL_DIR}/last_successful_remote_backup.json"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}" # RPO is 24h; small margin for run jitter.
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

send_discord_alert() {
  local message="$1"
  if [[ -n "$DISCORD_WEBHOOK_URL" ]]; then
    curl -s -S -X POST -H "Content-Type: application/json" \
      -d "{\"embeds\":[{\"title\":\"SocialFlow Backup: ATRASADO\",\"description\":\"${message}\",\"color\":15158332}]}" \
      "$DISCORD_WEBHOOK_URL" >/dev/null || true
  fi
}

if [[ ! -f "$REMOTE_STATUS_FILE" ]]; then
  MSG="Nenhum backup externo confirmado foi registrado ainda em ${REMOTE_STATUS_FILE}."
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 2
fi

LAST_TS="$(grep -o '"timestamp": *"[^"]*"' "$REMOTE_STATUS_FILE" | head -n1 | cut -d'"' -f4)"
if [[ -z "$LAST_TS" ]]; then
  MSG="Arquivo ${REMOTE_STATUS_FILE} presente mas sem timestamp legivel."
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 2
fi

LAST_EPOCH="$(date -u -d "$LAST_TS" +%s)"
NOW_EPOCH="$(date -u +%s)"
AGE_HOURS=$(( (NOW_EPOCH - LAST_EPOCH) / 3600 ))

if [[ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]]; then
  MSG="Ultimo backup externo confirmado foi ha ${AGE_HOURS}h (limite ${MAX_AGE_HOURS}h). Verifique o cron e o script socialflow-backup.sh na VPS."
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 1
fi

echo "[OK] Last confirmed external backup: ${LAST_TS} (${AGE_HOURS}h ago, within ${MAX_AGE_HOURS}h)."
exit 0
