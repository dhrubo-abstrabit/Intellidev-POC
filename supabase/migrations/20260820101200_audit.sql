-- Append-only. bigint identity PK (not uuid: audit rows are ordered, never
-- looked up by external reference), no updated_at, and NO foreign keys on the
-- scope columns — an audit row must survive deletion of the tenant, workspace,
-- client space or project it describes. The forbid_mutation triggers make
-- append-only structural rather than a convention someone can forget.
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  tenant_id       uuid,   -- nullable: pre-tenant auth events (signup, login)
  workspace_id    uuid,
  client_space_id uuid,
  project_id      uuid,
  actor_user_id   uuid references public.users (id) on delete set null,
  actor_type      text not null default 'user' check (actor_type in ('user', 'system', 'connector')),
  action          text not null,   -- e.g. 'integration.connected', 'client_space.created'
  target_type     text,
  target_id       text,
  metadata        jsonb not null default '{}'::jsonb,
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create index audit_logs_workspace_recent_idx
  on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_tenant_recent_idx
  on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_client_space_recent_idx
  on public.audit_logs (client_space_id, created_at desc)
  where client_space_id is not null;

create trigger trg_audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.forbid_mutation('audit_logs');
create trigger trg_audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.forbid_mutation('audit_logs');

alter table public.audit_logs enable row level security;

-- Workspace admins can read their workspace's trail; tenant super_admins can
-- read the whole tenant's, including rows with no workspace (billing changes,
-- workspace creation/deletion). Nobody writes through PostgREST — audit rows
-- are inserted only by the service-role client from server code, right next
-- to the mutation being audited.
create policy audit_logs_select_ws_admin on public.audit_logs for select to authenticated
  using (
    workspace_id is not null
    and public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
  );
create policy audit_logs_select_tenant_admin on public.audit_logs for select to authenticated
  using (
    tenant_id is not null
    and public.has_tenant_role(tenant_id, array['super_admin']::public.tenant_admin_role[])
  );

grant select on public.audit_logs to authenticated;
revoke insert, update, delete on public.audit_logs from authenticated, anon;
