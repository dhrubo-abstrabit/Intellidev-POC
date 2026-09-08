-- =========================================================================
-- RBAC, part 5 of 6: policy rewrite — client_spaces, space_members,
-- team_members, projects, project_members.
--
-- Two arms are carried forward deliberately and must not be dropped:
--
--   * `created_by = auth.uid()` on client_spaces_select
--     (20260901002000_client_space_creator_returning_fix.sql) and on
--     projects_select (20260901000600_projects.sql). Both exist because
--     INSERT ... RETURNING runs its implicit SELECT-policy check against the
--     new row before the AFTER INSERT trigger that would grant access has
--     fired. A direct column comparison needs no self-join and is evaluated
--     against the row Postgres already has in hand. Without them, creating a
--     client space or a restricted project fails with a misleading "new row
--     violates row-level security policy" that is really a RETURNING
--     visibility failure.
--
--   * The self-row policies on space_members and project_members, which stay
--     as the recursion-safe base case.
--
-- sm_select_comembers and sm_select_managers collapse into ONE policy here.
-- They were two policies expressing "members can see the roster" and
-- "managers can see the roster"; both are now the single question "who holds
-- member.read on this space", which the grid answers. Permissive policies OR
-- together, so one policy over the union is exactly equivalent.
-- =========================================================================

-- =========================================================================
-- client_spaces.
-- =========================================================================
drop policy client_spaces_select on public.client_spaces;
create policy client_spaces_select on public.client_spaces for select to authenticated
  using (
    id in (select public.space_ids_with('space.read'))
    or created_by = (select auth.uid())
  );

drop policy client_spaces_insert on public.client_spaces;
create policy client_spaces_insert on public.client_spaces for insert to authenticated
  with check (public.can('workspace', workspace_id, 'space.create'));

drop policy client_spaces_update on public.client_spaces;
create policy client_spaces_update on public.client_spaces for update to authenticated
  using (public.can('space', id, 'space.manage'))
  with check (public.can('space', id, 'space.manage'));

-- Deleting a client space destroys every connection, event and task beneath
-- it. space.delete is seeded to workspace admins and tenant owners only —
-- NOT to the space's own admin — which is the has_workspace_role('admin')
-- check this replaces.
drop policy client_spaces_delete on public.client_spaces;
create policy client_spaces_delete on public.client_spaces for delete to authenticated
  using (public.can('space', id, 'space.delete'));

-- =========================================================================
-- space_members.
-- =========================================================================
drop policy sm_select_comembers on public.space_members;
drop policy sm_select_managers  on public.space_members;
create policy sm_select on public.space_members for select to authenticated
  using (client_space_id in (select public.space_ids_with('member.read')));

drop policy sm_write_admin on public.space_members;
create policy sm_write on public.space_members for all to authenticated
  using (public.can('space', client_space_id, 'member.manage'))
  with check (public.can('space', client_space_id, 'member.manage'));

-- =========================================================================
-- team_members. Workspace-scoped contact roster — confers no access to this
-- app, so it keys on workspace membership rather than the data boundary,
-- exactly as before.
-- =========================================================================
drop policy team_members_select on public.team_members;
create policy team_members_select on public.team_members for select to authenticated
  using (workspace_id in (select public.workspace_ids_with('contact.read')));

drop policy team_members_write_admin on public.team_members;
create policy team_members_write on public.team_members for all to authenticated
  using (public.can('workspace', workspace_id, 'contact.manage'))
  with check (public.can('workspace', workspace_id, 'contact.manage'));

-- =========================================================================
-- projects.
--
-- projects_update moves from manageable_project_ids() to
-- can('project', id, 'project.manage'). The narrowing this implies for
-- RESTRICTED projects is deliberate and documented in
-- 20260901002300_rbac_resolvers.sql (arm D): the old helper let a space admin
-- update a restricted project they could not select, which is the
-- write-without-read shape this whole change exists to eliminate.
-- =========================================================================
drop policy projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (
    id in (select public.project_ids_with('project.read'))
    or created_by = (select auth.uid())
  );

drop policy projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check (public.can('space', client_space_id, 'project.create'));

drop policy projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (public.can('project', id, 'project.manage'))
  with check (public.can('project', id, 'project.manage'));

drop policy projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using (public.can('space', client_space_id, 'project.delete'));

-- =========================================================================
-- project_members.
-- =========================================================================
drop policy pm_select_peers on public.project_members;
create policy pm_select_peers on public.project_members for select to authenticated
  using (project_id in (select public.project_ids_with('member.read')));

drop policy pm_write_manager on public.project_members;
create policy pm_write on public.project_members for all to authenticated
  using (public.can('project', project_id, 'member.manage'))
  with check (public.can('project', project_id, 'member.manage'));
