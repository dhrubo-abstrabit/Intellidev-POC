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

-- NOTE: this trigger lives on auth.users, OUTSIDE the public schema. It is
-- therefore the one object in this file that a `drop schema public cascade`
-- does not fully clean up on its own — the trigger row survives while its
-- function body vanishes, and every signup then fails. Any future schema
-- reset must drop this trigger explicitly before the cascade.
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- =========================================================================
-- LEVEL 1 — tenants: the billing entity.
--
-- Deliberately has NO `plan`/`seats` columns: those live on
-- tenant_subscriptions and nowhere else. Carrying them in both places gives
-- two sources of truth for one fact, and they drift the first time an upgrade
-- writes only one of them.
--
-- Also deliberately has NO `owner_id`: ownership is tenant_members.role =
-- 'owner'. A column and a role row would be the same two-sources-of-truth
-- mistake, and the role form additionally allows more than one owner.
-- =========================================================================
create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 160),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  domain     text,
  status     text not null default 'active'
               check (status in ('active', 'suspended', 'cancelled')),
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(settings) = 'object')
);

create trigger trg_tenants_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

-- =========================================================================
-- tenant_subscriptions: Stripe state + the plan's caps. One row per tenant.
--
-- `seats` is now genuinely countable against tenant_members — one row per
-- human, no DISTINCT needed, no double-counting someone who belongs to two
-- workspaces. That was impossible under the previous schema, which had no
-- tenant-level record of an ordinary user.
-- =========================================================================
create table public.tenant_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null unique references public.tenants (id) on delete cascade,

  stripe_customer_id     text unique,
  stripe_subscription_id text unique,

  plan                   text not null default 'trial'
                           check (plan ~ '^[a-z][a-z0-9_]{1,40}$'),
  status                 text not null default 'trialing'
                           check (status in ('trialing', 'active', 'past_due', 'cancelled')),

  -- null = unlimited, consistently, on every cap below.
  seats                  integer check (seats is null or seats > 0),
  max_workspaces         integer check (max_workspaces is null or max_workspaces > 0),
  max_client_spaces      integer check (max_client_spaces is null or max_client_spaces > 0),
  max_projects           integer check (max_projects is null or max_projects > 0),

  trial_ends_at          timestamptz,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger trg_tenant_subscriptions_updated_at
  before update on public.tenant_subscriptions
  for each row execute function public.set_updated_at();

-- =========================================================================
-- tenant_members: the seat roster AND tenant authority.
--
-- Its (tenant_id, user_id) primary key is the FK target for BOTH
-- workspace_members and space_members. That is what makes "every workspace or
-- space member is on the company roster" structurally true rather than merely
-- intended, and it is what makes offboarding a single delete: remove the
-- tenant_members row and every workspace and space membership cascades away.
-- =========================================================================
create table public.tenant_members (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  role       public.tenant_role not null default 'member',
  invited_by uuid references public.users (id) on delete set null,
  joined_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on public.tenant_members (user_id, tenant_id);

create trigger trg_tenant_members_updated_at
  before update on public.tenant_members
  for each row execute function public.set_updated_at();

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
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, slug),
  -- Composite FK target: children FK on (workspace_id, tenant_id), making a
  -- cross-tenant row physically impossible rather than merely policy-forbidden.
  constraint workspaces_id_tenant_id_key unique (id, tenant_id)
);

create index workspaces_tenant_id_idx on public.workspaces (tenant_id);

create trigger trg_workspaces_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- =========================================================================
-- workspace_members: workspace AUTHORITY, not data access.
--
-- An `admin` here may create and manage client spaces, projects and
-- invitations beneath this workspace. None of that grants a single row of
-- ingested data — that requires an explicit space_members row (see
-- 20260901000500_client_spaces.sql). A workspace admin can always add
-- themselves to a space, so isolation is AUDITABLE rather than absolute:
-- there is a row recording the access, instead of it being ambient.
--
-- Two composite FKs, both load-bearing:
--   (workspace_id, tenant_id) -> workspaces  : no cross-tenant membership
--   (tenant_id, user_id) -> tenant_members   : no member off the roster
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
  primary key (workspace_id, user_id),
  foreign key (workspace_id, tenant_id)
    references public.workspaces (id, tenant_id) on delete cascade,
  foreign key (tenant_id, user_id)
    references public.tenant_members (tenant_id, user_id) on delete cascade
);

-- Reverse-lookup index: "which workspaces am I in" is an RLS hot path.
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id);

create trigger trg_workspace_members_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- =========================================================================
-- Roster auto-provisioning.
--
-- The composite FK above makes a workspace member who is not a tenant member
-- impossible — but "impossible" would otherwise mean "the insert throws",
-- which pushes a two-step dance onto every caller. This trigger closes the
-- gap the way handle_new_workspace does one level down: it provisions the
-- roster row first, so the FK is satisfied by the time it is checked.
--
-- BEFORE INSERT specifically: FK constraints are checked after BEFORE
-- triggers fire, so the tenant_members row exists in time.
--
-- Seat-cap enforcement, if it is ever added, belongs HERE — this is the one
-- chokepoint through which a new seat can be consumed.
-- =========================================================================
create or replace function public.ensure_tenant_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_members (tenant_id, user_id, role)
  values (new.tenant_id, new.user_id, 'member')
  on conflict (tenant_id, user_id) do nothing;
  return new;
end;
$$;

create trigger trg_workspace_members_ensure_roster
  before insert on public.workspace_members
  for each row execute function public.ensure_tenant_membership();

-- Whoever creates a tenant becomes its owner atomically, so the creator can
-- read it back under RLS without a second round-trip.
create or replace function public.handle_new_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;   -- service-role provisioning with no actor; nothing to grant.
  end if;
  insert into public.tenant_members (tenant_id, user_id, role)
  values (new.id, auth.uid(), 'owner')
  on conflict (tenant_id, user_id) do update set role = 'owner';
  return new;
end;
$$;

create trigger trg_on_tenant_created
  after insert on public.tenants
  for each row execute function public.handle_new_tenant();

-- Same pattern one level down: the workspace creator becomes its admin.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  insert into public.workspace_members (workspace_id, tenant_id, user_id, role)
  values (new.id, new.tenant_id, auth.uid(), 'admin')
  on conflict (workspace_id, user_id) do update set role = 'admin';
  return new;
end;
$$;

create trigger trg_on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- =========================================================================
-- Last-admin guards. Without these, the final owner/admin can remove or
-- demote themselves and orphan the tenant or workspace with no way back in.
--
-- Both skip the check when the PARENT row is itself being deleted: a cascade
-- deletes members in unspecified order, and guarding then would make deleting
-- a tenant or workspace impossible. `pg_trigger_depth() > 1` detects that the
-- delete arrived via a cascade rather than directly.
-- =========================================================================
create or replace function public.guard_last_tenant_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into remaining
    from public.tenant_members
    where tenant_id = old.tenant_id and role = 'owner' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'tenant % must keep at least one owner', old.tenant_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_guard_last_tenant_owner
  before update or delete on public.tenant_members
  for each row execute function public.guard_last_tenant_owner();

create or replace function public.guard_last_workspace_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining integer;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;

  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    select count(*) into remaining
    from public.workspace_members
    where workspace_id = old.workspace_id and role = 'admin' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'workspace % must keep at least one admin', old.workspace_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_guard_last_workspace_admin
  before update or delete on public.workspace_members
  for each row execute function public.guard_last_workspace_admin();

-- =========================================================================
-- RLS helpers — levels 1 and 2.
--
-- SECURITY DEFINER breaks the self-referential recursion a naive policy on
-- workspace_members would otherwise hit (querying workspace_members from
-- within its own policy hard-fails every query on the table with "infinite
-- recursion detected in policy").
--
-- Every helper is set-returning or scalar and takes NO row-dependent
-- argument, so Postgres can hoist it into an InitPlan and evaluate it once
-- per statement instead of once per row. That is what keeps
-- `client_space_id in (select current_client_space_ids())` cheap on a
-- multi-million-row table. Do not rewrite any of these to take the row's own
-- id as a parameter.
-- =========================================================================
create or replace function public.current_tenant_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select tm.tenant_id from public.tenant_members tm where tm.user_id = auth.uid();
$$;

-- Workspaces reachable by the caller: explicit membership, plus every
-- workspace in a tenant they own. The second arm is what stops a tenant owner
-- being locked out of a workspace they did not personally join.
create or replace function public.current_workspace_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select wm.workspace_id from public.workspace_members wm where wm.user_id = auth.uid()
  union
  select w.id
  from public.workspaces w
  join public.tenant_members tm on tm.tenant_id = w.tenant_id
  where tm.user_id = auth.uid() and tm.role = 'owner';
$$;

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
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid() and tm.role = any (p_roles)
  );
$$;

-- Tenant owners carry workspace authority implicitly — same reasoning as the
-- second arm of current_workspace_ids().
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
    where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid() and wm.role = any (p_roles)
  ) or exists (
    select 1
    from public.workspaces w
    join public.tenant_members tm on tm.tenant_id = w.tenant_id
    where w.id = p_workspace_id and tm.user_id = auth.uid() and tm.role = 'owner'
  );
$$;

revoke execute on function public.current_tenant_ids() from public, anon;
revoke execute on function public.current_workspace_ids() from public, anon;
revoke execute on function public.has_tenant_role(uuid, public.tenant_role[]) from public, anon;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
grant execute on function public.current_tenant_ids() to authenticated;
grant execute on function public.current_workspace_ids() to authenticated;
grant execute on function public.has_tenant_role(uuid, public.tenant_role[]) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.users                enable row level security;
alter table public.tenants              enable row level security;
alter table public.tenant_subscriptions enable row level security;
alter table public.tenant_members       enable row level security;
alter table public.workspaces           enable row level security;
alter table public.workspace_members    enable row level security;

-- users: self + co-members (needed to render assignee avatars/names).
create policy users_select_self on public.users for select to authenticated
  using (id = (select auth.uid()));
create policy users_select_comembers on public.users for select to authenticated
  using (exists (
    select 1 from public.tenant_members tm
    where tm.user_id = public.users.id
      and tm.tenant_id in (select public.current_tenant_ids())
  ));
create policy users_update_self on public.users for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- No insert policy: rows are created only by the auth.users trigger.

-- Table-level GRANTs are a separate lock from RLS policies, not implied by
-- them: this project does not auto-expose new tables (supabase/config.toml),
-- so every operation a policy permits also needs an explicit GRANT here, or
-- PostgREST fails with "permission denied" before RLS is ever evaluated.
grant select on public.users to authenticated;
revoke update on public.users from authenticated;
grant update (full_name, avatar_url) on public.users to authenticated;

-- tenants. `INSERT ... RETURNING` requires the new row to pass a SELECT
-- policy to be returned, and that check does not observe the AFTER INSERT
-- trigger's effect within the same statement — hence the tenants_select_new
-- policy, without which every tenant creation fails with a misleading "new
-- row violates row-level security policy" that is really a RETURNING failure.
create policy tenants_select on public.tenants for select to authenticated
  using (id in (select public.current_tenant_ids()));
create policy tenants_insert on public.tenants for insert to authenticated
  with check (true);
create policy tenants_update on public.tenants for update to authenticated
  using (public.has_tenant_role(id, array['owner']::public.tenant_role[]))
  with check (public.has_tenant_role(id, array['owner']::public.tenant_role[]));

grant select, insert on public.tenants to authenticated;
-- `status` is driven by the billing webhook; it may not be PATCHed through
-- PostgREST. RLS cannot restrict which columns an UPDATE touches, so this
-- column list is the only thing enforcing that.
revoke update on public.tenants from authenticated;
grant update (name, domain, settings) on public.tenants to authenticated;

-- tenant_subscriptions: readable by anyone who can see the tenant (the
-- billing page renders plan + period + caps). Written only by the Stripe
-- webhook via the service role — no write grant, so a member cannot PATCH
-- their own plan or caps.
create policy tenant_subscriptions_select on public.tenant_subscriptions for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));
grant select on public.tenant_subscriptions to authenticated;
revoke insert, update, delete on public.tenant_subscriptions from authenticated, anon;

-- tenant_members: the self-row policy is the recursion-safe base case; the
-- peer policy uses the SECURITY DEFINER helper (also recursion-safe).
create policy tenant_members_select_self on public.tenant_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy tenant_members_select_peers on public.tenant_members for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));
create policy tenant_members_write_owner on public.tenant_members for all to authenticated
  using (public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[]))
  with check (public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[]));

grant select, insert, update, delete on public.tenant_members to authenticated;

-- workspaces.
create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select public.current_workspace_ids()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  -- Creating a workspace is a billing-visible act (it consumes
  -- max_workspaces), so it is a tenant-owner action, not something any
  -- member of any workspace in the tenant may do.
  with check (public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[]));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_workspace_role(id, array['admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[]));

grant select, insert, delete on public.workspaces to authenticated;
revoke update on public.workspaces from authenticated;
grant update (name, description, logo_path) on public.workspaces to authenticated;

-- workspace_members: same recursion-safe shape as tenant_members.
create policy wm_select_self on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy wm_select_comembers on public.workspace_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy wm_write_admin on public.workspace_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]));

grant select, insert, update, delete on public.workspace_members to authenticated;
