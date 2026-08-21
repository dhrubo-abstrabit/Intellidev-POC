-- =========================================================================
-- LEVEL 3 — client_spaces: the operational unit.
--
-- This is where connectors are granted and where every ingested and derived
-- row lives: credentials, integrations, cursors, sync jobs, raw and
-- normalized events, attachments, LLM runs, action items, summaries,
-- milestones. A project (level 4) is a scoped *view* over a client space's
-- data, not a separate data owner.
--
-- `timezone` lives here, not on projects, because daily_summaries and
-- action_items.for_date are client-space scoped — "today" has to be defined
-- at the level that owns the day's rows. Must NOT default to the server's TZ.
--
-- Access note, deliberate and documented: there is no client_space_members
-- table. Visibility is inherited wholesale from workspace membership (see
-- current_client_space_ids below), so every member of a workspace can read
-- every client space beneath it. Client spaces organise; they do not isolate.
-- =========================================================================
create table public.client_spaces (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  tenant_id    uuid not null,
  name         text not null check (length(btrim(name)) between 1 and 160),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description  text,
  logo_path    text,
  timezone     text not null default 'UTC',
  status       public.client_space_status not null default 'active',
  archived_at  timestamptz,
  created_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, slug),
  foreign key (workspace_id, tenant_id)
    references public.workspaces (id, tenant_id) on delete cascade,
  -- Composite FK target for every level-3 table below, so a client space from
  -- workspace A can never be referenced by a row tagged workspace B.
  constraint client_spaces_id_workspace_id_key unique (id, workspace_id)
);

create index client_spaces_workspace_status_idx
  on public.client_spaces (workspace_id, status);

create trigger trg_client_spaces_updated_at
  before update on public.client_spaces
  for each row execute function public.set_updated_at();

-- =========================================================================
-- The level-3 RLS key. Set-returning with no row-dependent argument, exactly
-- like current_workspace_ids(), so Postgres hoists it into an InitPlan and
-- evaluates it once per statement — this is what keeps
-- `client_space_id in (select current_client_space_ids())` an index probe
-- rather than a per-row function call on normalized_events.
-- =========================================================================
create or replace function public.current_client_space_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select cs.id
  from public.client_spaces cs
  where cs.workspace_id in (select public.current_workspace_ids());
$$;

revoke execute on function public.current_client_space_ids() from public, anon;
grant execute on function public.current_client_space_ids() to authenticated;

alter table public.client_spaces enable row level security;

create policy client_spaces_select on public.client_spaces for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy client_spaces_insert on public.client_spaces for insert to authenticated
  with check (public.has_workspace_role(
    workspace_id, array['owner', 'admin']::public.workspace_role[]
  ));
create policy client_spaces_update on public.client_spaces for update to authenticated
  using (public.has_workspace_role(
    workspace_id, array['owner', 'admin']::public.workspace_role[]
  ))
  with check (public.has_workspace_role(
    workspace_id, array['owner', 'admin']::public.workspace_role[]
  ));
create policy client_spaces_delete on public.client_spaces for delete to authenticated
  using (public.has_workspace_role(
    workspace_id, array['owner']::public.workspace_role[]
  ));

grant select, insert, delete on public.client_spaces to authenticated;
revoke update on public.client_spaces from authenticated;
grant update (name, description, logo_path, timezone, status, archived_at)
  on public.client_spaces to authenticated;

-- =========================================================================
-- team_members: workspace-level roster/directory of people relevant to the
-- workspace's work (client contacts, stakeholders, vendors).
--
-- Deliberately NOT the same concept as workspace_members: a team_members row
-- requires no Supabase Auth account and confers no access to this app — it is
-- just a name/email/role/description someone typed in. `created_by` records
-- who entered the row (a real logged-in user), not who the row describes.
--
-- Stays at the workspace, not the client space: the same stakeholder is
-- routinely relevant across several client spaces run by one team, and an
-- action item assigned to them should not need re-entering per client.
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
  -- Composite-FK target for action_items.assignee_team_member_id.
  constraint team_members_id_workspace_id_key unique (id, workspace_id)
);

create index team_members_workspace_id_name_idx on public.team_members (workspace_id, name);

create trigger trg_team_members_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

alter table public.team_members enable row level security;

create policy team_members_select on public.team_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy team_members_write_admin on public.team_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

grant select, insert, update, delete on public.team_members to authenticated;
