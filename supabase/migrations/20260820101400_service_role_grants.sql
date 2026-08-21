-- =========================================================================
-- service_role needs the SAME explicit grants as any other role on this
-- Supabase CLI version: `bypassrls` skips row-level security, but it does NOT
-- bypass ordinary GRANT/REVOKE checks, and `auto_expose_new_tables` does not
-- auto-grant to service_role any more than it does to anon/authenticated (see
-- the note in 20260820101300_grants_hardening.sql). Without this, service-role
-- inserts fail with "permission denied for table X" and, wherever the caller
-- doesn't check the returned `error` (e.g. audit_logs inserts alongside a
-- mutation), fail completely silently.
--
-- service_role is our own trusted backend role, not a client-facing one, so
-- there is no reason to enumerate a narrower grant per table the way
-- authenticated gets column-scoped grants — full CRUD on everything, present
-- and future, is the correct and simplest policy.
-- =========================================================================
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

alter default privileges in schema public grant all privileges on tables to service_role;
alter default privileges in schema public grant all privileges on sequences to service_role;
alter default privileges in schema public grant all privileges on functions to service_role;
