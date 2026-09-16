#!/usr/bin/env bash
# Targeted failure tests of the backup script, using disposable tool doubles.
# Run inside a disposable Linux container or locally via bash; no real R2 access, alerts or retention.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd || echo '/repo')"
if [[ ! -f "${REPO_ROOT}/scripts/backup/socialflow-backup.sh" && -f "/repo/scripts/backup/socialflow-backup.sh" ]]; then
  REPO_ROOT="/repo"
fi
BACKUP_SH="${REPO_ROOT}/scripts/backup/socialflow-backup.sh"
FRESHNESS_SH="${REPO_ROOT}/scripts/backup/check-backup-freshness.sh"

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

cat > "$root/bin/flock" <<'MOCK'
#!/bin/bash
exit 0
MOCK

cat > "$root/bin/docker" <<'MOCK'
#!/bin/bash
set -eu
if [[ "$1" == exec ]]; then exit 0; fi
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

export BACKUP_CONFIG_FILE="$root/missing.env"
export R2_BUCKET=dedicated-test
export R2_ENDPOINT=https://example.invalid
SECRET_TEST_TOKEN="super_secret_test_key_xyz987"
export R2_SECRET_ACCESS_KEY="$SECRET_TEST_TOKEN"
export DISCORD_WEBHOOK_URL= RETENTION_DAYS=0

echo "=== 1. Testando Modos de Falha e Sucesso em Homologação ==="
export SOCIALFLOW_ENV=homolog POSTGRES_CONTAINER=disposable-test-homolog
export R2_PREFIX=backups/socialflow/homolog

for MODE in no_credentials upload_failure larger corrupt read_failure missing_checksum success; do
  export MODE BACKUP_LOCAL_DIR="$root/$MODE" BACKUP_LOCK_FILE="$root/$MODE.lock"
  mkdir -p "$BACKUP_LOCAL_DIR"
  marker="$BACKUP_LOCAL_DIR/last_successful_remote_backup_homolog.json"
  printf '{"timestamp":"2026-01-01T00:00:00Z","environment":"homolog"}' > "$marker"
  original=$(sha256sum "$marker")
  if [[ "$MODE" == no_credentials ]]; then export R2_ACCESS_KEY_ID=; else export R2_ACCESS_KEY_ID=test; fi
  status=0
  bash "$BACKUP_SH" > "$root/output" 2>&1 || status=$?

  # Check secret leakage
  if grep -q "$SECRET_TEST_TOKEN" "$root/output"; then
    echo "FAIL: Secret leaked in logs during mode $MODE!" >&2
    exit 1
  fi

  if [[ "$MODE" == success ]]; then
    [[ $status == 0 ]]
    grep -q '"status": "success_remote"' "$BACKUP_LOCAL_DIR/last_backup_homolog.json"
    grep -q '"environment": "homolog"' "$BACKUP_LOCAL_DIR/last_backup_homolog.json"
    [[ "$(sha256sum "$marker")" != "$original" ]]
  else
    [[ "$(sha256sum "$marker")" == "$original" ]]
    if [[ "$MODE" == no_credentials ]]; then
      grep -q success_local_only "$BACKUP_LOCAL_DIR/last_backup_homolog.json"
    else
      [[ $status != 0 ]]
    fi
  fi
  echo "PASS homolog-$MODE"
done

echo "=== 2. Testando Sucesso e Isolamento em Produção ==="
export SOCIALFLOW_ENV=prod POSTGRES_CONTAINER=disposable-test-prod
export R2_PREFIX=backups/socialflow/prod
export R2_ACCESS_KEY_ID=test
export MODE=success
export BACKUP_LOCAL_DIR="$root/prod-success" BACKUP_LOCK_FILE="$root/prod-success.lock"
mkdir -p "$BACKUP_LOCAL_DIR"

prod_marker="$BACKUP_LOCAL_DIR/last_successful_remote_backup_prod.json"
homolog_marker="$BACKUP_LOCAL_DIR/last_successful_remote_backup_homolog.json"
printf '{"timestamp":"2026-01-01T00:00:00Z","environment":"prod"}' > "$prod_marker"
printf '{"timestamp":"2026-01-01T00:00:00Z","environment":"homolog"}' > "$homolog_marker"
original_homolog=$(sha256sum "$homolog_marker")

status=0
bash "$BACKUP_SH" > "$root/output-prod" 2>&1 || status=$?
[[ $status == 0 ]]

# Verify production marker updated
grep -q '"environment": "prod"' "$prod_marker"
grep -q 'backups/socialflow/prod' "$prod_marker"
grep -q '"status": "success_remote"' "$BACKUP_LOCAL_DIR/last_backup_prod.json"

# Verify homologation marker was NOT touched
[[ "$(sha256sum "$homolog_marker")" == "$original_homolog" ]]
echo "PASS prod-success and homologation isolation"

echo "=== 3. Testando Proteção Contra Sobregravação Cruzada (Cross-Environment) ==="
# Test A: prod targeting homolog prefix must fail
export SOCIALFLOW_ENV=prod R2_PREFIX=backups/socialflow/homolog
status=0
bash "$BACKUP_SH" > "$root/output-cross-a" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Cross-environment violation' "$root/output-cross-a"
echo "PASS cross-env-protection (prod cannot write to homolog prefix)"

# Test B: homolog targeting prod prefix must fail
export SOCIALFLOW_ENV=homolog R2_PREFIX=backups/socialflow/prod
status=0
bash "$BACKUP_SH" > "$root/output-cross-b" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Cross-environment violation' "$root/output-cross-b"
echo "PASS cross-env-protection (homolog cannot write to prod prefix)"

# Test C: prod targeting homologation container must fail
export SOCIALFLOW_ENV=prod R2_PREFIX=backups/socialflow/prod POSTGRES_CONTAINER=postgres-4iuijgj7ocivevuow4yga8z7-test
status=0
bash "$BACKUP_SH" > "$root/output-cross-c" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Safety violation' "$root/output-cross-c"
echo "PASS cross-container-protection (prod cannot target homologation container)"

# Test D: homolog targeting production container must fail
export SOCIALFLOW_ENV=homolog R2_PREFIX=backups/socialflow/homolog POSTGRES_CONTAINER=postgres-drio4inydistgaevc6az7kks-test
status=0
bash "$BACKUP_SH" > "$root/output-cross-d" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Safety violation' "$root/output-cross-d"
echo "PASS cross-container-protection (homolog cannot target production container)"

echo "=== 4. Testando Falha com Ambiente Não Especificado ==="
unset SOCIALFLOW_ENV APP_ENV ENVIRONMENT
status=0
bash "$BACKUP_SH" > "$root/output-no-env" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Target environment must be explicitly specified' "$root/output-no-env"
echo "PASS missing-environment-fails"

export SOCIALFLOW_ENV=invalid_env
status=0
bash "$BACKUP_SH" > "$root/output-invalid-env" 2>&1 || status=$?
[[ $status == 2 ]]
grep -q 'Invalid target environment' "$root/output-invalid-env"
echo "PASS invalid-environment-fails"

echo "=== 5. Testando Watchdog de Frescor para Prod e Homolog ==="
for env in prod homolog; do
  for scenario in fresh stale missing invalid future; do
    export BACKUP_LOCAL_DIR="$root/watch-$env-$scenario"
    mkdir -p "$BACKUP_LOCAL_DIR"
    case "$scenario" in
      fresh) ts=$(date -u +%FT%TZ); expected=0 ;;
      stale) ts=$(date -u -d '26 hours ago 1 minute ago' +%FT%TZ); expected=1 ;;
      missing) ts=; expected=2 ;;
      invalid) ts=invalid; expected=2 ;;
      future) ts=$(date -u -d '1 hour' +%FT%TZ); expected=2 ;;
    esac
    if [[ "$scenario" != missing ]]; then
      printf '{"timestamp":"%s","environment":"%s"}' "$ts" "$env" > "$BACKUP_LOCAL_DIR/last_successful_remote_backup_${env}.json"
    fi
    status=0
    bash "$FRESHNESS_SH" "$env" > "$root/watch-output-$env-$scenario" 2>&1 || status=$?
    [[ "$status" == "$expected" ]]
    echo "PASS freshness-$env-$scenario"
  done
done

echo "=== 6. Testando Ausência de Vazamento de Segredos nos Logs ==="
for logfile in "$root"/output*; do
  if grep -q "$SECRET_TEST_TOKEN" "$logfile"; then
    echo "FAIL: Secret found in $logfile!" >&2
    exit 1
  fi
done
echo "PASS no-secrets-in-logs"

echo "=================================================="
echo "TODOS OS TESTES DE BACKUP E ISOLAMENTO PASSARAM!"
echo "=================================================="
