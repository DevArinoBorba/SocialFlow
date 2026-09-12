#!/bin/sh
set -eu
if [ "${#RUNTIME_DB_PASSWORD}" -lt 24 ] || [ "${#POSTGRES_PASSWORD}" -lt 24 ] || [ "$RUNTIME_DB_PASSWORD" = "$POSTGRES_PASSWORD" ]; then
  echo 'Independent migration/runtime passwords of at least 24 characters required' >&2
  exit 1
fi
# psql variables quote SQL literals; never concatenate secrets into SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=runtime_password="$RUNTIME_DB_PASSWORD" <<'SQL'
CREATE ROLE socialflow_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO socialflow_runtime;
SQL
