#!/usr/bin/env bash
# Copies the live database (Neon) into the backup database (Supabase).
#   SOURCE_DATABASE_URL=... BACKUP_DATABASE_URL=... scripts/backup-db.sh
# Only reads from the source. The backup's public schema is replaced in a single
# transaction, so a failed run leaves the previous backup untouched.
# The repo is public and so are its Actions logs: never print row data or URLs.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is not set}"
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"

case "$BACKUP_DATABASE_URL" in
  *neon.tech*) echo "Refusing to run: the backup target is a Neon database." >&2; exit 1 ;;
esac
if [ "$SOURCE_DATABASE_URL" = "$BACKUP_DATABASE_URL" ]; then
  echo "Refusing to run: source and backup are the same database." >&2
  exit 1
fi

export PGCONNECT_TIMEOUT=20
# Neon URLs use sslmode=verify-full; check its certificate against the OS trust store.
case "$SOURCE_DATABASE_URL" in *sslmode=verify-full*) NEON_SSL="env PGSSLROOTCERT=system" ;; *) NEON_SSL="env" ;; esac
# pg_dump clears search_path for its session. Through Neon's pooler (transaction mode)
# that setting stays on a shared server connection and the app then can't find its
# tables, so always dump over the direct endpoint.
NEON_DIRECT=${SOURCE_DATABASE_URL/-pooler./.}
case "$NEON_DIRECT" in
  *-pooler*) echo "Refusing to run: couldn't work out Neon's direct (non-pooled) URL." >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  echo "$1 failed ($(grep -c 'error' "$work/log" || true) error lines). Run scripts/backup-db.sh locally to see details." >&2
  exit 1
}

# Supabase serves the public schema over its REST API to the anon and authenticated
# roles. The backup is never read that way, so keep those roles out of every table.
lock_down() {
  psql "$BACKUP_DATABASE_URL" --quiet --no-psqlrc --set=ON_ERROR_STOP=1 >/dev/null 2>"$work/log" <<'SQL' || fail "psql"
do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
  end if;
end $$;
SQL
}

lock_down

# After a failover the app writes to Supabase; copying Neon over it would erase that.
failover=$(psql "$BACKUP_DATABASE_URL" --no-psqlrc -At -c \
  "select active from backup_meta.failover where id = 1" 2>/dev/null || true)
if [ "$failover" = "supabase" ]; then
  echo "Refusing to run: the app has failed over to Supabase. Run scripts/failback.sh first." >&2
  exit 1
fi

$NEON_SSL pg_dump --format=custom --schema=public --no-owner --no-privileges \
  --file="$work/live.dump" "$NEON_DIRECT" 2>"$work/log" || fail "pg_dump"

# Rebuild the schema from scratch rather than pg_restore --clean, which errors on
# DROP TRIGGER for tables the backup doesn't have yet. psql -1 makes it all-or-nothing.
{
  echo "drop schema if exists public cascade;"  # the dump recreates it
  pg_restore --no-owner --no-privileges --file=- "$work/live.dump"
  echo "reset all;"  # undo the dump's search_path before the pooler reuses this connection
} 2>"$work/log" | psql "$BACKUP_DATABASE_URL" --single-transaction --quiet --no-psqlrc --set=ON_ERROR_STOP=1 \
  >>"$work/log" 2>&1 || fail "restore"
lock_down

# One row per run, outside the restored schema, so it is easy to see how fresh the backup is.
psql "$BACKUP_DATABASE_URL" --quiet --no-psqlrc --set=ON_ERROR_STOP=1 >/dev/null 2>"$work/log" <<'SQL' || fail "psql"
create schema if not exists backup_meta;
create table if not exists backup_meta.runs (
  finished_at timestamptz primary key default now(),
  teams int not null,
  participants int not null,
  check_ins int not null,
  coupons int not null
);
insert into backup_meta.runs (teams, participants, check_ins, coupons)
select (select count(*) from public.teams),
       (select count(*) from public.participants),
       (select count(*) from public.check_ins where undone_at is null),
       (select count(*) from public.coupon_issuances where reverted_at is null);
delete from backup_meta.runs where finished_at < now() - interval '30 days';
SQL

psql "$BACKUP_DATABASE_URL" --no-psqlrc -At -F ' ' -c \
  "select 'Backed up at ' || finished_at || ': ' || teams || ' teams, ' || participants || ' participants, ' || check_ins || ' checked in, ' || coupons || ' coupons'
   from backup_meta.runs order by finished_at desc limit 1" 2>"$work/log" || fail "psql"
