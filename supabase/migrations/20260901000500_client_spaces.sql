-- =========================================================================
-- LEVEL 3 — client_spaces: the client engagement, and the operational unit.
--
-- This is where connectors are granted and where every ingested and derived
-- row lives: connections, cursors, sync jobs, raw and normalized events,
-- attachments, context documents, search chunks, LLM runs, tasks, digests.
--
-- `timezone` lives here, not on projects, because tasks.for_date and the
-- nightly digest are client-space scoped — "today" has to be defined at the
-- level that owns the day's rows. Must NOT default to the server's TZ.
--
-- THIS IS THE DATA ACCESS BOUNDARY. Unlike the previous schema — where
-- visibility was inherited wholesale from workspace membership and client
-- spaces explicitly "organised but did not isolate" — a client space now has
-- its own membership table. Two clients under one workspace genuinely do not
-- see each other's Slack, Drive or mail.
-- =========================================================================
create table public.client_spaces (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  workspace_id    uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 160),
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description     text,
  timezone        text not null default 'UTC',
  -- A short, stable brief about this client. Goes in the cached prompt prefix,
  -- so it must stay small and change rarely — a large or churning value
  -- invalidates the prompt cache on every run and costs real money.
  context_profile text check (context_profile is null or length(context_profile) <= 4000),
  archived_at     timestamptz,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, slug),
  foreign key (workspace_id, tenant_id)
    references public.workspaces (id, tenant_id) on delete cascade,
  -- Two composite FK targets: everything at level 3 and below uses the first;
  -- space_members uses the second to reach tenant_members.
  constraint client_spaces_id_workspace_id_key unique (id, workspace_id),
  constraint client_spaces_id_tenant_id_key    unique (id, tenant_id)
);

create index client_spaces_workspace_idx
  on public.client_spaces (workspace_id) where archived_at is null;

create trigger trg_client_spaces_updated_at
  before update on public.client_spaces
  for each row execute function public.set_updated_at();

-- =========================================================================
-- space_members: THE data access boundary.
--
-- `admin` is the team admin for this engagement: manages space membership,
-- connects connectors, creates projects, and sees every project in the space.
--
-- Two composite FKs, both load-bearing:
--   (client_space_id, tenant_id) -> client_spaces : no cross-tenant membership
--   (tenant_id, user_id) -> tenant_members        : no member off the roster
--
-- Its (client_space_id, user_id) primary key is the FK target for
-- project_members, so a project role cannot be granted to someone with no
-- standing in the space, and removing them from the space cascades every
-- project role away.
-- =========================================================================
create table public.space_members (
  client_space_id uuid not null,
  tenant_id       uuid not null,
  user_id         uuid not null references public.users (id) on delete cascade,
  role            public.space_role not null default 'member',
  invited_by      uuid references public.users (id) on delete set null,
  joined_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (client_space_id, user_id),
  foreign key (client_space_id, tenant_id)
    references public.client_spaces (id, tenant_id) on delete cascade,
  foreign key (tenant_id, user_id)
    references public.tenant_members (tenant_id, user_id) on delete cascade
);

create index space_members_user_id_idx on public.space_members (user_id, client_space_id);

create trigger trg_space_members_updated_at
  before update on public.space_members
  for each row execute function public.set_updated_at();

-- Same roster auto-provisioning as workspace_members — see the note on
-- ensure_tenant_membership() in 20260901000400_tenancy.sql.
create trigger trg_space_members_ensure_roster
  before insert on public.space_members
  for each row execute function public.ensure_tenant_membership();

-- The space creator becomes its admin atomically. Load-bearing, not a
-- nicety: without it, creating a client space locks the creator out of the
-- data they just set up, because workspace authority alone grants no rows.
create or replace function public.handle_new_client_space()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;   -- service-role provisioning with no actor.
  end if;
  insert into public.space_members (client_space_id, tenant_id, user_id, role)
  values (new.id, new.tenant_id, auth.uid(), 'admin')
  on conflict (client_space_id, user_id) do update set role = 'admin';
  return new;
end;
$$;

create trigger trg_on_client_space_created
  after insert on public.client_spaces
  for each row execute function public.handle_new_client_space();

-- Same shape and same cascade caveat as the tenant/workspace guards.
create or replace function public.guard_last_space_admin()
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
    from public.space_members
    where client_space_id = old.client_space_id and role = 'admin' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'client space % must keep at least one admin', old.client_space_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_guard_last_space_admin
  before update or delete on public.space_members
  for each row execute function public.guard_last_space_admin();

-- =========================================================================
-- The level-3 RLS keys. TWO functions, deliberately distinct — this split is
-- the whole reason workspace authority and data access can coexist.
--
--   current_client_space_ids()    - DATA. space_members only. Every event,
--                                   task, chunk and document policy uses
--                                   this and nothing else.
--   manageable_client_space_ids() - MANAGEMENT. workspace admins and space
--                                   admins. Governs the client_spaces row
--                                   itself, project creation, and connector
--                                   configuration — never ingested data.
--
-- A workspace admin can therefore see that a client space exists and manage
-- its shape, while reading none of its content until they add themselves to
-- space_members. That insert is a visible, auditable row rather than ambient
-- access.
--
-- Both are set-returning with no row-dependent argument so Postgres hoists
-- them into an InitPlan — see the note in 20260901000400_tenancy.sql.
-- =========================================================================
create or replace function public.current_client_space_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select sm.client_space_id from public.space_members sm where sm.user_id = auth.uid();
$$;

create or replace function public.manageable_client_space_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select sm.client_space_id
  from public.space_members sm
  where sm.user_id = auth.uid() and sm.role = 'admin'
  union
  select cs.id
  from public.client_spaces cs
  where cs.workspace_id in (
    select wm.workspace_id from public.workspace_members wm
    where wm.user_id = auth.uid() and wm.role = 'admin'
  )
  union
  -- Tenant owners retain authority everywhere beneath them, consistently with
  -- has_workspace_role()'s second arm.
  select cs.id
  from public.client_spaces cs
  join public.tenant_members tm on tm.tenant_id = cs.tenant_id
  where tm.user_id = auth.uid() and tm.role = 'owner';
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
      and sm.role = any (p_roles)
  );
$$;

revoke execute on function public.current_client_space_ids() from public, anon;
revoke execute on function public.manageable_client_space_ids() from public, anon;
revoke execute on function public.has_space_role(uuid, public.space_role[]) from public, anon;
grant execute on function public.current_client_space_ids() to authenticated;
grant execute on function public.manageable_client_space_ids() to authenticated;
grant execute on function public.has_space_role(uuid, public.space_role[]) to authenticated;

-- =========================================================================
-- team_members: workspace-level roster of people relevant to the work
-- (client contacts, stakeholders, vendors).
--
-- Deliberately NOT the same concept as any membership table: a team_members
-- row requires no Supabase Auth account and confers no access to this app —
-- it is just a name/email/role someone typed in. `created_by` records who
-- entered the row, not who the row describes.
--
-- Stays at the workspace, not the client space: the same stakeholder is
-- routinely relevant across several engagements run by one team, and a task
-- assigned to them should not need re-entering per client.
-- =========================================================================
create table public.team_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 160),
  email        extensions.citext not null
                 check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role         text check (role is null or length(btrim(role)) <= 160),
  description  text check (description is null or length(description) <= 2000),
  created_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Not global: the same person can legitimately appear on more than one
  -- workspace's roster.
  unique (workspace_id, email),
  -- Composite-FK target for tasks.assignee_team_member_id.
  constraint team_members_id_workspace_id_key unique (id, workspace_id)
);

create index team_members_workspace_id_name_idx on public.team_members (workspace_id, name);

create trigger trg_team_members_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.client_spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.team_members  enable row level security;

-- The client_spaces ROW is visible to members and to managers; its DATA is
-- not. Note the two-armed predicate — this is the split described above.
create policy client_spaces_select on public.client_spaces for select to authenticated
  using (
    id in (select public.current_client_space_ids())
    or id in (select public.manageable_client_space_ids())
  );
create policy client_spaces_insert on public.client_spaces for insert to authenticated
  with check (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]));
create policy client_spaces_update on public.client_spaces for update to authenticated
  using (id in (select public.manageable_client_space_ids()))
  with check (id in (select public.manageable_client_space_ids()));
create policy client_spaces_delete on public.client_spaces for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]));

grant select, insert, delete on public.client_spaces to authenticated;
revoke update on public.client_spaces from authenticated;
grant update (name, description, timezone, context_profile, archived_at)
  on public.client_spaces to authenticated;

-- space_members: self-row policy is the recursion-safe base case.
create policy sm_select_self on public.space_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy sm_select_comembers on public.space_members for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
-- Managers may also read the roster of a space they administer without being
-- a member of it — needed to add the first member to a new space.
create policy sm_select_managers on public.space_members for select to authenticated
  using (client_space_id in (select public.manageable_client_space_ids()));
create policy sm_write_admin on public.space_members for all to authenticated
  using (client_space_id in (select public.manageable_client_space_ids()))
  with check (client_space_id in (select public.manageable_client_space_ids()));

grant select, insert, update, delete on public.space_members to authenticated;

-- team_members is workspace-scoped and contains no ingested data, so it keys
-- on workspace membership rather than the space data boundary.
create policy team_members_select on public.team_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy team_members_write_admin on public.team_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]));

grant select, insert, update, delete on public.team_members to authenticated;
