-- =========================================================================
-- invitations: the first real invite mechanism in this schema.
--
-- The previous schema had none at all — adding a member meant directly
-- inserting a membership row for someone who had ALREADY signed up
-- independently. There was no token, no email, no expiry, no pending state.
--
-- SCOPE is expressed by which ids are set, as a contiguous chain:
--   tenant only                              -> a billing/roster invite
--   + workspace_id                           -> workspace authority
--   + client_space_id                        -> data access to one engagement
--   + project_id                             -> narrowed to one project
--
-- ROLE is expressed by the matching role column. More than one may be set:
-- a project-scoped invite legitimately needs a space_role (to get in the
-- door) AND a project_role. This is why the shape is four nullable role
-- columns with CHECK constraints rather than the "exactly one of" rule the
-- original design called for — with membership at multiple levels,
-- "exactly one" is wrong.
-- =========================================================================
create table public.invitations (
  id              uuid primary key default gen_random_uuid(),

  -- Always set: the billing boundary owns the invite regardless of depth.
  tenant_id       uuid not null,
  workspace_id    uuid,
  client_space_id uuid,
  project_id      uuid,

  email           extensions.citext not null
                    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  tenant_role     public.tenant_role,
  workspace_role  public.workspace_role,
  space_role      public.space_role,
  project_role    public.project_role,

  -- sha256 of the token. The plaintext token is emailed and never stored, so
  -- a database leak does not yield usable invitations.
  token_hash      bytea not null unique,

  invited_by      uuid references public.users (id) on delete set null,
  -- Who actually accepted. Distinct from `email`: someone may sign in with a
  -- Google account whose address differs from the one invited.
  accepted_by     uuid references public.users (id) on delete set null,

  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (workspace_id, tenant_id)
    references public.workspaces (id, tenant_id) on delete cascade,
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  -- This is why projects keeps workspace_id: it lets a workspace-scoped
  -- invite naming a project prove, structurally, that the project is inside
  -- that workspace. Without the column it would take a trigger.
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,

  -- The id chain must be contiguous — a scope cannot skip a level.
  constraint invitations_scope_chain_chk check (
    (project_id is null or client_space_id is not null)
    and (client_space_id is null or workspace_id is not null)
  ),
  -- No role deeper than its id.
  constraint invitations_role_depth_chk check (
    (workspace_role is null or workspace_id is not null)
    and (space_role   is null or client_space_id is not null)
    and (project_role is null or project_id is not null)
  ),
  -- An invite that grants nothing is a bug, not a valid row.
  constraint invitations_grants_something_chk check (
    tenant_role is not null or workspace_role is not null
    or space_role is not null or project_role is not null
  ),
  constraint invitations_expires_after_creation_chk check (expires_at > created_at)
);

-- One pending invite per (tenant, email, exact scope). `nulls not distinct`
-- is load-bearing: without it Postgres treats every NULL as unique, so two
-- pending tenant-level invites to the same address would not collide.
-- Distinct SCOPES still coexist — you can invite someone to the workspace and
-- to a specific project at the same time.
create unique index invitations_pending_uniq
  on public.invitations (tenant_id, email, workspace_id, client_space_id, project_id)
  nulls not distinct
  where accepted_at is null and revoked_at is null;

create index invitations_email_idx on public.invitations (email)
  where accepted_at is null and revoked_at is null;
-- The expiry reaper's queue.
create index invitations_expiry_idx on public.invitations (expires_at)
  where accepted_at is null and revoked_at is null;
create index invitations_tenant_idx on public.invitations (tenant_id, created_at desc);

create trigger trg_invitations_updated_at
  before update on public.invitations
  for each row execute function public.set_updated_at();

-- =========================================================================
-- accept_invitation: ONE function that provisions the entire chain.
--
-- Deliberately not four separate inserts from the app layer. The composite
-- FKs require strict ordering (tenant_members before workspace_members and
-- space_members; space_members before project_members), and doing that
-- client-side means four round trips that can half-fail. Here it is one
-- atomic statement that either grants the whole scope or none of it.
--
-- SECURITY DEFINER because the caller, by definition, has no membership yet —
-- every RLS write policy in this schema would reject them.
--
-- Takes the PLAINTEXT token and hashes it internally, so the caller never
-- needs to know the storage format and the hash never travels in a query the
-- app layer constructs.
--
-- DELIBERATE: the accepting user's email is NOT required to match
-- invitations.email. The token is the authorization — possession of the link
-- is what grants the scope, and `accepted_by` records who actually used it.
--
-- The alternative (hard email equality) was rejected because it breaks a
-- routine case: someone invited at work@company.com signs in with Google and
-- the provider returns a different primary address, leaving them permanently
-- unable to accept a valid invite. The cost of this choice is that a
-- forwarded invite link works for whoever opens it, so tokens must be treated
-- as secrets: single-use (enforced by accepted_at), expiring (enforced by
-- expires_at), and never logged. `email` is therefore an addressing and audit
-- field, not an access control.
-- =========================================================================
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_inv  public.invitations;
begin
  if v_user is null then
    raise exception 'must be signed in to accept an invitation';
  end if;

  select * into v_inv
  from public.invitations
  where token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if v_inv.id is null then
    raise exception 'invitation not found';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'invitation has been revoked';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation has already been accepted';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation has expired';
  end if;

  -- Level 1 — always. Every deeper membership FKs to this row, so it must
  -- exist first. An existing row is upgraded only if the invite names a
  -- tenant_role, never downgraded.
  insert into public.tenant_members (tenant_id, user_id, role, invited_by)
  values (v_inv.tenant_id, v_user, coalesce(v_inv.tenant_role, 'member'), v_inv.invited_by)
  on conflict (tenant_id, user_id) do update
    set role = case when v_inv.tenant_role is not null then v_inv.tenant_role
                    else public.tenant_members.role end;

  -- Level 2
  if v_inv.workspace_id is not null and v_inv.workspace_role is not null then
    insert into public.workspace_members (workspace_id, tenant_id, user_id, role, invited_by)
    values (v_inv.workspace_id, v_inv.tenant_id, v_user, v_inv.workspace_role, v_inv.invited_by)
    on conflict (workspace_id, user_id) do update set role = v_inv.workspace_role;
  end if;

  -- Level 3
  if v_inv.client_space_id is not null and v_inv.space_role is not null then
    insert into public.space_members (client_space_id, tenant_id, user_id, role, invited_by)
    values (v_inv.client_space_id, v_inv.tenant_id, v_user, v_inv.space_role, v_inv.invited_by)
    on conflict (client_space_id, user_id) do update set role = v_inv.space_role;
  end if;

  -- Level 4. Requires space standing, which project_members' FK enforces —
  -- so a project-scoped invite MUST also carry a space_role, or this throws.
  -- That is intentional: it surfaces a malformed invite loudly at accept time
  -- rather than granting a partial scope silently.
  if v_inv.project_id is not null then
    insert into public.project_members (project_id, client_space_id, user_id, role, added_by)
    values (v_inv.project_id, v_inv.client_space_id, v_user, v_inv.project_role, v_inv.invited_by)
    on conflict (project_id, user_id) do update set role = v_inv.project_role;
  end if;

  update public.invitations
  set accepted_at = now(), accepted_by = v_user
  where id = v_inv.id;

  return v_inv.id;
end;
$$;

revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- =========================================================================
-- RLS
--
-- Note what is NOT granted: `select` never exposes token_hash to a client
-- (see the column grant below), and there is no policy letting an invitee
-- read their own pending invite by email — acceptance goes exclusively
-- through accept_invitation(), which needs the token. Listing invites is an
-- administrator's view of what they have sent, not a recipient's inbox.
-- =========================================================================
alter table public.invitations enable row level security;

create policy invitations_select_admin on public.invitations for select to authenticated
  using (
    public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[])
    or (workspace_id is not null
        and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
    or (client_space_id is not null
        and client_space_id in (select public.manageable_client_space_ids()))
  );
create policy invitations_write_admin on public.invitations for all to authenticated
  using (
    public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[])
    or (workspace_id is not null
        and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
    or (client_space_id is not null
        and client_space_id in (select public.manageable_client_space_ids()))
  )
  with check (
    public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[])
    or (workspace_id is not null
        and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
    or (client_space_id is not null
        and client_space_id in (select public.manageable_client_space_ids()))
  );

-- Column-scoped SELECT: token_hash is deliberately excluded. RLS cannot
-- restrict which columns a SELECT returns, so this grant is the only thing
-- keeping the hash out of a PostgREST response.
grant select (id, tenant_id, workspace_id, client_space_id, project_id, email,
              tenant_role, workspace_role, space_role, project_role,
              invited_by, accepted_by, expires_at, accepted_at, revoked_at,
              created_at, updated_at)
  on public.invitations to authenticated;
grant insert, delete on public.invitations to authenticated;
revoke update on public.invitations from authenticated;
-- Revocation is the only client-writable transition. accepted_at/accepted_by
-- are set exclusively by accept_invitation().
grant update (revoked_at) on public.invitations to authenticated;
