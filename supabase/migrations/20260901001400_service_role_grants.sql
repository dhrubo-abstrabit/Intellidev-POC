-- =========================================================================
-- service_role grants.
--
-- POSITION IS LOAD-BEARING: this file must run AFTER every `create table` in
-- the set. `alter default privileges` only affects objects created after it
-- executes, so moving this earlier silently leaves later tables without
-- service-role access — and that failure mode is "permission denied for table
-- X" from a background job, wherever the caller does not check `error`.
--
-- The explicit `grant all on all tables` covers everything created above; the
-- `alter default privileges` covers anything created by a FUTURE migration,
-- so a new table does not need to remember to come back here.
--
-- This grant does not widen client access: `service_role` is reachable only
-- with the secret service key, never from the browser.
-- =========================================================================
grant usage on schema public to service_role;

grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public grant all privileges on tables    to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant all privileges on functions to service_role;

-- =========================================================================
-- Belt-and-braces re-assertion of the service-role-only tables.
--
-- Every table below has RLS enabled with either zero policies or SELECT-only
-- policies, but removing the GRANT is the more important lock of the two: a
-- missing grant fails loudly (401/403) instead of silently returning `[]`,
-- and it survives someone adding a permissive "just for debugging" policy
-- later. Re-asserted here so the whole list is visible in one place rather
-- than spread across six migration files.
-- =========================================================================
revoke all on public.raw_events                from anon, authenticated;
revoke all on public.project_connector_cursors from anon, authenticated;
revoke all on public.llm_runs                  from anon, authenticated;

-- These keep their SELECT policy and grant, so re-assert only the writes.
revoke insert, update, delete on public.normalized_events  from anon, authenticated;
revoke insert, update, delete on public.event_attachments  from anon, authenticated;
revoke insert, update, delete on public.search_chunks      from anon, authenticated;
revoke insert, update, delete on public.task_sources       from anon, authenticated;
revoke insert, update, delete on public.daily_summaries    from anon, authenticated;
revoke insert, update, delete on public.sync_jobs          from anon, authenticated;
revoke insert, update, delete on public.sync_batches       from anon, authenticated;
revoke insert, update, delete on public.sync_batch_members from anon, authenticated;
revoke insert, update, delete on public.audit_logs         from anon, authenticated;
revoke insert, update, delete on public.tenant_subscriptions from anon, authenticated;

-- anon gets nothing anywhere. Every route in this app requires a session;
-- there is no public read surface, so this is a blanket denial rather than a
-- per-table decision.
revoke all on all tables in schema public from anon;
