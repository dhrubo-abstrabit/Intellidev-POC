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

-- Populate public.users whenever a new auth user is created (email/password
-- or Google OAuth — both land in auth.users the same way).
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
-- workspaces
-- =========================================================================
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description text,
  logo_path   text,
  owner_id    uuid not null references public.users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint workspaces_id_key unique (id)
);

create index workspaces_owner_id_idx on public.workspaces (owner_id);

create trigger trg_workspaces_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

-- =========================================================================
-- workspace_members
-- =========================================================================
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.users (id) on delete cascade,
  role         public.workspace_role not null default 'member',
  invited_by   uuid references public.users (id) on delete set null,
  joined_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Reverse-lookup index: "which workspaces am I in" is the RLS hot path.
create index workspace_members_user_id_idx on public.workspace_members (user_id, workspace_id);

create trigger trg_workspace_members_updated_at
  before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- Bootstrap: whoever creates a workspace becomes its 'owner' member atomically,
-- so the creator can read the workspace back under RLS without a second round-trip.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
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

-- =========================================================================
-- RLS helpers — SECURITY DEFINER breaks the self-referential recursion that
-- a naive policy on workspace_members would otherwise hit (querying
-- workspace_members from within its own policy recurses and Postgres
-- hard-fails every query on the table with "infinite recursion detected in
-- policy for relation workspace_members").
--
-- (A) is set-returning and takes no row-dependent argument, so Postgres can
-- hoist it into an InitPlan and evaluate it once per statement instead of
-- once per row — this is what keeps `workspace_id in (select
-- current_workspace_ids())` cheap on a multi-million-row table.
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

revoke execute on function public.current_workspace_ids() from public, anon;
revoke execute on function public.is_workspace_member(uuid) from public, anon;
revoke execute on function public.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
grant execute on function public.current_workspace_ids() to authenticated;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.users             enable row level security;
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
-- them: this CLI/project defaults new tables to NOT auto-exposing any
-- privilege to anon/authenticated (see supabase/config.toml
-- `auto_expose_new_tables`), so every operation a policy above permits also
-- needs an explicit GRANT here, or PostgREST fails with "permission denied"
-- before RLS is ever evaluated. This pairing (GRANT here, RLS above) is
-- applied per-table for every client-facing table in every migration below.
grant select on public.users to authenticated;
revoke update on public.users from authenticated;
grant update (full_name, avatar_url) on public.users to authenticated;

-- workspaces
--
-- The `or owner_id = auth.uid()` arm is not redundant with
-- current_workspace_ids() — it's what makes a just-created workspace
-- visible to its creator. `INSERT ... RETURNING` (which is what
-- `.insert(...).select()` compiles to) requires the new row to pass a
-- SELECT policy to be returned; without this arm, that check depends on
-- the workspace_members row that trg_on_workspace_created only inserts via
-- an AFTER INSERT trigger, and RETURNING's visibility check does not
-- observe that trigger's effect on the same statement. The result is a
-- misleading "new row violates row-level security policy for table
-- workspaces" — a RETURNING-visibility failure, not a WITH CHECK failure —
-- on every workspace creation. Checking owner_id directly is also just
-- correct on its own terms: an owner can always see their own workspace,
-- independent of whether the membership row exists yet.
create policy workspaces_select on public.workspaces for select to authenticated
  using (id in (select public.current_workspace_ids()) or owner_id = (select auth.uid()));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy workspaces_update on public.workspaces for update to authenticated
  using (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner', 'admin']::public.workspace_role[]));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (public.has_workspace_role(id, array['owner']::public.workspace_role[]));

grant select, insert, update, delete on public.workspaces to authenticated;

-- workspace_members: self-row policy is the recursion-safe base case, the
-- comembers policy uses the SECURITY DEFINER helper (also recursion-safe).
create policy wm_select_self on public.workspace_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy wm_select_comembers on public.workspace_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy wm_write_admin on public.workspace_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

grant select, insert, update, delete on public.workspace_members to authenticated;
