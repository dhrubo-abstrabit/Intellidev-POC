-- =========================================================================
-- Level 1 — tenant / billing
-- =========================================================================
create type public.tenant_status       as enum ('active', 'suspended', 'cancelled');
create type public.tenant_admin_role   as enum ('super_admin', 'billing_admin');
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled');
create type public.invoice_status      as enum ('draft', 'paid', 'failed', 'void');

-- =========================================================================
-- Level 2 — workspace. `workspace_role` is the RBAC capability baseline:
-- it is what a member's effective role on every project beneath the
-- workspace resolves to unless a project_members row overrides it.
-- =========================================================================
create type public.workspace_role      as enum ('owner', 'admin', 'member', 'viewer');

-- =========================================================================
-- Level 3 — client space
-- =========================================================================
create type public.client_space_status as enum ('active', 'archived');

-- =========================================================================
-- Level 4 — project.
--
-- `project_role` is the *scope-local* role. `project_visibility` decides
-- whether project_members is an elevation table (visibility='workspace' —
-- everyone in the workspace can see the project, rows only record role
-- overrides) or an access list (visibility='restricted' — only users with a
-- row can see it at all). Defaulting to 'workspace' is what keeps the common
-- case at one membership row per person per workspace instead of one per
-- person per project.
-- =========================================================================
create type public.project_status      as enum ('active', 'paused', 'archived');
create type public.project_role        as enum ('manager', 'contributor', 'viewer');
create type public.project_visibility  as enum ('workspace', 'restricted');

-- =========================================================================
-- Connectors, sync, AI
--
-- The full provider list is declared up front here rather than accreted via
-- `alter type ... add value` migrations. 'gmail', 'google_drive' and
-- 'google_chat' predate the merged 'google' connector and are retained
-- because Postgres has no safe way to remove an enum value that historical
-- rows reference — they are simply never produced any more (see
-- connectors/registry.ts). 'mock' is present from day one because the mock
-- connector is load-bearing for tests and local dev without live OAuth.
-- =========================================================================
create type public.connector_provider   as enum (
  'slack', 'google', 'gmail', 'google_drive', 'google_chat', 'clickup', 'mock'
);
create type public.integration_status   as enum ('pending', 'connected', 'degraded', 'error', 'revoked', 'disconnected');
create type public.sync_job_status      as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.sync_trigger         as enum ('schedule', 'manual', 'webhook', 'backfill');
create type public.action_item_kind     as enum ('action', 'risk', 'blocker', 'update', 'follow_up');
create type public.action_item_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.action_item_status   as enum ('pending', 'in_progress', 'done', 'dismissed', 'snoozed');
create type public.llm_run_kind         as enum ('action_items', 'daily_summary', 'backfill');
create type public.llm_run_status       as enum ('queued', 'running', 'succeeded', 'failed');
create type public.milestone_status     as enum ('planned', 'in_progress', 'at_risk', 'done', 'cancelled');
