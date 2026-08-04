create table public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 160),
  slug         text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  description  text,
  status       public.project_status not null default 'active',
  health_score smallint check (health_score between 0 and 100),
  -- Drives "today" for daily summaries / action items. Must NOT default to the
  -- server's TZ — the user's project timezone is what "today" means to them.
  timezone     text not null default 'UTC',
  archived_at  timestamptz,
  created_by   uuid references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, slug),
  -- Composite FK target: children FK on (project_id, workspace_id), which makes
  -- a cross-tenant row (project from workspace A referenced by a row tagged
  -- workspace B) physically impossible rather than merely policy-forbidden.
  constraint projects_id_workspace_id_key unique (id, workspace_id)
);

create index projects_workspace_status_idx on public.projects (workspace_id, status);

create trigger trg_projects_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

alter table public.projects enable row level security;

create policy projects_select on public.projects for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy projects_insert on public.projects for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy projects_update on public.projects for update to authenticated
  using (workspace_id in (select public.current_workspace_ids()))
  with check (workspace_id in (select public.current_workspace_ids()));
create policy projects_delete on public.projects for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

grant select, insert, update, delete on public.projects to authenticated;
