-- =========================================================================
-- create_tenant_and_workspace: atomic RPC for the onboarding "create a
-- workspace" flow.
--
-- Fixes a real bug introduced by the v2 rebuild: the two-insert client flow
-- (`insert into tenants ... returning id`, then `insert into workspaces ...
-- returning id`) fails RLS on the very first insert. tenants_select only
-- grants visibility via current_tenant_ids(), which reads tenant_members —
-- a row written by trg_on_tenant_created, an AFTER INSERT trigger.
-- INSERT ... RETURNING's implicit SELECT-policy check runs against the new
-- row before an AFTER trigger fired by that same statement has had a chance
-- to run, so the check always fails for a brand new tenant with "new row
-- violates row-level security policy for table tenants".
--
-- v1 of this schema solved this with a `tenants.owner_id` column and an
-- `or owner_id = auth.uid()` policy arm (see git history of
-- 20260901000400_tenancy.sql's predecessor). owner_id was deliberately
-- dropped in the v2 rebuild — a column and a tenant_members role row are two
-- sources of truth for the same fact — but no replacement was actually
-- written, despite a comment in 20260901000400_tenancy.sql promising a
-- "tenants_select_new" policy.
--
-- Switching the grant trigger from AFTER to BEFORE INSERT does not work as
-- a fix: tenant_members.tenant_id's FK to tenants is checked synchronously
-- per-row (confirmed empirically — this holds even when the FK is marked
-- DEFERRABLE INITIALLY IMMEDIATE, because the check fires from inside the
-- nested SPI insert the trigger issues, not at the outer statement's end),
-- so a BEFORE trigger inserting into tenant_members before the parent
-- tenants row is physically inserted just trades one error for another.
--
-- SECURITY DEFINER, owned by the migration role (which owns `tenants` and
-- `workspaces`, neither of which has FORCE ROW LEVEL SECURITY set)
-- sidesteps RLS entirely for the two inserts below, so there is no
-- RETURNING-visibility race left to fix — the existing AFTER INSERT
-- triggers still fire exactly as before and grant tenant_members /
-- workspace_members roles. The only authorization check this function needs
-- is auth.uid() is not null, mirroring the same guard already used by
-- handle_new_tenant/handle_new_workspace.
--
-- As a side benefit this also closes an atomicity gap the old two-request
-- flow had: each supabase-js `.insert()` is its own HTTP request and DB
-- transaction, so a failure on the second insert used to leave an orphaned
-- tenant with no workspace. Both inserts here run in the one transaction
-- PostgREST wraps around a single RPC call.
-- =========================================================================
create or replace function public.create_tenant_and_workspace(p_name text, p_slug text)
returns table (tenant_id uuid, workspace_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id    uuid;
  v_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.tenants (name, slug) values (p_name, p_slug)
  returning id into v_tenant_id;

  insert into public.workspaces (tenant_id, name, slug) values (v_tenant_id, p_name, p_slug)
  returning id into v_workspace_id;

  return query select v_tenant_id, v_workspace_id;
end;
$$;

revoke execute on function public.create_tenant_and_workspace(text, text) from public, anon;
grant execute on function public.create_tenant_and_workspace(text, text) to authenticated;
