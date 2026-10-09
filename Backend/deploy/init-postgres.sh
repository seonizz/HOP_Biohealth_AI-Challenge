#!/usr/bin/env bash
set -euo pipefail
# Official PostgreSQL entrypoint runs this only for a new, empty data directory.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv migrator_password HOP_DB_MIGRATOR_PASSWORD
\getenv app_password HOP_DB_APP_PASSWORD
SELECT format('CREATE ROLE hop_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE hop_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') \gexec
REVOKE ALL ON DATABASE hop FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE hop TO hop_migrator;
GRANT CONNECT ON DATABASE hop TO hop_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO hop_migrator;
GRANT USAGE ON SCHEMA public TO hop_app;
SQL
