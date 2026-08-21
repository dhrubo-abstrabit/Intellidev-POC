-- Idempotent final pass. Every migration above that creates a service-role-
-- only table already REVOKEs at creation time; this file re-asserts all of
-- them together so a REVOKE can never be silently lost when a later migration
-- adds another service-only table. Safe to run repeatedly.
--
-- Note: this project's local config (`auto_expose_new_tables`, see
-- supabase/config.toml) already defaults new tables to NOT being auto-granted
-- to anon/authenticated. These REVOKEs are defense-in-depth on top of that
-- default, not a workaround for its absence — cheap insurance against a future
-- Supabase default change or a manually-run GRANT.
revoke all on public.connector_credentials from anon, authenticated;
revoke all on public.raw_events            from anon, authenticated;
revoke all on public.llm_runs              from anon, authenticated;
revoke all on public.integration_cursors   from anon, authenticated;

-- Column-scoped update grants, re-asserted (see each table's own migration for
-- why: RLS cannot restrict which columns an UPDATE touches).
revoke update on public.users from authenticated;
grant update (full_name, avatar_url) on public.users to authenticated;

revoke update on public.tenants from authenticated;
grant update (name, domain, settings) on public.tenants to authenticated;

revoke update on public.workspaces from authenticated;
grant update (name, description, logo_path) on public.workspaces to authenticated;

revoke update on public.client_spaces from authenticated;
grant update (name, description, logo_path, timezone, status, archived_at)
  on public.client_spaces to authenticated;

revoke update on public.projects from authenticated;
grant update (name, description, status, health_score, visibility, context_docs, archived_at)
  on public.projects to authenticated;

revoke update on public.integrations from authenticated;
grant update (sync_enabled, display_name, config, sync_interval_seconds)
  on public.integrations to authenticated;

revoke update on public.action_items from authenticated;
grant update (status, assignee_id, assignee_team_member_id, snoozed_until, resolved_at, priority)
  on public.action_items to authenticated;
