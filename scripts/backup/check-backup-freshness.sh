#!/usr/bin/env bash
# SocialFlow Backup Freshness Watchdog
#
# Independent of socialflow-backup.sh and its cron entry: this script only
# reads the "last successful external backup" marker and alerts if it is
# missing or stale. It must be scheduled as a SEPARATE cron/systemd-timer
# entry (different time of day) from the backup job itself, so that if the
# backup cron entry is removed or disabled, this watchdog can still detect
# staleness. It cannot run if its own scheduler or the VPS is unavailable.
# A check that only
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

LAST_TS="$(grep -o '"timestamp": *"[^"]*"' "$REMOTE_STATUS_FILE" | head -n1 | cut -d'"' -f4 || true)"
if [[ -z "$LAST_TS" ]]; then
  MSG="Arquivo ${REMOTE_STATUS_FILE} presente mas sem timestamp legivel."
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 2
fi

if [[ ! "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || ! LAST_EPOCH="$(date -u -d "$LAST_TS" +%s 2>/dev/null)"; then
  MSG='Configuracao de idade ou timestamp de backup invalido.'
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 2
fi
NOW_EPOCH="$(date -u +%s)"
AGE_SECONDS=$((NOW_EPOCH - LAST_EPOCH))
AGE_HOURS=$((AGE_SECONDS / 3600))
if [[ "$AGE_SECONDS" -lt 0 ]]; then
  MSG='Timestamp de backup esta no futuro; conferir os relogios.'
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 2
fi

if [[ "$AGE_SECONDS" -gt $((MAX_AGE_HOURS * 3600)) ]]; then
  MSG="Ultimo backup externo confirmado foi ha ${AGE_HOURS}h (limite ${MAX_AGE_HOURS}h). Verifique o cron e o script socialflow-backup.sh na VPS."
  echo "[CRITICAL] $MSG" >&2
  send_discord_alert "$MSG"
  exit 1
fi

echo "[OK] Last confirmed external backup: ${LAST_TS} (${AGE_HOURS}h ago, within ${MAX_AGE_HOURS}h)."
exit 0
