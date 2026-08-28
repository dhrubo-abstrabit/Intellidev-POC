-- =========================================================================
-- client_spaces_select is missing the same "creator can see their own
-- just-inserted row" arm that projects_select already has (see
-- 20260901000600_projects.sql). Without it, `insert into client_spaces ...
-- returning id` — the first of the two inserts createProject() in
-- src/app/(app)/w/[workspaceId]/actions.ts makes — fails with "new row
-- violates row-level security policy for table client_spaces" for every
-- caller, including a workspace admin who unambiguously has the right to
-- create one.
--
-- This is a DIFFERENT variant of the tenants/RETURNING bug fixed in
-- 20260901001900_workspace_onboarding_rpc.sql, not the same one: there is no
-- AFTER INSERT trigger in the way here — handle_new_client_space is
-- irrelevant to this check. The actual cause: manageable_client_space_ids()
-- grants a workspace admin visibility into a client space by re-deriving the
-- id through its own nested `select cs.id from public.client_spaces cs
-- where cs.workspace_id in (...)`. That self-join back onto client_spaces —
-- the very table being inserted into — does not observe the row the
-- enclosing INSERT just produced, even though the underlying authorization
-- fact (workspace admin) was already durable before the statement began.
-- Confirmed empirically: calling manageable_client_space_ids() in a
-- follow-up statement in the same transaction correctly includes the new
-- row; evaluated as part of the same INSERT statement's RETURNING check, it
-- does not.
--
-- The fix mirrors projects_select exactly: a direct `created_by =
-- auth.uid()` column comparison needs no self-join, so it is evaluated
-- against the row Postgres already has in hand and works regardless of this
-- timing quirk. createProject() is updated in the same change to actually
-- pass created_by on the client_spaces insert (it already does for the
-- projects insert right after).
-- =========================================================================
drop policy client_spaces_select on public.client_spaces;
create policy client_spaces_select on public.client_spaces for select to authenticated
  using (
    id in (select public.current_client_space_ids())
    or id in (select public.manageable_client_space_ids())
    or created_by = (select auth.uid())
  );
