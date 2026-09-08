-- =========================================================================
-- RBAC, part 4 of 6: policy rewrite — tenancy (users, tenants,
-- tenant_subscriptions, tenant_members, workspaces, workspace_members).
--
-- Every predicate below is a TRANSLATION of the one it replaces, not a change
-- of intent. The permission seeded in 20260901002200_rbac_seed.sql was chosen
-- so each rewritten policy admits exactly the same set of callers as before.
-- The pgTAP matrix is what proves that rather than asserting it.
--
-- Recursion safety is unchanged and still load-bearing: every resolver is
-- SECURITY DEFINER, so a policy ON workspace_members may call
-- workspace_ids_with() — which reads workspace_members — without tripping
-- "infinite recursion detected in policy". The self-row policies remain as
-- the recursion-safe base case they always were.
--
-- Column-level GRANTs are NOT touched by this file. They are a separate lock
-- from RLS and still the only thing restricting WHICH columns an UPDATE may
-- write (e.g. tenants.status stays webhook-only).
-- =========================================================================

-- =========================================================================
-- users. The co-member policy exists so assignee avatars and names render;
-- it keys on the tenant roster, same as before.
-- =========================================================================
drop policy users_select_comembers on public.users;
create policy users_select_comembers on public.users for select to authenticated
  using (exists (
    select 1 from public.tenant_members tm
    where tm.user_id = public.users.id
      and tm.tenant_id in (select public.tenant_ids_with('member.read'))
  ));

-- =========================================================================
-- tenants.
--
-- tenants_insert stays `with check (true)`: creating a tenant is how a new
-- organisation comes into existence, so there is no prior scope to hold a
-- permission at. handle_new_tenant() makes the creator its owner.
-- =========================================================================
drop policy tenants_select on public.tenants;
create policy tenants_select on public.tenants for select to authenticated
  using (id in (select public.tenant_ids_with('tenant.read')));

drop policy tenants_update on public.tenants;
create policy tenants_update on public.tenants for update to authenticated
  using (public.can('tenant', id, 'tenant.update'))
  with check (public.can('tenant', id, 'tenant.update'));

-- =========================================================================
-- tenant_subscriptions. Still read-only to clients — no write grant exists,
-- so billing.manage gates nothing here yet and the Stripe webhook remains the
-- only writer.
-- =========================================================================
drop policy tenant_subscriptions_select on public.tenant_subscriptions;
create policy tenant_subscriptions_select on public.tenant_subscriptions for select to authenticated
  using (tenant_id in (select public.tenant_ids_with('billing.read')));

-- =========================================================================
-- tenant_members.
-- =========================================================================
drop policy tenant_members_select_peers on public.tenant_members;
create policy tenant_members_select_peers on public.tenant_members for select to authenticated
  using (tenant_id in (select public.tenant_ids_with('member.read')));

drop policy tenant_members_write_owner on public.tenant_members;
create policy tenant_members_write on public.tenant_members for all to authenticated
  using (public.can('tenant', tenant_id, 'member.manage'))
  with check (public.can('tenant', tenant_id, 'member.manage'));

-- =========================================================================
-- workspaces.
--
-- Creating a workspace consumes max_workspaces and is therefore
-- billing-visible — workspace.create is seeded only to the tenant owner,
-- matching the has_tenant_role('owner') check it replaces.
-- =========================================================================
drop policy workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select public.workspace_ids_with('workspace.read')));

drop policy workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (public.can('tenant', tenant_id, 'workspace.create'));

drop policy workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.can('workspace', id, 'workspace.manage'))
  with check (public.can('workspace', id, 'workspace.manage'));

drop policy workspaces_delete on public.workspaces;
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.can('workspace', id, 'workspace.delete'));

-- =========================================================================
-- workspace_members.
-- =========================================================================
drop policy wm_select_comembers on public.workspace_members;
create policy wm_select_comembers on public.workspace_members for select to authenticated
  using (workspace_id in (select public.workspace_ids_with('member.read')));

drop policy wm_write_admin on public.workspace_members;
create policy wm_write on public.workspace_members for all to authenticated
  using (public.can('workspace', workspace_id, 'member.manage'))
  with check (public.can('workspace', workspace_id, 'member.manage'));
