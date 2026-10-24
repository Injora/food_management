#!/usr/bin/env bash
# Runs after every backup: makes sure the site can still see its tables.
#   SOURCE_DATABASE_URL=<neon pooled> SITE_URL=https://... scripts/check-site.sh
# Looks for pooled Neon connections whose search_path no longer includes public
# (what took the site down on 24 Oct, when pg_dump went through the pooler). If it
# finds one, it closes Neon's idle connections so the pooler opens clean ones, then
# checks again. Exits non-zero whenever it found a problem, so GitHub emails you.
# The repo is public and so are its Actions logs: never print row data or URLs.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is not set}"
: "${SITE_URL:?SITE_URL is not set}"

CHECKS=${CHECKS:-20}
export PGCONNECT_TIMEOUT=15
case "$SOURCE_DATABASE_URL" in *sslmode=verify-full*) export PGSSLROOTCERT=system ;; esac
NEON_DIRECT=${NEON_DIRECT_URL:-${SOURCE_DATABASE_URL/-pooler./.}}

# Each new connection through the pooler may land on a different server connection.
bad_connections() {
  local bad=0
  for _ in $(seq 1 "$CHECKS"); do
    path=$(psql "$SOURCE_DATABASE_URL" --no-psqlrc -At -c "show search_path" 2>/dev/null || echo "unreachable")
    case "$path" in *public*) ;; *) bad=$((bad + 1)) ;; esac
  done
  echo "$bad"
}

site_errors() {
  local errors=0
  for _ in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$SITE_URL/api/health" || echo 000)
    [ "$code" = "200" ] || errors=$((errors + 1))
  done
  echo "$errors"
}

bad=$(bad_connections)
errors=$(site_errors)
if [ "$bad" -eq 0 ] && [ "$errors" -eq 0 ]; then
  echo "Site is healthy: $CHECKS pooled connections and 10 health checks all fine."
  exit 0
fi

echo "::error::Site problem: $bad of $CHECKS pooled Neon connections can't see the tables, $errors of 10 health checks failed."
if [ "$bad" -gt 0 ]; then
  # Idle connections only: nothing in the middle of a request is interrupted.
  closed=$(psql "$NEON_DIRECT" --no-psqlrc -At -c "select count(*) from (
      select pg_terminate_backend(pid) from pg_stat_activity
      where usename = current_user and pid <> pg_backend_pid()
        and backend_type = 'client backend' and state = 'idle') t" 2>/dev/null || echo "?")
  echo "Closed $closed idle Neon connections so the pooler opens clean ones."
  echo "After the fix: $(bad_connections) of $CHECKS pooled connections bad, $(site_errors) of 10 health checks failed."
fi
exit 1
