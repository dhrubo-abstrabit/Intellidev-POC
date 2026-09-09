#!/usr/bin/env bash
#
# Rebuild the local database from every migration, then assert what it built.
#
# This replaced a harness that replayed a *dump* of the product schema and then the runner's
# migrations on top. That dump was committed as a 0-byte file, so the harness had not run in
# weeks and one of its assertions had silently drifted — it still expected 7 runner tables when
# there were 10. Nothing here is a fixture of the product schema any more: the two migration
# histories are one, so a rebuild is simply every migration in order, which is also exactly
# what `supabase db push` will do to production.
#
# Local only. `supabase db reset` without `--linked` cannot touch the remote, and nothing below
# passes a connection string.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() { printf '\n  FAILED: %s\n\n' "$1" >&2; exit 1; }
step() { printf '  %s\n' "$1"; }

CONTAINER="$(docker ps --filter name=supabase_db --format '{{.Names}}' | head -1)"
[ -n "$CONTAINER" ] || fail 'the local Supabase stack is not running — `supabase start` first'

psql_run() {
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q
}

printf '\n'
step 'rebuilding from every migration (supabase db reset)'
supabase db reset >/dev/null || fail 'the migrations do not replay from scratch'

count() { docker exec "$CONTAINER" psql -U postgres -d postgres -tAc "$1" | tr -d '[:space:]'; }
step "  $(count "select count(*) from supabase_migrations.schema_migrations") migrations applied, \
$(count "select count(*) from information_schema.tables where table_schema='runner'") runner tables, \
$(count "select count(*) from information_schema.tables where table_schema='public'") public tables"

step 'seed (tenancy the negative tests need)'
psql_run < supabase/verify/seed.sql >/dev/null || fail 'seed failed'

step 'checks'
psql_run < supabase/verify/checks.sql 2>&1 | sed 's/^NOTICE:  /    /' || fail 'checks failed'

step 'contract'
psql_run < supabase/verify/contract.sql 2>&1 | sed 's/^NOTICE:  /    /' || fail 'contract drifted'

printf '\n  ok\n\n'
