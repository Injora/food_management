#!/usr/bin/env bash
# Checks that Neon answers. If it doesn't for about two minutes while Supabase does,
# flips the failover switch in Supabase so the app starts using the backup.
#   SOURCE_DATABASE_URL=... BACKUP_DATABASE_URL=... scripts/watch-neon.sh
# Exit 0: Neon is healthy, safe to back up. Exit 3: already failed over, so don't back
# up (it would overwrite what's been entered on Supabase). Exit 4: failed over just now.
# The switch never flips back on its own; scripts/failback.sh does that by hand.
# The repo is public and so are its Actions logs: never print row data or URLs.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is not set}"
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"

ATTEMPTS=${ATTEMPTS:-6}
PAUSE_SECONDS=${PAUSE_SECONDS:-20}
export PGCONNECT_TIMEOUT=15

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Neon URLs use sslmode=verify-full; check its certificate against the OS trust store.
neon_psql() {
  case "$SOURCE_DATABASE_URL" in
    *sslmode=verify-full*) PGSSLROOTCERT=system psql "$SOURCE_DATABASE_URL" "$@" ;;
    *) psql "$SOURCE_DATABASE_URL" "$@" ;;
  esac
}

backup_sql() {
  psql "$BACKUP_DATABASE_URL" --quiet --no-psqlrc --set=ON_ERROR_STOP=1 -At "$@" 2>"$work/backup.log"
}

if ! backup_sql >/dev/null <<'SQL'
create schema if not exists backup_meta;
create table if not exists backup_meta.failover (
  id int primary key default 1 check (id = 1),
  active text not null default 'neon' check (active in ('neon', 'supabase')),
  switched_at timestamptz,
  reason text,
  last_healthy_at timestamptz
);
alter table backup_meta.failover add column if not exists last_healthy_at timestamptz;
insert into backup_meta.failover (id) values (1) on conflict (id) do nothing;
SQL
then
  echo "Can't reach the Supabase backup, so there is nothing to fail over to." >&2
  exit 1
fi

active=$(backup_sql -c "select active || ' ' || coalesce(switched_at::text, '') from backup_meta.failover where id = 1")
if [ "${active%% *}" = "supabase" ]; then
  echo "Already failed over to Supabase (since ${active#* }). Backups are paused until scripts/failback.sh runs."
  exit 3
fi

for attempt in $(seq 1 "$ATTEMPTS"); do
  if neon_psql --no-psqlrc -Atc "select 1" >/dev/null 2>"$work/neon.log"; then
    backup_sql >/dev/null -c "update backup_meta.failover set last_healthy_at = now() where id = 1" || true
    echo "Neon is healthy."
    exit 0
  fi
  # A rejected login means the credentials changed, not that Neon is down.
  if grep -qE "password authentication failed|(role|database) \".*\" does not exist" "$work/neon.log"; then
    echo "Neon rejected the login; check the NEON_DATABASE_URL secret. Not failing over." >&2
    exit 1
  fi
  echo "Neon did not answer (attempt $attempt of $ATTEMPTS)."
  if [ "$attempt" -lt "$ATTEMPTS" ]; then sleep "$PAUSE_SECONDS"; fi
done

# Only switch if Neon was answering recently. If it never has (a wrong secret, say),
# that's a setup problem and switching would just hide it.
recent=$(backup_sql -c "select coalesce(last_healthy_at > now() - interval '30 minutes', false) from backup_meta.failover where id = 1")
if [ "$recent" != "t" ]; then
  echo "Neon isn't answering, but it hasn't passed a check in the last 30 minutes either, so this looks like a setup problem. Not failing over." >&2
  exit 1
fi

last=$(backup_sql -c "select coalesce(max(finished_at)::text, 'never') from backup_meta.runs" 2>/dev/null || echo "unknown")
backup_sql >/dev/null -c "update backup_meta.failover
  set active = 'supabase', switched_at = now(), reason = 'Neon did not answer for $((ATTEMPTS * PAUSE_SECONDS)) seconds'
  where id = 1 and active = 'neon'" || { echo "Couldn't flip the failover switch in Supabase." >&2; exit 1; }

echo "::error::FAILED OVER: Neon stopped answering, so the app now uses the Supabase backup (last backup: $last)."
exit 4
