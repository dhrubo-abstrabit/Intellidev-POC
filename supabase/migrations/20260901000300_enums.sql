-- =========================================================================
-- Every enum is declared up front, in full, with all its values.
--
-- No migration in this set may use `alter type ... add value`. Two reasons:
-- a value added inside a transaction cannot be used until that transaction
-- commits (so a migration adding and then using a value fails), and Postgres
-- has no `alter type ... drop value` at all — every value declared here is
-- permanent for the life of the type. Declaring the full set here keeps every
-- migration file transactional and therefore individually re-runnable.
-- =========================================================================

-- =========================================================================
-- Access. FOUR membership levels, each answering a different question:
--
--   tenant_role     - who belongs to the company, and who pays. The seat
--                     roster. `member` is the ordinary-person row the
--                     previous schema had no way to represent.
--   workspace_role  - workspace AUTHORITY: create/manage client spaces,
--                     projects and invitations beneath it. Deliberately does
--                     NOT grant data access; see space_role.
--   space_role      - THE data access boundary. A client engagement.
--   project_role    - narrowing within a space, for restricted projects.
--
-- There is no project `admin`: a project has nothing to administer (no
-- membership of its own, no connector grants, no billing). Administration is
-- a workspace concern.
-- =========================================================================
create type public.tenant_role    as enum ('owner', 'billing_admin', 'member');
create type public.workspace_role as enum ('admin', 'member', 'viewer');
create type public.space_role     as enum ('admin', 'member', 'viewer');
create type public.project_role   as enum ('member', 'viewer');

-- 'space' (default): every space member can see the project, and
-- project_members rows only record per-project ROLE overrides.
-- 'restricted': only users with a project_members row can see it at all.
-- This flag is what lets workspace/space-level membership coexist with a
-- genuine "this project only" grant.
create type public.project_visibility as enum ('space', 'restricted');

-- =========================================================================
-- Connectors.
--
-- gmail / google_drive / google_chat / clickup are declared here despite
-- never being produced by the current registry. Dropping an enum value is
-- impossible in Postgres once any row references it, and five columns use
-- this type. Carrying four dead labels costs nothing at runtime; removing
-- them would cost a full rewrite of raw_events and normalized_events under an
-- ACCESS EXCLUSIVE lock. They stay.
-- =========================================================================
create type public.connector_provider as enum (
  'slack', 'google', 'supabase', 'openai_codex', 'github', 'mock',
  'gmail', 'google_drive', 'google_chat', 'clickup'
);

-- nango  = OAuth, token custody entirely on the Nango side.
-- api_key = a locally-sealed secret (Supabase, OpenAI Codex).
create type public.connector_auth_mode as enum ('nango', 'api_key');

create type public.integration_status as enum (
  'pending', 'connected', 'degraded', 'error', 'revoked', 'disconnected'
);

-- =========================================================================
-- Sync
-- =========================================================================
create type public.sync_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.sync_trigger    as enum ('schedule', 'manual', 'webhook', 'backfill');

-- =========================================================================
-- Search
-- =========================================================================
create type public.chunk_source as enum ('normalized_event', 'event_attachment', 'context_document');
create type public.embed_status as enum ('pending', 'embedded', 'failed', 'skipped');

-- =========================================================================
-- Tasks
-- =========================================================================
create type public.task_kind     as enum ('action', 'risk', 'blocker', 'update', 'follow_up');
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.task_status   as enum ('pending', 'in_progress', 'done', 'dismissed', 'snoozed');

-- =========================================================================
-- LLM. `embed` is present from the start because the search_chunks embed job
-- records its runs here too, not just extraction and summarisation.
-- =========================================================================
create type public.llm_run_kind   as enum ('extract', 'reconcile', 'daily_summary', 'embed', 'backfill');
create type public.llm_run_status as enum ('queued', 'running', 'succeeded', 'failed');
