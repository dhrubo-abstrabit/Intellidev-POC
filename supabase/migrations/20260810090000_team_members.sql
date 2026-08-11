-- Workspace-level roster/directory of people relevant to the workspace's
-- projects (client contacts, stakeholders, vendors, ...). Deliberately NOT
-- the same concept as workspace_members: a team_members row requires no
-- Supabase Auth account and confers no access to this app — it's just a
-- name/email/role/description someone typed in. created_by records who
-- entered the row (a real logged-in user), not who the row describes.
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
  unique (workspace_id, email)
);

create index team_members_workspace_id_name_idx on public.team_members (workspace_id, name);

create trigger trg_team_members_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

alter table public.team_members enable row level security;

-- Any workspace member can view the roster; only owner/admin can write.
-- Reuses the existing SECURITY DEFINER helpers from tenancy.sql verbatim —
-- no new recursive policy logic needed.
create policy team_members_select on public.team_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy team_members_write_admin on public.team_members for all to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));

grant select, insert, update, delete on public.team_members to authenticated;
