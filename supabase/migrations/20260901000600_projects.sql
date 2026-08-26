-- =========================================================================
-- LEVEL 4 — projects: a scoped view over a client space.
--
-- A project does NOT own the OAuth grant (that is the client space's, via
-- space_connections) but it DOES own what gets fetched into it: which
-- connectors feed it, and — unlike the previous schema — the events
-- themselves, which now carry project_id.
--
-- `workspace_id` is carried alongside client_space_id purely so invitations
-- can prove, with a composite FK rather than a trigger, that a
-- workspace-scoped invite naming a project names one inside that workspace.
-- It is NOT part of any RLS predicate — access flows through the client space.
-- =========================================================================
create table public.projects (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  name            text not null check (length(btrim(name)) between 1 and 160),
  slug            text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description     text,
  status          text not null default 'active'
                    check (status in ('active', 'paused', 'archived')),

  -- 'space' (default): every space member can see this project, and
  -- project_members rows only record per-project ROLE overrides.
  -- 'restricted': only users with a project_members row can see it at all.
  --
  -- This flag is what lets space-level membership and a genuine "this project
  -- only" grant coexist. Without it, "no sibling visibility" is meaningless
  -- because the sibling was already visible.
  visibility      public.project_visibility not null default 'space',

  archived_at     timestamptz,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (client_space_id, slug),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  -- Two composite FK targets: everything beneath the project uses the first,
  -- invitations uses the second.
  constraint projects_id_client_space_id_key unique (id, client_space_id),
  constraint projects_id_workspace_id_key    unique (id, workspace_id)
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
-- project_members: the narrowing table.
--
-- Two jobs, depending on the project's `visibility`:
--   * 'space'      — an ELEVATION table. Everyone in the client space
--                    already sees the project; a row here only says "this
--                    person's role on THIS project differs from their space
--                    baseline".
--   * 'restricted' — an ACCESS LIST. Only users with a row can see it.
--
-- `role` is nullable on purpose. NULL means "no override, inherit the space
-- baseline" — which is what lets a restricted project grant plain access
-- without also having to restate a role.
--
-- The FK to space_members is load-bearing and a deliberate, documented
-- limitation: a project member ALWAYS has standing in the client space. That
-- means a true single-project external guest is not expressible — such a
-- person would still see the space's untagged tasks and space-level context
-- documents. Accepted: it buys a clean cascade (removing someone from the
-- space removes every project role) and it keeps "who can see this data"
-- answerable at one level instead of two.
--
-- Sizing, for the case that motivates the elevation model: a space with 5 PMs
-- and 30 devs running 5 projects is 35 space_members rows plus 5 rows here
-- (one per PM on their own project) — not 175.
-- =========================================================================
create table public.project_members (
  project_id      uuid not null,
  client_space_id uuid not null,
  user_id         uuid not null,
  role            public.project_role,   -- null = inherit the space baseline
  added_by        uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  foreign key (client_space_id, user_id)
    references public.space_members (client_space_id, user_id) on delete cascade
);

create index project_members_user_idx on public.project_members (user_id, project_id);

create trigger trg_project_members_updated_at
  before update on public.project_members
  for each row execute function public.set_updated_at();

-- =========================================================================
-- Bootstrap: the creator becomes a member of their own project, atomically.
--
-- Load-bearing for visibility='restricted', not a nicety. Without it,
-- creating a restricted project locks the creator straight out of it: the
-- project matches no arm of current_project_ids(), so it is invisible to
-- everyone — including the space admin who just created it — and never
-- appears in any listing again.
--
-- The FK to space_members means a non-member cannot be granted a project
-- role, so check before inserting rather than letting it throw.
-- =========================================================================
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

  if exists (
    select 1 from public.space_members sm
    where sm.client_space_id = new.client_space_id and sm.user_id = v_user
  ) then
    insert into public.project_members (project_id, client_space_id, user_id, role, added_by)
    values (new.id, new.client_space_id, v_user, 'member', v_user)
    on conflict (project_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger trg_on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

-- =========================================================================
-- Level-4 RLS keys.
--
--   current_project_ids()    - every project the caller can SEE: all
--                              non-restricted projects in their spaces, plus
--                              any restricted project they hold a row for.
--   manageable_project_ids() - projects the caller may CONFIGURE: space
--                              admins (and, through
--                              manageable_client_space_ids, workspace admins
--                              and tenant owners), plus project 'member'
--                              overrides.
--
-- Both set-returning with no row-dependent argument, so Postgres hoists them
-- into an InitPlan — see the note in 20260901000400_tenancy.sql.
-- =========================================================================
create or replace function public.current_project_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.visibility = 'space'
    and p.client_space_id in (select public.current_client_space_ids())
  union
  select pm.project_id
  from public.project_members pm
  where pm.user_id = auth.uid();
$$;

create or replace function public.manageable_project_ids()
returns setof uuid
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select p.id
  from public.projects p
  where p.client_space_id in (select public.manageable_client_space_ids())
  union
  select pm.project_id
  from public.project_members pm
  where pm.user_id = auth.uid() and pm.role = 'member';
$$;

revoke execute on function public.current_project_ids() from public, anon;
revoke execute on function public.manageable_project_ids() from public, anon;
grant execute on function public.current_project_ids() to authenticated;
grant execute on function public.manageable_project_ids() to authenticated;

-- =========================================================================
-- RLS
-- =========================================================================
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

-- The `or created_by = auth.uid()` arm is not redundant with
-- current_project_ids(): it is what makes a just-created RESTRICTED project
-- visible to its creator. `INSERT ... RETURNING` requires the new row to pass
-- a SELECT policy to be returned, and that check does not observe the AFTER
-- INSERT trigger's effect within the same statement — without this arm every
-- restricted-project creation fails with a misleading "new row violates
-- row-level security policy" that is really a RETURNING-visibility failure.
create policy projects_select on public.projects for select to authenticated
  using (id in (select public.current_project_ids()) or created_by = (select auth.uid()));
create policy projects_insert on public.projects for insert to authenticated
  with check (client_space_id in (select public.manageable_client_space_ids()));
create policy projects_update on public.projects for update to authenticated
  using (id in (select public.manageable_project_ids()))
  with check (id in (select public.manageable_project_ids()));
create policy projects_delete on public.projects for delete to authenticated
  using (client_space_id in (select public.manageable_client_space_ids()));

grant select, insert, delete on public.projects to authenticated;
revoke update on public.projects from authenticated;
grant update (name, description, status, visibility, archived_at)
  on public.projects to authenticated;

create policy pm_select_self on public.project_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy pm_select_peers on public.project_members for select to authenticated
  using (project_id in (select public.current_project_ids()));
create policy pm_write_manager on public.project_members for all to authenticated
  using (project_id in (select public.manageable_project_ids()))
  with check (project_id in (select public.manageable_project_ids()));

grant select, insert, update, delete on public.project_members to authenticated;
