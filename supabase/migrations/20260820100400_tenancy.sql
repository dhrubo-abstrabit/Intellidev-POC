-- =========================================================================
-- users: mirror of auth.users. We never query auth.users from app code —
-- PostgREST cannot expose the auth schema, and we want app-owned columns
-- (full_name, avatar_url) without touching Supabase's managed table.
-- =========================================================================
create table public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      extensions.citext not null unique,
  full_name  text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_users_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- =========================================================================
-- LEVEL 1 — tenants: the billing entity.
--
-- Deliberately has NO `plan` column: the plan lives on tenant_subscriptions
-- and nowhere else. Carrying it in both places gives two sources of truth for
-- one fact, and they drift the first time an upgrade writes only one of them.
-- Read the plan through the subscription.
-- =========================================================================
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 160),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  domain      text,          -- e.g. 'acme.com', for future domain-capture / SSO
  status      public.tenant_status not null default 'active',
  owner_id    uuid not null references public.users (id) on delete restrict,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (jsonb_typeof(settings) = 'object')
);

create index tenants_owner_id_idx on public.tenants (owner_id);

create trigger trg_tenants_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- =========================================================================
-- tenant_admins: tenant-level administration only.
--
-- NOTE — a deliberate, documented limitation. There is no `tenant_members`
-- table, so this schema has no per-tenant record of an ordinary user. A
-- tenant's billable user count must therefore be derived:
--
--   select count(distinct wm.user_id)
--   from public.workspace_members wm
--   join public.workspaces w on w.id = wm.workspace_id
--   where w.tenant_id = $1;
--
-- Consequences, accepted: a user in two workspaces produces two rows (the
-- distinct is load-bearing); a user who has been paid for but not yet
-- assigned to a workspace cannot be represented at all; and non-seat roles
-- (a billing-only finance contact, a contractor billed elsewhere) have
-- nowhere to live. The cap unit is tenant_subscriptions.max_members_per_ws,
-- which bounds per workspace, not per tenant.
-- =========================================================================
create table public.tenant_admins (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  role       public.tenant_admin_role not null default 'billing_admin',
  invited_by uuid references public.users (id) on delete set null,
  joined_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_admins_user_id_idx on public.tenant_admins (user_id, tenant_id);

create trigger trg_tenant_admins_updated_at
  before update on public.tenant_admins
  for each row execute function public.set_updated_at();

-- Whoever creates a tenant becomes its super_admin atomically, so the creator
-- can read it back under RLS without a second round-trip.
create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_admins (tenant_id, user_id, role)
  values (new.id, new.owner_id, 'super_admin');
  return new;
end;
$$;

create trigger trg_on_tenant_created
  after insert on public.tenants
  for each row execute function public.handle_new_tenant();

-- =========================================================================
-- LEVEL 2 — workspaces: a team / department inside a tenant.
--
-- `slug` is unique PER TENANT, not globally: a global unique would mean the
-- first tenant to create a "platform" workspace blocks every other tenant
-- from ever having one.
-- =========================================================================
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  slug        text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description text,
  logo_path   text,
  owner_id    uuid not null references public.users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, slug),
  -- Composite FK target: children FK on (workspace_id, tenant_id), making a
  -- cross-tenant row physically impossible rather than merely policy-forbidden.
  constraint workspaces_id_tenant_id_key unique (id, tenant_id)
);

create index workspaces_tenant_id_idx on public.workspaces (tenant_id);
create index workspaces_owner_id_idx on public.workspaces (owner_id);

create trigger trg_workspaces_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- =========================================================================
-- workspace_members: WHO is on the team, and — via `role` — WHAT they can do
-- everywhere beneath the workspace. This is the RBAC capability baseline;
-- project_members (level 4) only overrides it per project.
-- =========================================================================
create table public.workspace_members (
  workspace_id uuid not null,
  tenant_id    uuid not null,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         public.workspace_role not null default 'member',
  invited_by   uuid references public.users (id) on delete set null,
  joined_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Doubles as the FK target for project_members, so a project role cannot be
  -- granted to someone who is not a workspace member, and removing them from
  -- the workspace cascades every project role away (see
  -- 20260820100700_projects.sql). A PK's unique index is a valid FK target, so
  -- no separate unique constraint is needed here.
  primary key (workspace_id, user_id),
  foreign key (workspace_id, tenant_id)
    references public.workspaces (id, tenant_id) on delete cascade
);

-- Reverse-lookup index: "which workspaces am I in" is the RLS hot path.
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id);

create trigger trg_workspace_members_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- Bootstrap: whoever creates a workspace becomes its 'owner' member atomically.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, tenant_id, user_id, role)
  values (new.id, new.tenant_id, new.owner_id, 'owner');
  return new;
end;
$$;

create trigger trg_on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- Guard: prevent removing/demoting the last owner of a workspace.
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_owners integer;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into remaining_owners
    from public.workspace_members
    where workspace_id = old.workspace_id
      and role = 'owner'
      and user_id <> old.user_id;
    if remaining_owners = 0 then
      raise exception 'workspace % must keep at least one owner', old.workspace_id;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_guard_last_owner
  before update or delete on public.workspace_members
  for each row execute function public.guard_last_owner();

-- Same guard, one level up: a tenant must keep at least one super_admin.
create or replace function public.guard_last_tenant_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_admins integer;
begin
  if (tg_op = 'DELETE' and old.role = 'super_admin')
     or (tg_op = 'UPDATE' and old.role = 'super_admin' and new.role <> 'super_admin') then
    select count(*) into remaining_admins
    from public.tenant_admins
    where tenant_id = old.tenant_id
      and role = 'super_admin'
      and user_id <> old.user_id;
    if remaining_admins = 0 then
      raise exception 'tenant % must keep at least one super_admin', old.tenant_id;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_guard_last_tenant_admin
  before update or delete on public.tenant_admins
  for each row execute function public.guard_last_tenant_admin();

-- =========================================================================
-- RLS helpers — SECURITY DEFINER breaks the self-referential recursion that
-- a naive policy on workspace_members would otherwise hit (querying
-- workspace_members from within its own policy hard-fails every query on the
-- table with "infinite recursion detected in policy").
--
-- Every helper here is set-returning (or scalar) and takes NO row-dependent
-- argument, so Postgres can hoist it into an InitPlan and evaluate it once
-- per statement instead of once per row. This is what keeps
-- `client_space_id in (select current_client_space_ids())` cheap on a
-- multi-million-row table. Do not rewrite any of these to take the row's own
-- id as a parameter.
-- =========================================================================
create or replace function public.current_workspace_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select wm.workspace_id
  from public.workspace_members wm
  where wm.user_id = auth.uid();
$$;

-- A user's tenants: those they administer, plus those reached through any
-- workspace they belong to. The union is necessary because a billing_admin
-- may legitimately have no workspace membership at all.
create or replace function public.current_tenant_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select ta.tenant_id from public.tenant_admins ta where ta.user_id = auth.uid()
  union
  select w.tenant_id
  from public.workspaces w
  join public.workspace_members wm on wm.workspace_id = w.id
  where wm.user_id = auth.uid();
$$;

create or replace function public.is_workspace_member(p_workspace_id uuid)
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
      and wm.role = any (p_roles)
  );
$$;

create or replace function public.has_tenant_role(p_tenant_id uuid, p_roles public.tenant_admin_role[])
returns boolean
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_admins ta
    where ta.tenant_id = p_tenant_id
      and ta.user_id = auth.uid()
      and ta.role = any (p_roles)
  );
$$;

revoke execute on function public.current_workspace_ids() from public, anon;
revoke execute on function public.current_tenant_ids() from public, anon;
revoke execute on function public.is_workspace_member(uuid) from public, anon;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
revoke execute on function public.has_tenant_role(uuid, public.tenant_admin_role[]) from public, anon;
grant execute on function public.current_workspace_ids() to authenticated;
grant execute on function public.current_tenant_ids() to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;
grant execute on function public.has_tenant_role(uuid, public.tenant_admin_role[]) to authenticated;

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.users             enable row level security;
alter table public.tenants           enable row level security;
alter table public.tenant_admins     enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

-- users: self + co-members (needed to render assignee avatars/names)
create policy users_select_self on public.users for select to authenticated
  using (id = (select auth.uid()));
create policy users_select_comembers on public.users for select to authenticated
  using (exists (
    select 1 from public.workspace_members wm
    where wm.user_id = public.users.id
      and wm.workspace_id in (select public.current_workspace_ids())
  ));
create policy users_update_self on public.users for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- No insert policy: rows are created only by the auth.users trigger.

-- Table-level GRANTs are a separate lock from RLS policies, not implied by
-- them: this project defaults new tables to NOT auto-exposing any privilege
-- to anon/authenticated (supabase/config.toml `auto_expose_new_tables`), so
-- every operation a policy permits also needs an explicit GRANT here, or
-- PostgREST fails with "permission denied" before RLS is ever evaluated.
grant select on public.users to authenticated;
revoke update on public.users from authenticated;
grant update (full_name, avatar_url) on public.users to authenticated;

-- tenants
--
-- The `or owner_id = auth.uid()` arm is not redundant with
-- current_tenant_ids(): it is what makes a just-created tenant visible to its
-- creator. `INSERT ... RETURNING` requires the new row to pass a SELECT
-- policy to be returned, and that check does not observe the AFTER INSERT
-- trigger's effect within the same statement — without this arm every tenant
-- creation fails with a misleading "new row violates row-level security
-- policy" that is really a RETURNING-visibility failure.
create policy tenants_select on public.tenants for select to authenticated
  using (id in (select public.current_tenant_ids()) or owner_id = (select auth.uid()));
create policy tenants_insert on public.tenants for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy tenants_update on public.tenants for update to authenticated
  using (public.has_tenant_role(id, array['super_admin']::public.tenant_admin_role[]))
  with check (public.has_tenant_role(id, array['super_admin']::public.tenant_admin_role[]));

grant select, insert on public.tenants to authenticated;
-- `status` is driven by the billing webhook and `owner_id` by an ownership-
-- transfer flow that does not exist yet; neither may be PATCHed straight
-- through PostgREST. RLS cannot restrict which columns an UPDATE touches, so
-- this column list is the only thing enforcing that.
revoke update on public.tenants from authenticated;
grant update (name, domain, settings) on public.tenants to authenticated;

-- tenant_admins: self-row policy is the recursion-safe base case; the
-- co-admin policy uses the SECURITY DEFINER helper (also recursion-safe).
create policy tenant_admins_select_self on public.tenant_admins for select to authenticated
  using (user_id = (select auth.uid()));
create policy tenant_admins_select_peers on public.tenant_admins for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));
create policy tenant_admins_write_super on public.tenant_admins for all to authenticated
  using (public.has_tenant_role(tenant_id, array['super_admin']::public.tenant_admin_role[]))
  with check (public.has_tenant_role(tenant_id, array['super_admin']::public.tenant_admin_role[]));

grant select, insert, update, delete on public.tenant_admins to authenticated;

-- workspaces. Same RETURNING-visibility reasoning as tenants above for the
-- `or owner_id` arm.
create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select public.current_workspace_ids()) or owner_id = (select auth.uid()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    -- Creating a workspace is a billing-visible act (it consumes
    -- max_workspaces), so it is a tenant-admin action, not something any
    -- member of any workspace in the tenant may do.
    and public.has_tenant_role(tenant_id, array['super_admin']::public.tenant_admin_role[])
  );
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_workspace_role(id, array['owner']::public.workspace_role[]));

grant select, insert, delete on public.workspaces to authenticated;
revoke update on public.workspaces from authenticated;
grant update (name, description, logo_path) on public.workspaces to authenticated;

-- workspace_members: self-row policy is the recursion-safe base case, the
-- co-members policy uses the SECURITY DEFINER helper (also recursion-safe).
create policy wm_select_self on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy wm_select_comembers on public.workspace_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy wm_write_admin on public.workspace_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

grant select, insert, update, delete on public.workspace_members to authenticated;
