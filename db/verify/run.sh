#!/usr/bin/env bash
#
# Replays the whole database from nothing and asserts what the migrations built.
#
# Why this exists: the migrations touch a schema this repo does not own, and their policies
# call functions this repo did not write. A migration that applies cleanly can still be wrong
# — a loosened CHECK, a dropped policy, a grant that makes ciphertext readable — and none of
# that shows up in `pnpm test`. So the database is rebuilt from the committed baseline in a
# throwaway container and inspected.
#
# It is also the only place that proves baseline/product-schema.sql plus verify/prelude.sql is
# a complete description of the database. If someone on the other side of the schema adds a
# dependency we do not know about, this is what fails.
#
# Nothing here touches a real database. Requires Docker.

set -euo pipefail

CONTAINER=idv-db-verify
IMAGE=public.ecr.aws/supabase/postgres:17.6.1.155
PORT=55432
DB=verify
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"

fail() { printf '\n  FAILED: %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n  %s\n' "$1"; }

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  else
    printf '\n  container kept: docker exec -it %s psql -U supabase_admin -d %s\n' "$CONTAINER" "$DB"
  fi
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || fail 'Docker is not running (colima start)'

step "starting $IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=verify -p "$PORT:5432" "$IMAGE" >/dev/null

# Poll rather than sleep: the image is ready in a few seconds on a warm cache and much slower
# on a cold one, and a fixed sleep is wrong in both directions.
step 'waiting for postgres'
ready=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" pg_isready -U supabase_admin -q 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || fail 'postgres did not become ready'

psql_run() {
  docker exec -i "$CONTAINER" psql -U supabase_admin -d "$1" -v ON_ERROR_STOP=1 -q
}

docker exec "$CONTAINER" psql -U supabase_admin -d postgres -q \
  -c "drop database if exists $DB" -c "create database $DB" >/dev/null

step 'prelude (what Supabase would provide)'
psql_run "$DB" < "$DIR/prelude.sql" >/dev/null || fail 'prelude failed'

step 'baseline (product schema, another repo owns this)'
psql_run "$DB" < "$ROOT/db/baseline/product-schema.sql" >/dev/null || fail 'baseline failed'

tables=$(docker exec "$CONTAINER" psql -U supabase_admin -d "$DB" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
printf '    %s public tables\n' "$tables"
[ "$tables" -ge 29 ] || fail "expected at least 29 public tables, got $tables"

# In journal order, which is the order db:migrate applies them in.
for tag in $(node -e "
  const j = require('$ROOT/db/migrations/meta/_journal.json');
  console.log(j.entries.map(e => e.tag).join(' '));
"); do
  step "migration $tag"
  psql_run "$DB" < "$ROOT/db/migrations/$tag.sql" >/dev/null || fail "$tag failed"
done

step 'seed'
psql_run "$DB" < "$DIR/seed.sql" >/dev/null || fail 'seed failed'

step 'contract'
psql_run "$DB" < "$ROOT/db/contract.sql" 2>&1 | sed 's/^NOTICE:  /    /' || fail 'contract drifted'

step 'checks'
psql_run "$DB" < "$DIR/checks.sql" 2>&1 | sed 's/^NOTICE:  /    /'

printf '\n  ok — baseline + %s migration(s) applied and verified\n\n' \
  "$(node -e "console.log(require('$ROOT/db/migrations/meta/_journal.json').entries.length)")"
