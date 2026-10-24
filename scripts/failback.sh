#!/usr/bin/env bash
# After a failover, once Neon is healthy again: copies everything entered on Supabase
# back into Neon, then points the app at Neon again.
#   SOURCE_DATABASE_URL=<neon> BACKUP_DATABASE_URL=<supabase> scripts/failback.sh --confirm
# This replaces Neon's public schema, so it first saves Neon as it is to
# ~/neon-before-failback-<time>.dump. Run it at a quiet moment: anything saved on
# Supabase during the minute or so it takes won't be carried over.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is not set}"
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"

if [ "${1:-}" != "--confirm" ]; then
  echo "This overwrites Neon with the Supabase copy. Run again with --confirm to go ahead." >&2
  exit 1
fi
case "$BACKUP_DATABASE_URL" in
  *neon.tech*) echo "Refusing to run: BACKUP_DATABASE_URL points at Neon." >&2; exit 1 ;;
esac

export PGCONNECT_TIMEOUT=20
# Neon URLs use sslmode=verify-full; check its certificate against the OS trust store.
case "$SOURCE_DATABASE_URL" in *sslmode=verify-full*) NEON_SSL="env PGSSLROOTCERT=system" ;; *) NEON_SSL="env" ;; esac
# pg_dump clears search_path for its session. Through Neon's pooler (transaction mode)
# that setting stays on a shared server connection and the app then can't find its
# tables, so always dump over the direct endpoint.
NEON_DIRECT=${SOURCE_DATABASE_URL/-pooler./.}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

active=$(psql "$BACKUP_DATABASE_URL" --no-psqlrc -At -c "select active from backup_meta.failover where id = 1")
if [ "$active" != "supabase" ]; then
  echo "The app isn't failed over (it's using $active), so there is nothing to copy back." >&2
  exit 1
fi

saved=~/neon-before-failback-$(date +%Y%m%d-%H%M%S).dump
(umask 077 && $NEON_SSL pg_dump --format=custom --no-owner --no-privileges --file="$saved" "$NEON_DIRECT")
echo "Saved Neon's current data to $saved"

pg_dump --format=custom --schema=public --no-owner --no-privileges --file="$work/supabase.dump" "$BACKUP_DATABASE_URL"

{
  echo "set client_min_messages = warning; drop schema if exists public cascade;"  # the dump recreates it
  pg_restore --no-owner --no-privileges --file=- "$work/supabase.dump"
  echo "reset all;"
} | $NEON_SSL psql "$NEON_DIRECT" --single-transaction --quiet --no-psqlrc --set=ON_ERROR_STOP=1 >/dev/null

psql "$BACKUP_DATABASE_URL" --no-psqlrc --quiet -c \
  "update backup_meta.failover set active = 'neon', switched_at = now(), reason = 'Failed back by hand' where id = 1"

echo "Done. Neon has Supabase's data and the app switches back within about 10 seconds."
echo "The next scheduled backup copies Neon to Supabase again."
