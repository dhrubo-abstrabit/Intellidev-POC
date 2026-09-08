-- =========================================================================
-- RBAC, part 7: convert the role columns from enums to text + FK.
--
-- This file originally also dropped the nine helpers the policy rewrite made
-- dead. It does not: four of them turned out to be load-bearing for a `runner`
-- schema that lives in the cloud database but not in this repository. See the
-- section below.
--
-- WHY THE ENUMS GO. `create type space_role as enum (...)` bakes the role
-- vocabulary into a Postgres TYPE, and Postgres is unusually unforgiving
-- about changing one:
--
--   * A value added with `alter type ... add value` cannot be USED in the
--     same transaction that added it, so a single migration file that adds a
--     role and seeds its grants fails. 20260901000300_enums.sql bans the
--     statement from this migration set outright for exactly that reason.
--   * There is no `alter type ... drop value` in any version of Postgres. The
--     only way to remove one is to convert every column to text, drop the
--     type, recreate it and convert back — an ACCESS EXCLUSIVE lock on every
--     table that uses it. The same file documents living with four dead
--     connector labels forever rather than pay that.
--   * An enum value is a bare string. A role needs a label, a description, a
--     rank, an is-system flag and an assignable flag; none of that can hang
--     off an enum value, all of it hangs off a row.
--
-- This is NOT "enums are bad". An enum is right for a fixed vocabulary the
-- code branches on, and every other enum in this schema — task_status,
-- sync_job_status, connector_provider, project_visibility — stays exactly as
-- it is. Roles are the other kind: a list that changes when product policy
-- changes, with no code branching on the values.
--
-- THE COLUMN IS STILL CONSTRAINED. It does not become free text. The FK into
-- roles (scope_level, key) rejects an unknown value exactly as loudly as the
-- enum did, and additionally refuses to let anyone DELETE a role that is
-- still held — which the enum could not do at all. What changes is that the
-- constraint is a row you can insert and delete instead of a type you can
-- only append to.
--
-- HOW THE TWO-COLUMN FK IS SATISFIED. roles is keyed on (scope_level, key)
-- because 'admin' means different things at workspace and space level. A
-- child table has only `role`, so each carries a generated constant column
-- supplying its own scope. Verified on PG 17 that a generated column is a
-- legal FK source and that it enforces cross-scope violations — a
-- space_members row can therefore never hold a tenant-scoped role key.
--
-- On invitations the generated columns are NULL-tracking rather than
-- constant, because its four role columns are nullable: an FK with a NULL in
-- the pair is satisfied under MATCH SIMPLE, so a null role skips the check
-- instead of failing it.
--
-- The four enum TYPES are deliberately left declared but unreferenced.
-- Postgres cannot cleanly drop a type a column has ever used, and four unused
-- types cost nothing at runtime — the same reasoning already applied to the
-- dead connector_provider labels.
-- =========================================================================

-- =========================================================================
-- Repoint the one policy still calling an old helper. roles_select was
-- written in 20260901002100 before the resolvers existed, so it had to use
-- current_tenant_ids(); it now asks the same question in the new vocabulary,
-- which leaves `public` with no policy referencing a legacy helper.
-- =========================================================================
drop policy roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated
  using (tenant_id is null or tenant_id in (select public.tenant_ids_with('tenant.read')));

-- =========================================================================
-- The legacy helpers are KEPT, not dropped. This was a drop until it failed
-- against the real database:
--
--   ERROR: cannot drop function current_client_space_ids() because other
--   objects depend on it
--   policy integrations_select on table runner.integrations depends on it
--
-- The cloud project carries a `runner` schema — an agentic code-runner
-- subsystem (runs, run_events, run_tokens, task_specs, project_repos,
-- integrations, credentials) that exists in the database but NOT in this
-- repository. Seven of its RLS policies call four of these helpers:
--
--   current_client_space_ids()      <- integrations_select
--   current_project_ids()           <- integrations_select, project_repos_select,
--                                      runs_select
--   manageable_client_space_ids()   <- integrations_write_space,
--                                      project_repos_write
--   manageable_project_ids()        <- integrations_write_project,
--                                      task_specs_write
--
-- Dropping them would have taken that subsystem's access control with it, and
-- `drop ... cascade` would have silently deleted the policies — leaving
-- RLS-enabled tables with no policies, which denies everyone rather than
-- failing loudly. Neither is acceptable for a schema this migration set does
-- not own.
--
-- Keeping all nine costs nothing. `public`'s own policies no longer reference
-- any of them (verified against pg_policies), so they are dead weight here and
-- load-bearing elsewhere. Whoever owns `runner` can migrate its policies onto
-- the permission resolvers and delete them then.
--
-- The four helpers runner depends on survive the conversion below unchanged:
-- current_client_space_ids() and current_project_ids() compare no role at all,
-- and manageable_client_space_ids()/manageable_project_ids() compare role
-- against a string literal ('admin', 'owner', 'member'), which is still true
-- once the column is text.
-- =========================================================================

-- =========================================================================
-- tenant_members
-- =========================================================================
alter table public.tenant_members alter column role drop default;
alter table public.tenant_members alter column role type text using role::text;
alter table public.tenant_members alter column role set default 'member';
alter table public.tenant_members
  add column role_scope public.scope_level
    generated always as ('tenant'::public.scope_level) stored;
alter table public.tenant_members
  add constraint tenant_members_role_fkey
    foreign key (role_scope, role) references public.roles (scope_level, key);

-- =========================================================================
-- workspace_members
-- =========================================================================
alter table public.workspace_members alter column role drop default;
alter table public.workspace_members alter column role type text using role::text;
alter table public.workspace_members alter column role set default 'member';
alter table public.workspace_members
  add column role_scope public.scope_level
    generated always as ('workspace'::public.scope_level) stored;
alter table public.workspace_members
  add constraint workspace_members_role_fkey
    foreign key (role_scope, role) references public.roles (scope_level, key);

-- =========================================================================
-- space_members
-- =========================================================================
alter table public.space_members alter column role drop default;
alter table public.space_members alter column role type text using role::text;
alter table public.space_members alter column role set default 'member';
alter table public.space_members
  add column role_scope public.scope_level
    generated always as ('space'::public.scope_level) stored;
alter table public.space_members
  add constraint space_members_role_fkey
    foreign key (role_scope, role) references public.roles (scope_level, key);

-- =========================================================================
-- project_members. `role` is nullable — NULL means "no override, inherit the
-- space baseline" — so its scope column has to track that nullability rather
-- than being a constant, or every inheriting row would fail the FK.
-- =========================================================================
alter table public.project_members alter column role type text using role::text;
alter table public.project_members
  add column role_scope public.scope_level
    generated always as (
      case when role is not null then 'project'::public.scope_level end
    ) stored;
alter table public.project_members
  add constraint project_members_role_fkey
    foreign key (role_scope, role) references public.roles (scope_level, key);

-- =========================================================================
-- invitations. Four nullable role columns, four NULL-tracking scope columns.
-- =========================================================================
alter table public.invitations alter column tenant_role    type text using tenant_role::text;
alter table public.invitations alter column workspace_role type text using workspace_role::text;
alter table public.invitations alter column space_role     type text using space_role::text;
alter table public.invitations alter column project_role   type text using project_role::text;

alter table public.invitations
  add column tenant_role_scope public.scope_level
    generated always as (
      case when tenant_role is not null then 'tenant'::public.scope_level end
    ) stored,
  add column workspace_role_scope public.scope_level
    generated always as (
      case when workspace_role is not null then 'workspace'::public.scope_level end
    ) stored,
  add column space_role_scope public.scope_level
    generated always as (
      case when space_role is not null then 'space'::public.scope_level end
    ) stored,
  add column project_role_scope public.scope_level
    generated always as (
      case when project_role is not null then 'project'::public.scope_level end
    ) stored;

alter table public.invitations
  add constraint invitations_tenant_role_fkey
    foreign key (tenant_role_scope, tenant_role) references public.roles (scope_level, key),
  add constraint invitations_workspace_role_fkey
    foreign key (workspace_role_scope, workspace_role) references public.roles (scope_level, key),
  add constraint invitations_space_role_fkey
    foreign key (space_role_scope, space_role) references public.roles (scope_level, key),
  add constraint invitations_project_role_fkey
    foreign key (project_role_scope, project_role) references public.roles (scope_level, key);

-- =========================================================================
-- The generated scope columns are derived, never written. Revoke any implied
-- write privilege so a client cannot even attempt it (Postgres rejects a
-- write to a generated column anyway; this keeps the grant list honest about
-- what is writable).
--
-- accept_invitation() needs no change: it copies role values between columns
-- that are now all text, and the FKs it must satisfy are checked the same way.
-- =========================================================================
revoke update (role_scope) on public.tenant_members    from authenticated, anon;
revoke update (role_scope) on public.workspace_members from authenticated, anon;
revoke update (role_scope) on public.space_members     from authenticated, anon;
revoke update (role_scope) on public.project_members   from authenticated, anon;

-- =========================================================================
-- The three has_*_role functions, redefined LAST — after the columns above
-- are text.
--
-- The ordering is not stylistic. `language sql` bodies are parsed and
-- validated at CREATE time, so redefining these before the conversion fails
-- with `operator does not exist: public.tenant_role = text`: at that point
-- tm.role is still the enum while p_roles::text[] is already text.
-- =========================================================================
-- These are the exception that DOES need attention.
-- Their bodies compare a membership role column against an enum array, which
-- stops type-checking the moment those columns become text below — they would
-- survive as landmines that throw for whoever called them first. Nothing calls
-- them today (has_space_role has never had a caller), but a broken function
-- left in the schema is worse than either dropping or fixing it.
--
-- Fixed rather than dropped, and the signature is deliberately unchanged: a
-- policy anywhere in the database may reference `has_tenant_role(uuid,
-- tenant_role[])` by that exact signature, and `create or replace` keeps every
-- such reference valid. Only the body changes, casting the enum array to text
-- so it matches the converted column.
create or replace function public.has_tenant_role(p_tenant_id uuid, p_roles public.tenant_role[])
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = auth.uid()
      and tm.role = any (p_roles::text[])
  );
$$;

create or replace function public.has_workspace_role(p_workspace_id uuid, p_roles public.workspace_role[])
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = any (p_roles::text[])
  ) or exists (
    select 1
    from public.workspaces w
    join public.tenant_members tm on tm.tenant_id = w.tenant_id
    where w.id = p_workspace_id and tm.user_id = auth.uid() and tm.role = 'owner'
  );
$$;

create or replace function public.has_space_role(p_client_space_id uuid, p_roles public.space_role[])
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from public.space_members sm
    where sm.client_space_id = p_client_space_id
      and sm.user_id = auth.uid()
      and sm.role = any (p_roles::text[])
  );
$$;
