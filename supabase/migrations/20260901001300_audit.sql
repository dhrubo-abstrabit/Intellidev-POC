-- =========================================================================
-- audit_logs: append-only trail.
--
-- RESTORED, and more load-bearing than before: this schema adds invitations,
-- four membership levels and a space-level data boundary, so "who granted
-- whom access to what, and when" is now a question with real consequences.
-- The previous schema hard-deleted membership rows with no record at all.
--
-- Append-only is enforced by TRIGGERS, not by grants — triggers apply to the
-- service role too, which bypasses RLS but not triggers. That is the point: a
-- compromised service key cannot rewrite history.
-- =========================================================================
create table public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  workspace_id    uuid,
  client_space_id uuid,
  project_id      uuid,
  actor_user_id   uuid references public.users (id) on delete set null,
  actor_type      text not null default 'user'
                    check (actor_type in ('user', 'system', 'service')),
  -- e.g. member.added, member.removed, invitation.sent, invitation.accepted,
  -- connection.revoked, task.status_changed
  action          text not null check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  target_type     text,
  target_id       uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

-- No FK on workspace_id/client_space_id/project_id on purpose: an audit row
-- must outlive the thing it describes. "Workspace X was deleted" is precisely
-- the entry you cannot afford to have cascade away.
create index audit_logs_tenant_recent_idx on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_target_idx on public.audit_logs (target_type, target_id);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, created_at desc)
  where actor_user_id is not null;

create trigger trg_audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.forbid_mutation('audit_logs is append-only');

create trigger trg_audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.forbid_mutation('audit_logs is append-only');

alter table public.audit_logs enable row level security;

-- Readable by tenant owners and by workspace admins for their own workspace.
-- Not readable by ordinary members: an audit trail that everyone can read is
-- a directory of who works on what.
create policy audit_logs_select_admin on public.audit_logs for select to authenticated
  using (
    public.has_tenant_role(tenant_id, array['owner']::public.tenant_role[])
    or (workspace_id is not null
        and public.has_workspace_role(workspace_id, array['admin']::public.workspace_role[]))
  );

grant select on public.audit_logs to authenticated;
-- Writes are service-role only. A client-writable audit log is not an audit
-- log, and the append-only triggers above cannot tell a forged row from a
-- real one.
revoke insert, update, delete on public.audit_logs from authenticated, anon;
