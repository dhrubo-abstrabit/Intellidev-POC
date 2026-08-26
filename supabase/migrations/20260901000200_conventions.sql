-- =========================================================================
-- Shared trigger functions used across every table in the schema.
-- =========================================================================

-- Stamps updated_at on every UPDATE. Attached as a `before update` trigger to
-- every mutable table below. `search_path = ''` per the SECURITY DEFINER
-- hardening convention used throughout this schema — see the note in
-- 20260901000100_extensions.sql for why that interacts with pgvector.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Append-only guard. Attached to audit_logs as separate UPDATE and DELETE
-- triggers, so an audit trail cannot be rewritten by anyone — including the
-- service role, which bypasses RLS but not triggers.
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is not permitted on %', tg_op, tg_table_name
    using hint = coalesce(tg_argv[0], 'this table is append-only');
  return null;
end;
$$;
