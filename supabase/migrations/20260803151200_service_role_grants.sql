-- =========================================================================
-- service_role needs the SAME explicit grants as any other role on this
-- Supabase CLI version: `bypassrls` skips row-level security, but it does
-- NOT bypass ordinary GRANT/REVOKE checks, and `auto_expose_new_tables`
-- does not auto-grant to service_role any more than it does to
-- anon/authenticated (see 20260803151100_grants_hardening.sql's note on
-- this). Every service-role-only table (connector_credentials, raw_events,
-- llm_runs, integration_cursors) and every table the service client writes
-- to alongside RLS-scoped writes (integrations, audit_logs, workspaces,
-- projects, ...) was missing this — service-role inserts were failing with
-- "permission denied for table X" and, wherever the caller didn't check the
-- returned `error` (e.g. the audit_logs inserts in onboarding/project
-- actions), failing completely silently.
--
-- service_role is our own trusted backend role, not a client-facing one, so
-- there is no reason to enumerate a narrower grant per table the way
-- authenticated gets column-scoped grants above — full CRUD on everything,
-- present and future, is the correct and simplest policy.
-- =========================================================================
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant all privileges on functions to service_role;
