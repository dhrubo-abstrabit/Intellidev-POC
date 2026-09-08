-- =========================================================================
-- Supports PM-reviewed task enrichment: a human links a retrieved event/
-- attachment to a task (via the Task Tracking UI's "Find related" action)
-- rather than the model auto-citing one during extraction. See
-- src/services/tasks/enrich.ts for the writer.
--
-- Two independent additions, kept in one file since neither depends on data
-- the other writes and both are needed before the feature can ship:
--   1. A new llm_runs.kind for the description-rewrite call this triggers.
--   2. task_sources.linked_by, to distinguish a PM-added link from a
--      model-written one.
-- =========================================================================

-- New value only — nothing in this migration (or any single migration) may
-- USE 'enrich_task' in the same transaction that adds it; Postgres still
-- forbids that even though ADD VALUE itself is transactional as of PG12.
-- The writer (src/services/tasks/enrich.ts) runs in its own later
-- transaction, so this is a non-issue there.
alter type public.llm_run_kind add value if not exists 'enrich_task';

-- Nullable, no default, no backfill — every existing row is model-written by
-- definition (this column didn't exist when they were inserted), and null
-- is the correct value for that. Not a role enum value: role describes WHAT
-- a link means (created_from/enriched/mentioned) and drives the timeline
-- rendering documented on task_sources' own migration comment
-- (20260901001200_tasks.sql) — this column answers a different question,
-- WHO made it, and is deliberately orthogonal.
alter table public.task_sources
  add column linked_by uuid references public.users (id) on delete set null;

comment on column public.task_sources.linked_by is
  'Null means model-written (created during extraction — see '
  'services/action-items/generate.ts). Non-null is the user who linked this '
  'source by hand via Task Tracking''s "Find related" action (see '
  'services/tasks/enrich.ts) — the only rows a PM may unlink from the UI.';
