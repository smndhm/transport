#!/usr/bin/env bash
# Applique le schéma sur un PostgreSQL jetable et rejoue les vérifications.
# Usage : db/test/run.sh          (nécessite postgresql >= 15 installé)
set -euo pipefail
cd "$(dirname "$0")/../.."

PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}
DATA=${DATA:-/var/lib/postgresql/transport-check}
PORT=${PORT:-55432}

sudo -u postgres rm -rf "$DATA"
sudo -u postgres mkdir -p "$DATA"
sudo -u postgres "$PGBIN/initdb" -D "$DATA/data" -U postgres --auth=trust >/dev/null
sudo -u postgres "$PGBIN/pg_ctl" -D "$DATA/data" -o "-p $PORT" -l "$DATA/pg.log" start >/dev/null
trap 'sudo -u postgres "$PGBIN/pg_ctl" -D "$DATA/data" stop >/dev/null 2>&1 || true' EXIT
sleep 2

run() { sudo -u postgres psql -p "$PORT" -U postgres "$@"; }
run -q -v ON_ERROR_STOP=1 -f db/test/prelude.sql -f db/schema.sql
# Droits que Supabase accorde automatiquement au rôle authenticated.
run -q -v ON_ERROR_STOP=1 -c "grant usage on schema auth, public to anon, authenticated;
  grant select on auth.users to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;"
run -f db/test/checks.sql
