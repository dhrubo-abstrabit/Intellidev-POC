
-- =========================================================================
-- raw_events: untouched provider payloads. SERVICE-ROLE ONLY — this table
-- has had zero redaction applied by definition (private DM content, member
-- emails, signed Drive URLs, sometimes even provider tokens embedded in
-- webhook bodies).
--
-- `id` has NO default: the app generates a UUIDv7 (time-ordered) before
-- insert, so index locality on this append-only, high-volume table doesn't
-- require ever changing the column type later. See src/lib/db/uuid.ts.
--
-- Deliberately NO foreign key from normalized_events to raw_events (see
-- normalized_events below) and NO inbound FK onto raw_events itself, so it
-- stays freely prunable/partitionable (e.g. PARTITION BY RANGE (ingested_at))
-- without a schema redesign later.
-- =========================================================================
create table public.raw_events (
  id                 uuid primary key,
  workspace_id       uuid not null,
  project_id         uuid not null,
  integration_id     uuid not null,
  sync_job_id        uuid,
  provider           public.connector_provider not null,
  provider_event_id  text,        -- Slack ts, Drive revision id, ClickUp history id
  payload            jsonb not null,   -- untouched provider body
  payload_hash       bytea,       -- sha256 fallback dedupe when no stable provider event id
  occurred_at        timestamptz,
  ingested_at        timestamptz not null default now(),
  foreign key (integration_id, workspace_id)
    references public.integrations (id, workspace_id) on delete cascade
);

-- Idempotent ingest is `insert ... on conflict do nothing returning id`.
create unique index raw_events_provider_event_uniq
  on public.raw_events (integration_id, provider_event_id)
  where provider_event_id is not null;
create unique index raw_events_hash_uniq
  on public.raw_events (integration_id, payload_hash)
  where provider_event_id is null and payload_hash is not null;
create index raw_events_retention_idx on public.raw_events (ingested_at);

alter table public.raw_events enable row level security;
revoke all on public.raw_events from anon, authenticated;

-- Retention: pruned at 90 days by a scheduled cleanup job (services/sync),
-- not by a DB-level policy — keeping this table free of inbound FKs is what
-- makes that deletion cheap.

-- =========================================================================
-- normalized_events: standardized event shape, read-only to clients.
--
-- `title`/`body`/`actor_email` are hoisted OUT of `metadata` because every
-- LLM prompt and every dashboard timeline row reads them — leaving them
-- jsonb-only would mean jsonb extraction on every read and no way to index
-- them for search. `metadata` holds the provider-specific long tail.
--
-- `type` is text + a regex CHECK (not an enum): normalized event types will
-- grow past 50 values as connectors are added, and an enum would couple
-- every new connector to a migration. The regex enforces the `noun.verb`
-- contract (e.g. "task.created") so nothing inconsistent sneaks in.
-- =========================================================================
create table public.normalized_events (
  id             uuid primary key,   -- app-generated UUIDv7, see raw_events note above
  workspace_id   uuid not null,
  project_id     uuid not null,
  integration_id uuid not null,
  raw_event_id   uuid,               -- intentionally no FK (see raw_events note above)
  provider       public.connector_provider not null,

  type           text not null check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  actor          text,               -- provider-native actor id
  actor_display  text,
  actor_email    extensions.citext,
  resource       text,               -- provider-native resource id
  resource_type  text,               -- 'task' | 'message' | 'file' | ...
  resource_url   text,
  title          text,
  body           text,               -- plaintext, feeds the LLM prompt directly
  occurred_at    timestamptz not null,
  metadata       jsonb not null default '{}'::jsonb,

  dedupe_key     text not null,      -- provider-stable: `${type}:${resource}:${revision}`
  ingested_at    timestamptz not null default now(),
  processed_at   timestamptz,        -- set once an llm_run has consumed this event

  foreign key (integration_id, workspace_id)
    references public.integrations (id, workspace_id) on delete cascade,
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  unique (integration_id, dedupe_key),
  check (jsonb_typeof(metadata) = 'object')
);

comment on column public.normalized_events.metadata is
  'Provider-specific long tail not hoisted into a column. Shape varies by provider+type; '
  'validated at the app layer, not by a DB constraint.';

-- Hot path 1: recent activity timeline for a project.
-- `id desc` in the index (not just as an ORDER BY tiebreak) makes the sort
-- fully index-ordered and keyset pagination exact when many events share a
-- timestamp (bursty Slack channels do this constantly).
create index normalized_events_project_recent_idx
  on public.normalized_events (project_id, occurred_at desc, id desc);

-- Filtered variants the dashboard actually renders (by type / by connector).
create index normalized_events_project_type_recent_idx
  on public.normalized_events (project_id, type, occurred_at desc);
create index normalized_events_project_provider_recent_idx
  on public.normalized_events (project_id, provider, occurred_at desc);

-- LLM feeder queue: "events not yet processed". Partial index stays tiny in
-- steady state (most events get processed quickly) — this is the highest-
-- value index in the schema for the sync->LLM handoff.
create index normalized_events_unprocessed_idx
  on public.normalized_events (project_id, occurred_at)
  where processed_at is null;

-- workspace_id is deliberately NOT the leading column on any index here.
-- The RLS predicate resolves to a hash-probe filter (see current_workspace_ids
-- in 20260803150400_tenancy.sql) applied on top of the project_id-scoped
-- index, and project_id is already tenant-unique via its composite FK to
-- projects. Leading with workspace_id would just bloat the index for no gain.

-- A GIN index on metadata (jsonb_path_ops) is deliberately deferred until a
-- real metadata filter exists in the product — it would be the second-
-- largest index in the DB and would slow every insert on the highest-write
-- table for a query pattern that doesn't exist yet.

alter table public.normalized_events enable row level security;

create policy normalized_events_select on public.normalized_events for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.normalized_events to authenticated;
revoke insert, update, delete on public.normalized_events from authenticated, anon;
