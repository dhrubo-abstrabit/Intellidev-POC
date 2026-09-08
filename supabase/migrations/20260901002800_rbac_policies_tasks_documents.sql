-- =========================================================================
-- RBAC, part 6 of 6 (c): policy rewrite — tasks, task sources, daily
-- summaries, context documents, invitations and the audit log.
--
-- tasks_update is the headline. Before this file it was byte-for-byte
-- identical to tasks_select — both keyed on current_client_space_ids(), which
-- returns every space the caller holds ANY membership row for, role ignored.
-- That is why a space `viewer` could reassign, reprioritise and dismiss every
-- task in the space. It now asks for task.update, which is a different
-- question from task.read.
--
-- Note that this file does NOT yet take task.update away from viewers — the
-- seed still grants it, deliberately, so this migration stays a pure
-- translation. 20260901003000_rbac_tighten_seed.sql is the one that changes
-- who can do what, in a diff where that is the only thing happening.
--
-- The cross-project task rule is preserved verbatim: a task whose sources
-- span projects has project_id null and is visible to space members only.
-- `NULL in (...)` is never true, so the safe case remains the default.
-- =========================================================================

-- =========================================================================
-- tasks.
-- =========================================================================
drop policy tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated
  using (
    client_space_id in (select public.space_ids_with('task.read'))
    and (project_id is null or project_id in (select public.project_ids_with('task.read')))
  );

drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated
  using (
    client_space_id in (select public.space_ids_with('task.update'))
    and (project_id is null or project_id in (select public.project_ids_with('task.update')))
  )
  with check (
    client_space_id in (select public.space_ids_with('task.update'))
    and (project_id is null or project_id in (select public.project_ids_with('task.update')))
  );

-- task_sources is the provenance chain — same visibility as the task itself.
drop policy task_sources_select on public.task_sources;
create policy task_sources_select on public.task_sources for select to authenticated
  using (client_space_id in (select public.space_ids_with('task.read')));

-- =========================================================================
-- daily_summaries: the nightly briefing, scoped to the client space.
-- =========================================================================
drop policy daily_summaries_select on public.daily_summaries;
create policy daily_summaries_select on public.daily_summaries for select to authenticated
  using (client_space_id in (select public.space_ids_with('data.read')));

-- =========================================================================
-- context_documents.
--
-- The write policy changes shape as well as vocabulary. It used to be
-- `manageable_client_space_ids() OR manageable_project_ids()` — an OR that
-- let space-level authority write a project-tagged document, and let a
-- project manager write a space-level one. It is now the same two-armed
-- predicate the read policy uses, so a document can only be written into a
-- scope the writer can also read. That is the write-implies-read rule applied
-- at the policy layer, matching what guard_write_implies_read() enforces in
-- the grid.
-- =========================================================================
drop policy context_documents_select on public.context_documents;
create policy context_documents_select on public.context_documents for select to authenticated
  using (
    client_space_id in (select public.space_ids_with('document.read'))
    and (project_id is null or project_id in (select public.project_ids_with('document.read')))
  );

drop policy context_documents_write on public.context_documents;
create policy context_documents_write on public.context_documents for all to authenticated
  using (
    client_space_id in (select public.space_ids_with('document.write'))
    and (project_id is null or project_id in (select public.project_ids_with('document.write')))
  )
  with check (
    client_space_id in (select public.space_ids_with('document.write'))
    and (project_id is null or project_id in (select public.project_ids_with('document.write')))
  );

-- =========================================================================
-- invitations. The three-armed admin predicate collapses to one question.
--
-- Listing invitations is an administrator's view of what they have sent, not
-- a recipient's inbox — there is still no policy letting an invitee read
-- their own pending invite by email, and acceptance still goes exclusively
-- through accept_invitation(), which needs the token. The column-scoped
-- SELECT grant that keeps token_hash out of every PostgREST response is
-- untouched.
-- =========================================================================
drop policy invitations_select_admin on public.invitations;
create policy invitations_select on public.invitations for select to authenticated
  using (
    public.can('tenant', tenant_id, 'member.invite')
    or (workspace_id    is not null and public.can('workspace', workspace_id,    'member.invite'))
    or (client_space_id is not null and public.can('space',     client_space_id, 'member.invite'))
    or (project_id      is not null and public.can('project',   project_id,      'member.invite'))
  );

drop policy invitations_write_admin on public.invitations;
create policy invitations_write on public.invitations for all to authenticated
  using (
    public.can('tenant', tenant_id, 'member.invite')
    or (workspace_id    is not null and public.can('workspace', workspace_id,    'member.invite'))
    or (client_space_id is not null and public.can('space',     client_space_id, 'member.invite'))
    or (project_id      is not null and public.can('project',   project_id,      'member.invite'))
  )
  with check (
    public.can('tenant', tenant_id, 'member.invite')
    or (workspace_id    is not null and public.can('workspace', workspace_id,    'member.invite'))
    or (client_space_id is not null and public.can('space',     client_space_id, 'member.invite'))
    or (project_id      is not null and public.can('project',   project_id,      'member.invite'))
  );

-- =========================================================================
-- audit_logs. Still append-only and still service-role-write-only: an audit
-- trail a client can write is not an audit trail.
-- =========================================================================
drop policy audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    public.can('tenant', tenant_id, 'audit.read')
    or (workspace_id is not null and public.can('workspace', workspace_id, 'audit.read'))
  );
