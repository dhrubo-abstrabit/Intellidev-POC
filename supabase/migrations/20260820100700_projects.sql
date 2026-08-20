-- =========================================================================
-- LEVEL 4 — projects: a scoped view over a client space.
--
-- A project does NOT own ingested data. raw_events, normalized_events,
-- attachments, summaries and llm_runs all key on client_space_id. What a
-- project owns is: which integrations feed it (project_connector_scopes),
-- which action items and milestones are tagged into it, and its own context
-- documents.
-- =========================================================================
create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 160),
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description     text,
  status          public.project_status not null default 'active',
  health_score    smallint check (health_score between 0 and 100),

  -- 'workspace' (default): every workspace member can see this project, and
  -- project_members rows only record per-project ROLE overrides.
  -- 'restricted': only users with a project_members row can see it at all.
  visibility      public.project_visibility not null default 'workspace',

  -- Project-specific context and directives layered on top of the client
  -- space's AI output. Shape validated at the app layer, not by a constraint.
  context_docs    jsonb not null default '[]'::jsonb,

  archived_at     timestamptz,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (client_space_id, slug),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  -- Two composite-FK targets: children that live under the client space use
  -- the first, project_members uses the second.
  constraint projects_id_client_space_id_key unique (id, client_space_id),
  constraint projects_id_workspace_id_key unique (id, workspace_id),
  check (jsonb_typeof(context_docs) = 'array')
);

create index projects_client_space_status_idx
  on public.projects (client_space_id, status);
create index projects_restricted_idx
  on public.projects (client_space_id)
  where visibility = 'restricted';

create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

-- =========================================================================
-- project_members: the access table.
--
-- Two jobs, depending on the project's `visibility`:
--   * visibility='workspace' — an ELEVATION table. Everyone in the workspace
--     already sees the project; a row here only says "this person's role on
--     THIS project differs from their workspace baseline".
--   * visibility='restricted' — an ACCESS LIST. Only users with a row can
--     see the project at all.
--
-- `role` is nullable on purpose. NULL means "no override, inherit the
-- workspace baseline" — which is what lets a restricted project grant plain
-- access without also having to restate a role.
--
-- Sizing, for the case that motivated this table: a department of 5 PMs and
-- 30 devs running 5 projects is 35 workspace_members rows plus 5 rows here
-- (one per PM on their own project) — not 175. That is the whole point of
-- baseline-plus-elevation over an authoritative per-project membership table.
--
-- The FK to workspace_members is load-bearing: it makes a project role for a
-- non-member structurally impossible, and removing someone from the workspace
-- cascades every project role away, so offboarding stays a single delete.
-- =========================================================================
create table public.project_members (
  project_id   uuid not null,
  user_id      uuid not null,
  workspace_id uuid not null,
  role         public.project_role,   -- null = inherit workspace baseline
  added_by     uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  foreign key (workspace_id, user_id)
    references public.workspace_members (workspace_id, user_id) on delete cascade
);

create index project_members_user_idx on public.project_members (user_id, project_id);

create trigger trg_project_members_updated_at
  before update on public.project_members
  for each row execute function public.set_updated_at();

-- Bootstrap: the creator becomes a manager on their own project, atomically —
-- the same pattern handle_new_workspace() uses one level up.
--
-- This is load-bearing for visibility='restricted', not a nicety. Without it,
-- creating a restricted project locks the creator straight out of it: the
-- project matches no arm of current_project_roles(), so it is invisible to
-- everyone including the workspace owner who just created it, and it never
-- appears in any listing again. (A workspace admin could still insert a
-- project_members row via the write policy below, but only if they already
-- knew the id of a project they cannot see.)
--
-- Residual case, accepted: if that creator later leaves the workspace, this
-- row cascades away with their workspace_members row and a restricted project
-- can end up with no members. Recovery is a workspace admin adding someone
-- back, which the write policy below permits.
create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := coalesce(new.created_by, auth.uid());
begin
  if v_user is null then
    return new;   -- service-role backfill with no actor; nothing to grant.
  end if;

  -- The FK to workspace_members means a non-member cannot be granted a
  -- project role, so check before inserting rather than letting it throw.
  if exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = new.workspace_id
      and wm.user_id = v_user
  ) then
    insert into public.project_members (project_id, user_id, workspace_id, role)
    values (new.id, v_user, new.workspace_id, 'manager')
    on conflict (project_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger trg_on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

-- =========================================================================
-- Role resolution. ONE function computes the effective role for every project
-- the caller can reach; the two set-returning helpers below are thin filters
-- over it, so the resolution rule exists in exactly one place.
--
-- Resolution is most-specific-first:
--   1. project_members.role, when a row exists and its role is non-null
--   2. otherwise the workspace baseline:
--        owner/admin -> manager, member -> contributor, viewer -> viewer
--
-- All three take NO row-dependent argument, so Postgres hoists them into an
-- InitPlan. Never rewrite these to take the row's own project_id as a
-- parameter — that turns an index probe on action_items into a per-row
-- function call.
-- =========================================================================
create or replace function public.current_project_roles()
returns table (project_id uuid, role public.project_role)
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select p.id,
         coalesce(
           pm.role,
           case wm.role
             when 'owner'  then 'manager'::public.project_role
             when 'admin'  then 'manager'::public.project_role
             when 'member' then 'contributor'::public.project_role
             else               'viewer'::public.project_role
           end
         )
  from public.projects p
  join public.client_spaces cs on cs.id = p.client_space_id
  join public.workspace_members wm
    on wm.workspace_id = cs.workspace_id
   and wm.user_id = auth.uid()
  left join public.project_members pm
    on pm.project_id = p.id
   and pm.user_id = auth.uid()
  where p.visibility = 'workspace' or pm.user_id is not null;
$$;

create or replace function public.current_project_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select r.project_id from public.current_project_roles() r;
$$;

-- Projects the caller may configure: edit settings, manage connector scopes,
-- manage project membership.
create or replace function public.manageable_project_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select r.project_id from public.current_project_roles() r where r.role = 'manager';
$$;

revoke execute on function public.current_project_roles() from public, anon;
revoke execute on function public.current_project_ids() from public, anon;
revoke execute on function public.manageable_project_ids() from public, anon;
grant execute on function public.current_project_roles() to authenticated;
grant execute on function public.current_project_ids() to authenticated;
grant execute on function public.manageable_project_ids() to authenticated;

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

create policy projects_select on public.projects for select to authenticated
  using (id in (select public.current_project_ids()));
-- Creating a project is a workspace-admin action: it consumes max_projects
-- and decides which client space's data gets a new view.
create policy projects_insert on public.projects for insert to authenticated
  with check (public.has_workspace_role(
    workspace_id, array['owner', 'admin']::public.workspace_role[]
  ));
create policy projects_update on public.projects for update to authenticated
  using (id in (select public.manageable_project_ids()))
  with check (id in (select public.manageable_project_ids()));
create policy projects_delete on public.projects for delete to authenticated
  using (public.has_workspace_role(
    workspace_id, array['owner', 'admin']::public.workspace_role[]
  ));

grant select, insert, delete on public.projects to authenticated;
revoke update on public.projects from authenticated;
grant update (name, description, status, health_score, visibility, context_docs, archived_at)
  on public.projects to authenticated;

-- project_members: visible to anyone who can see the project (rendering "who
-- is on this project" is an ordinary read); writable by the project's
-- managers and by workspace admins.
create policy project_members_select on public.project_members for select to authenticated
  using (project_id in (select public.current_project_ids()));
create policy project_members_write on public.project_members for all to authenticated
  using (
    project_id in (select public.manageable_project_ids())
    or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
  )
  with check (
    project_id in (select public.manageable_project_ids())
    or public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
  );

grant select, insert, update, delete on public.project_members to authenticated;
