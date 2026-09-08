-- =========================================================================
-- RBAC, part 6 of 6 (a): policy rewrite — connectors.
--
-- The split here is the one that matters and it is now explicit in the
-- vocabulary rather than implied by which helper each policy happened to
-- call:
--
--   connection.*  is about the OAuth GRANT, which belongs to the client
--                 space. Connecting or revoking a provider account affects
--                 every project fed by it, so it is space-admin authority.
--
--   project.*     is about SCOPING that grant — which channels, folders or
--                 repos feed one project. That is ordinary project
--                 configuration and stays with whoever manages the project.
--
-- No UPDATE policy is added for space_connections. There is a
-- `grant update (external_account_label)` on the table but no UPDATE policy,
-- so relabelling a connection is currently blocked by RLS regardless of role.
-- That is pre-existing and left alone here on purpose — enabling a path that
-- has never worked is a behaviour change, not a translation, and it belongs
-- in its own commit.
-- =========================================================================

drop policy space_connections_select on public.space_connections;
create policy space_connections_select on public.space_connections for select to authenticated
  using (client_space_id in (select public.space_ids_with('connection.read')));

drop policy space_connections_delete on public.space_connections;
create policy space_connections_delete on public.space_connections for delete to authenticated
  using (public.can('space', client_space_id, 'connection.manage'));

drop policy project_connectors_select on public.project_connectors;
create policy project_connectors_select on public.project_connectors for select to authenticated
  using (project_id in (select public.project_ids_with('project.read')));

drop policy project_connectors_write on public.project_connectors;
create policy project_connectors_write on public.project_connectors for all to authenticated
  using (public.can('project', project_id, 'project.manage'))
  with check (public.can('project', project_id, 'project.manage'));

-- project_connector_cursors keeps its default-deny posture: RLS on, zero
-- policies, no grants. Untouched.
