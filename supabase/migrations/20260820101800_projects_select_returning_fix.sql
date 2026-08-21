-- projects_select has the same RETURNING-visibility gap that
-- tenants_select/workspaces_select were already patched for in
-- 20260820100400_tenancy.sql, just missed on projects: `INSERT ... RETURNING`
-- requires the new row to pass a SELECT policy to be returned, and that
-- check does not observe handle_new_project()'s AFTER INSERT trigger effect
-- (the project_members row current_project_ids() depends on) within the
-- same statement. Confirmed in practice: every project creation through the
-- user-scoped client (`.insert(...).select("id").single()`, the idiomatic
-- pattern this app uses everywhere) failed with a misleading "new row
-- violates row-level security policy for table projects" that was really
-- this — plain `insert` with no RETURNING against the identical row
-- succeeds. The `or created_by = auth.uid()` arm is what makes a
-- just-created project visible to its creator, mirroring owner_id on
-- tenants/workspaces.
alter policy projects_select on public.projects
  using (
    id in (select public.current_project_ids())
    or created_by = (select auth.uid())
  );
