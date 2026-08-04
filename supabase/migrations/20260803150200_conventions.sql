-- Shared trigger functions used by every table below.

-- Bump updated_at on every UPDATE. Attached per-table as each table is created.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attach to an append-only table to forbid UPDATE/DELETE at the DB level.
-- Used by audit_logs and, later, memory-version-style tables.
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are append-only and cannot be % (table: %)',
    tg_argv[0], lower(tg_op), tg_table_name;
  return null;
end;
$$;
