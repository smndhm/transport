#!/usr/bin/env bash
# Applique les migrations sur un PostgreSQL jetable, les rejoue une
# seconde fois (elles doivent être idempotentes) et lance les contrôles.
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
# Les migrations dans l'ordre, comme le fera Supabase à chaque push.
# Elles sont copiées dans un dossier lisible par postgres : le dépôt ne
# l'est pas forcément.
TMP=$(mktemp -d); chmod 755 "$TMP"
cp supabase/migrations/*.sql db/test/prelude.sql "$TMP/"; chmod 644 "$TMP"/*.sql
trap 'sudo -u postgres "$PGBIN/pg_ctl" -D "$DATA/data" stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
run -q -v ON_ERROR_STOP=1 -f "$TMP/prelude.sql"
for m in "$TMP"/*_*.sql; do
  echo "→ $(basename "$m")"
  run -q -v ON_ERROR_STOP=1 -f "$m"
done
# Rejouées une seconde fois : une migration doit être rejouable.
for m in "$TMP"/*_*.sql; do run -q -v ON_ERROR_STOP=1 -f "$m" >/dev/null; done
# Ce que la plateforme fournit, et elle seule : l'accès aux schémas et à
# auth.users. Les droits sur NOS tables ne sont plus accordés d'office
# depuis le 30 octobre 2026 — c'est aux migrations de les déclarer, donc
# le banc d'essai ne les ajoute pas : il vérifie qu'elles le font.
run -q -v ON_ERROR_STOP=1 -c "grant usage on schema auth, public to anon, authenticated, service_role;
  grant select on auth.users to anon, authenticated;"
cp db/test/checks.sql "$TMP/"; chmod 644 "$TMP/checks.sql"
run -f "$TMP/checks.sql"
