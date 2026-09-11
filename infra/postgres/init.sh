#!/bin/sh
set -eu
# psql variables quote SQL literals; never concatenate secrets into SQL.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=runtime_password="$RUNTIME_DB_PASSWORD" <<'SQL'
CREATE ROLE socialflow_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO socialflow_runtime;
SQL
