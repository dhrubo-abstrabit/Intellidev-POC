-- =========================================================================
-- RBAC, part 3 of 6: the resolvers.
--
-- One function per scope level, each answering the same question: "which ids
-- at this level does the caller hold PERMISSION on". Policies call these
-- instead of naming roles, which is the entire point of the exercise — the
-- role vocabulary can then change without touching a single policy.
--
-- Nothing calls these yet. The policy migrations that follow switch over.
--
-- -------------------------------------------------------------------------
-- THE SIGNATURE IS THE DESIGN. Read this before changing any of them.
-- -------------------------------------------------------------------------
-- 20260901000400_tenancy.sql warns, correctly, that every RLS helper must be
-- set-returning or scalar and take NO row-dependent argument, so Postgres can
-- hoist it into an InitPlan and evaluate it ONCE PER STATEMENT instead of
-- once per row. That is what keeps
-- `client_space_id in (select public.space_ids_with('data.read'))` cheap on
-- normalized_events and search_chunks, which are sized in the millions.
--
-- These take `p_permission text` — but a permission is a LITERAL in policy
-- text, never a column, so the hoisting is preserved. Rewriting any of these
-- to take the row's own id as a parameter would turn an InitPlan into a
-- per-row function call and is the one change here that could quietly cost
-- real money. Don't.
--
-- -------------------------------------------------------------------------
-- INHERITANCE
-- -------------------------------------------------------------------------
-- A grant marked `cascades` applies at the scope the role is held at AND at
-- every scope beneath it. A grant with cascades = false applies only at its
-- own level — see the column comment in 20260901002100_rbac_catalog.sql for
-- why that distinction is load-bearing rather than decorative.
--
-- Every function carries a `platform` arm that returns nothing today, because
-- platform_members is empty and 20260901002200_rbac_seed.sql seeds no
-- platform role. Written now so that adding a super admin later stays two
-- INSERTs and a membership row rather than a rewrite of this file.
--
-- The `::text` casts on membership role columns are deliberate: this file
-- lands while those columns are still enums, and
-- 20260901002900_rbac_role_columns.sql converts them to text afterwards. The
-- cast is correct either way, so the conversion needs no change here.
-- =========================================================================

-- =========================================================================
-- Platform grants, factored out. Not a policy helper — an internal predicate
-- the four resolvers share, so the "is there an unexpired platform role with
-- this permission" question is written once.
--
-- `expires_at` is honoured here, which is what makes a time-boxed break-glass
-- grant expire on its own with no reaper job.
-- =========================================================================
create or replace function public.has_platform_permission(p_permission text)
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_members pm
    join public.role_permissions rp
      on rp.scope_level = 'platform'
     and rp.role_key    = pm.role
    where pm.user_id     = auth.uid()
      and rp.permission  = p_permission
      and rp.cascades
      and (pm.expires_at is null or pm.expires_at > now())
  );
$$;

-- =========================================================================
-- LEVEL 1 — tenants.
-- =========================================================================
create or replace function public.tenant_ids_with(p_permission text)
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select tm.tenant_id
  from public.tenant_members tm
  join public.role_permissions rp
    on rp.scope_level = 'tenant'
   and rp.role_key    = tm.role::text
  where tm.user_id    = auth.uid()
    and rp.permission = p_permission
  union
  select t.id
  from public.tenants t
  where public.has_platform_permission(p_permission);
$$;

-- =========================================================================
-- LEVEL 2 — workspaces. Direct membership, plus a cascading tenant grant.
--
-- The tenant arm replaces the hand-copied `union select w.id ... where
-- tm.role = 'owner'` that current_workspace_ids() and has_workspace_role()
-- each carried their own copy of. There is now one copy, and which roles it
-- covers is data.
-- =========================================================================
create or replace function public.workspace_ids_with(p_permission text)
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select wm.workspace_id
  from public.workspace_members wm
  join public.role_permissions rp
    on rp.scope_level = 'workspace'
   and rp.role_key    = wm.role::text
  where wm.user_id    = auth.uid()
    and rp.permission = p_permission
  union
  select w.id
  from public.workspaces w
  join public.tenant_members tm on tm.tenant_id = w.tenant_id
  join public.role_permissions rp
    on rp.scope_level = 'tenant'
   and rp.role_key    = tm.role::text
  where tm.user_id    = auth.uid()
    and rp.permission = p_permission
    and rp.cascades
  union
  select w.id
  from public.workspaces w
  where public.has_platform_permission(p_permission);
$$;

-- =========================================================================
-- LEVEL 3 — client spaces. THE DATA BOUNDARY.
--
-- This one function replaces both current_client_space_ids() (data) and
-- manageable_client_space_ids() (management). The split those two encoded is
-- now expressed in the grid instead: no workspace- or tenant-level role holds
-- data.read, so space_ids_with('data.read') returns only spaces the caller is
-- actually a member of, while space_ids_with('space.manage') also returns
-- spaces they administer from above. Same distinction, declared as data.
-- =========================================================================
create or replace function public.space_ids_with(p_permission text)
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select sm.client_space_id
  from public.space_members sm
  join public.role_permissions rp
    on rp.scope_level = 'space'
   and rp.role_key    = sm.role::text
  where sm.user_id    = auth.uid()
    and rp.permission = p_permission
  union
  select cs.id
  from public.client_spaces cs
  join public.workspace_members wm on wm.workspace_id = cs.workspace_id
  join public.role_permissions rp
    on rp.scope_level = 'workspace'
   and rp.role_key    = wm.role::text
  where wm.user_id    = auth.uid()
    and rp.permission = p_permission
    and rp.cascades
  union
  select cs.id
  from public.client_spaces cs
  join public.tenant_members tm on tm.tenant_id = cs.tenant_id
  join public.role_permissions rp
    on rp.scope_level = 'tenant'
   and rp.role_key    = tm.role::text
  where tm.user_id    = auth.uid()
    and rp.permission = p_permission
    and rp.cascades
  union
  select cs.id
  from public.client_spaces cs
  where public.has_platform_permission(p_permission);
$$;

-- =========================================================================
-- LEVEL 4 — projects. Four arms, and the shape of them is the `visibility`
-- rule made explicit.
--
--   A. Non-restricted projects in a space where the caller holds the
--      permission. This is current_project_ids()'s first arm.
--   B. An explicit project role that grants the permission. Reaches
--      restricted projects — that is what the access list is for.
--   C. A project_members row with a NULL role — "no override, inherit the
--      space baseline" — in a space where the caller holds the permission.
--      This is how a restricted project grants plain access without having
--      to restate a role, and it is why `role` is nullable.
--   D. Restricted projects in a space where the caller holds BOTH the
--      permission AND project.manage. Space administrators keep authority
--      over restricted projects they did not personally create; without this
--      arm a restricted project whose creator left the company would become
--      permanently unmanageable.
--
-- PROJECT ROLES ARE ADDITIVE, NOT RESTRICTIVE — deliberately, and matching
-- today. current_project_ids() and manageable_project_ids() are both unions,
-- so someone who is a space `member` and a project `viewer` keeps the space
-- baseline on that project; the project role adds and never subtracts. A
-- restrictive override would be a different feature, and changing it here
-- would silently narrow existing access.
--
-- ONE DELIBERATE NARROWING vs. manageable_project_ids(): that function
-- returned every project in a manageable space regardless of visibility,
-- while current_project_ids() hid restricted ones — so a space admin could
-- UPDATE a restricted project they could not SELECT. Arm D grants both or
-- neither, which is the write-implies-read rule applied to a case the old
-- helpers got wrong.
-- =========================================================================
create or replace function public.project_ids_with(p_permission text)
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  -- A
  select p.id
  from public.projects p
  where p.visibility = 'space'
    and p.client_space_id in (select public.space_ids_with(p_permission))
  union
  -- B
  select pm.project_id
  from public.project_members pm
  join public.role_permissions rp
    on rp.scope_level = 'project'
   and rp.role_key    = pm.role::text
  where pm.user_id    = auth.uid()
    and rp.permission = p_permission
  union
  -- C
  select pm.project_id
  from public.project_members pm
  join public.projects p on p.id = pm.project_id
  where pm.user_id = auth.uid()
    and pm.role is null
    and p.client_space_id in (select public.space_ids_with(p_permission))
  union
  -- D
  select p.id
  from public.projects p
  where p.visibility = 'restricted'
    and p.client_space_id in (select public.space_ids_with(p_permission))
    and p.client_space_id in (select public.space_ids_with('project.manage'));
$$;

-- =========================================================================
-- Scalar form, for the low-cardinality admin tables and for the application
-- layer to call directly.
--
-- Safe to use per-row ONLY on tables with hundreds of rows (client_spaces,
-- projects, the membership tables). Never put this in a policy on
-- normalized_events, search_chunks or event_attachments — use the
-- set-returning form there, for the InitPlan reason at the top of this file.
-- =========================================================================
create or replace function public.can(
  p_scope_level public.scope_level,
  p_scope_id    uuid,
  p_permission  text
)
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select case p_scope_level
    when 'tenant'    then p_scope_id in (select public.tenant_ids_with(p_permission))
    when 'workspace' then p_scope_id in (select public.workspace_ids_with(p_permission))
    when 'space'     then p_scope_id in (select public.space_ids_with(p_permission))
    when 'project'   then p_scope_id in (select public.project_ids_with(p_permission))
    else false
  end;
$$;

-- =========================================================================
-- Grants. Same pattern as every other helper in this schema: never reachable
-- by anon, executable by authenticated.
-- =========================================================================
revoke execute on function public.has_platform_permission(text)               from public, anon;
revoke execute on function public.tenant_ids_with(text)                       from public, anon;
revoke execute on function public.workspace_ids_with(text)                    from public, anon;
revoke execute on function public.space_ids_with(text)                        from public, anon;
revoke execute on function public.project_ids_with(text)                      from public, anon;
revoke execute on function public.can(public.scope_level, uuid, text)         from public, anon;

grant execute on function public.has_platform_permission(text)                to authenticated;
grant execute on function public.tenant_ids_with(text)                        to authenticated;
grant execute on function public.workspace_ids_with(text)                     to authenticated;
grant execute on function public.space_ids_with(text)                         to authenticated;
grant execute on function public.project_ids_with(text)                       to authenticated;
grant execute on function public.can(public.scope_level, uuid, text)          to authenticated;
