#!/usr/bin/env bash
# Targeted failure tests of the production script, using disposable tool doubles.
# Run inside a disposable Linux container; no R2 access, alerts or retention.
set -euo pipefail
root=$(mktemp -d)
mkdir "$root/bin"
export PATH="$root/bin:$PATH"
cat > "$root/bin/gpg" <<'MOCK'
#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then printf ciphertext > "$2"; exit 0; fi
  shift
done
exit 1
MOCK
cat > "$root/bin/docker" <<'MOCK'
#!/bin/bash
set -eu
if [[ "$1" == exec ]]; then cat >/dev/null; exit 0; fi
if [[ "$1" == cp ]]; then printf dump > "$3"; exit 0; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    copy) [[ "$MODE" != upload_failure ]]; exit ;;
    size) if [[ "$MODE" == larger ]]; then printf '{"bytes":11}'; else printf '{"bytes":10}'; fi; exit ;;
    cat)
      if [[ "$2" == *.sha256 ]]; then
        [[ "$MODE" != missing_checksum ]] || exit 1
        cat "$BACKUP_LOCAL_DIR"/staging/*.sha256
      else
        [[ "$MODE" != read_failure ]] || exit 1
        if [[ "$MODE" == corrupt ]]; then printf corrupt___; else printf ciphertext; fi
      fi
      exit ;;
    delete) exit 99 ;;
  esac
  shift
done
exit 1
MOCK
chmod +x "$root/bin/"*
export BACKUP_CONFIG_FILE="$root/missing.env" POSTGRES_CONTAINER=disposable-test
export R2_BUCKET=dedicated-test R2_PREFIX=backups/socialflow/homolog
export R2_ENDPOINT=https://example.invalid R2_ACCESS_KEY_ID=test R2_SECRET_ACCESS_KEY=test
export DISCORD_WEBHOOK_URL= RETENTION_DAYS=0
for MODE in no_credentials upload_failure larger corrupt read_failure missing_checksum success; do
  export MODE BACKUP_LOCAL_DIR="$root/$MODE" BACKUP_LOCK_FILE="$root/$MODE.lock"
  mkdir "$BACKUP_LOCAL_DIR"
  marker="$BACKUP_LOCAL_DIR/last_successful_remote_backup.json"
  printf '{"timestamp":"2026-01-01T00:00:00Z"}' > "$marker"
  original=$(sha256sum "$marker")
  if [[ "$MODE" == no_credentials ]]; then export R2_ACCESS_KEY_ID=; else export R2_ACCESS_KEY_ID=test; fi
  status=0
  bash /repo/scripts/backup/socialflow-backup.sh > "$root/output" 2>&1 || status=$?
  if [[ "$MODE" == success ]]; then
    [[ $status == 0 ]]
    grep -q '"status": "success_remote"' "$BACKUP_LOCAL_DIR/last_backup.json"
    [[ "$(sha256sum "$marker")" != "$original" ]]
  else
    [[ "$(sha256sum "$marker")" == "$original" ]]
    if [[ "$MODE" == no_credentials ]]; then
      grep -q success_local_only "$BACKUP_LOCAL_DIR/last_backup.json"
    else [[ $status != 0 ]]; fi
  fi
  echo "PASS $MODE"
done

for scenario in fresh stale missing invalid future; do
  export BACKUP_LOCAL_DIR="$root/watch-$scenario"
  mkdir "$BACKUP_LOCAL_DIR"
  case "$scenario" in
    fresh) ts=$(date -u +%FT%TZ); expected=0 ;;
    stale) ts=$(date -u -d '26 hours ago 1 minute ago' +%FT%TZ); expected=1 ;;
    missing) ts=; expected=2 ;;
    invalid) ts=invalid; expected=2 ;;
    future) ts=$(date -u -d '1 hour' +%FT%TZ); expected=2 ;;
  esac
  if [[ "$scenario" != missing ]]; then printf '{"timestamp":"%s"}' "$ts" > "$BACKUP_LOCAL_DIR/last_successful_remote_backup.json"; fi
  status=0
  bash /repo/scripts/backup/check-backup-freshness.sh > "$root/watch-output" 2>&1 || status=$?
  [[ "$status" == "$expected" ]]
  echo "PASS freshness-$scenario"
done
