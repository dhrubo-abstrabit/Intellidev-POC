create type public.workspace_role       as enum ('owner', 'admin', 'member', 'viewer');
create type public.project_status       as enum ('active', 'paused', 'archived');
create type public.connector_provider   as enum ('slack', 'google_chat', 'google_drive', 'clickup', 'mock');
create type public.integration_status   as enum ('pending', 'connected', 'degraded', 'error', 'revoked', 'disconnected');
create type public.sync_job_status      as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.sync_trigger         as enum ('schedule', 'manual', 'webhook', 'backfill');
create type public.action_item_kind     as enum ('action', 'risk', 'blocker', 'update', 'follow_up');
create type public.action_item_priority as enum ('low', 'medium', 'high', 'urgent');
create type public.action_item_status   as enum ('pending', 'in_progress', 'done', 'dismissed', 'snoozed');
create type public.llm_run_kind         as enum ('action_items', 'daily_summary', 'backfill');
create type public.llm_run_status       as enum ('queued', 'running', 'succeeded', 'failed');

-- 'mock' is included in connector_provider from day one (not bolted on later) because the
-- mock connector is load-bearing for tests and local dev without live OAuth credentials.
