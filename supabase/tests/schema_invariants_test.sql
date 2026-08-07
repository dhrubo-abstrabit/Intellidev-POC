
-- pgTAP structural invariants. Run with `supabase test db` (requires the
-- local stack: `supabase start`). These don't need seed data — they check
-- the schema itself, so they should be the first thing that runs in CI
-- after a fresh `supabase db reset`.

begin;
select plan(6);

-- 1. Every table in `public` has row level security enabled. A table that
--    exists for even one migration without RLS is the failure mode this
--    guards against — see the "same migration as create table" rule.
select is(
  (
    select count(*)::int
    from pg_tables t
    join pg_class c on c.relname = t.tablename and c.relnamespace = 'public'::regnamespace
    where t.schemaname = 'public'
      and not c.relrowsecurity
  ),
  0,
  'every public table has row level security enabled'
);

-- 2. Service-role-only tables have zero grants to anon/authenticated. This
--    is the load-bearing check: RLS-with-no-policies alone would return an
--    empty set (200, []) rather than failing loudly, and would break the
--    moment anyone adds a permissive policy "just for debugging."
select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and table_name in ('connector_credentials', 'raw_events', 'llm_runs', 'integration_cursors')
  ),
  0,
  'service-role-only tables have no grants to anon or authenticated'
);

-- 3. The three SECURITY DEFINER RLS helpers exist and are owned in a way
--    that lets them bypass RLS on workspace_members (breaking the
--    self-referential recursion described in 20260803150400_tenancy.sql).
select ok(
  (
    select count(*) = 3
    from pg_proc
    where proname in ('current_workspace_ids', 'is_workspace_member', 'has_workspace_role')
      and pronamespace = 'public'::regnamespace
      and prosecdef  -- SECURITY DEFINER
  ),
  'all three RLS helper functions exist and are SECURITY DEFINER'
);

-- 4. audit_logs is append-only at the trigger level, not just by convention.
select ok(
  (
    select count(*) = 2
    from pg_trigger
    where tgrelid = 'public.audit_logs'::regclass
      and not tgisinternal
      and tgname in ('trg_audit_logs_no_update', 'trg_audit_logs_no_delete')
  ),
  'audit_logs has both no-update and no-delete guard triggers'
);

-- 5. This is the exact bug this project hit once already: a table can have
--    a correct, well-reasoned `create policy ... for select to authenticated`
--    and still return "permission denied" for every request, because RLS
--    policies and table-level GRANTs are two independent locks — this CLI's
--    project config defaults new tables to NOT auto-exposing any privilege
--    (see supabase/config.toml `auto_expose_new_tables`), so a policy with
--    no matching GRANT silently does nothing useful. Assert every table
--    with a permissive SELECT policy for `authenticated` also has the
--    matching table-level SELECT grant.
select is(
  (
    select coalesce(array_agg(distinct pol.tablename::text order by pol.tablename::text), '{}'::text[])
    from pg_policies pol
    where pol.schemaname = 'public'
      and pol.cmd in ('SELECT', 'ALL')
      and 'authenticated' = any (pol.roles)
      and pol.permissive = 'PERMISSIVE'
      and not exists (
        select 1
        from information_schema.role_table_grants g
        where g.table_schema = 'public'
          and g.table_name = pol.tablename
          and g.grantee = 'authenticated'
          and g.privilege_type = 'SELECT'
      )
  ),
  '{}'::text[],
  'every table with a permissive SELECT policy for authenticated also has a matching table-level SELECT grant'
);

-- 6. connector_provider must contain every provider connectors/registry.ts
--    can return. Forgetting to add an enum value here today fails silently
--    at INSERT time inside a sync job nobody is watching, rather than at
--    build/deploy time — keep this literal array in sync with the ids
--    actually registered there.
select is(
  (
    select coalesce(array_agg(missing order by missing), '{}'::text[])
    from unnest(array['slack', 'mock', 'google_chat', 'google_drive', 'gmail']) as missing
    where missing::text not in (
      select enumlabel
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'connector_provider'
    )
  ),
  '{}'::text[],
  'connector_provider contains every provider the registry can return'
);

select * from finish();
rollback;
