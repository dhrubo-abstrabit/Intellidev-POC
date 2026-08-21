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
-- Deliberately NO foreign key from normalized_events to raw_events and NO
-- inbound FK onto raw_events itself, so it stays freely prunable/partitionable
-- (e.g. PARTITION BY RANGE (ingested_at)) without a schema redesign later.
--
-- Scoped to the client space, with NO project_id: an event belongs to the
-- client, and which project it is relevant to is decided downstream by the
-- LLM (see action_items.project_id in 20260820101100_ai.sql).
-- =========================================================================
create table public.raw_events (
  id                uuid primary key,
  client_space_id   uuid not null,
  integration_id    uuid not null,
  sync_job_id       uuid,
  provider          public.connector_provider not null,
  provider_event_id text,        -- Slack ts, Drive revision id, ClickUp history id
  payload           jsonb not null,   -- untouched provider body
  payload_hash      bytea,       -- sha256 fallback dedupe when no stable provider event id
  occurred_at       timestamptz,
  ingested_at       timestamptz not null default now(),
  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade
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
-- them for search. `metadata` holds the provider-specific long tail, and
-- carries `service` ("gmail"|"drive"|"chat") for the merged Google connector:
-- since `provider` is written verbatim as 'google' for all three, that tag is
-- the only thing distinguishing them. Don't drop it.
--
-- `type` is text + a regex CHECK (not an enum): normalized event types will
-- grow past 50 values as connectors are added, and an enum would couple every
-- new connector to a migration. The regex enforces the `noun.verb` contract.
-- =========================================================================
create table public.normalized_events (
  id              uuid primary key,   -- app-generated UUIDv7, see raw_events note above
  client_space_id uuid not null,
  integration_id  uuid not null,
  raw_event_id    uuid,               -- intentionally no FK (see raw_events note above)
  provider        public.connector_provider not null,

  type            text not null check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  actor           text,               -- provider-native actor id
  actor_display   text,
  actor_email     extensions.citext,
  resource        text,               -- provider-native resource id
  resource_type   text,               -- 'task' | 'message' | 'file' | ...
  resource_url    text,
  title           text,
  body            text,               -- plaintext, feeds the LLM prompt directly
  occurred_at     timestamptz not null,
  metadata        jsonb not null default '{}'::jsonb,

  dedupe_key      text not null,      -- provider-stable: `${type}:${resource}:${revision}`
  ingested_at     timestamptz not null default now(),
  processed_at    timestamptz,        -- set once an llm_run has consumed this event

  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade,
  unique (integration_id, dedupe_key),
  -- No (id, client_space_id) composite unique here on purpose: nothing FKs to
  -- this table on a composite key (action_item_source_events and
  -- event_attachments both reference the bare id), and it would be a second
  -- full-width index on the highest-write table in the schema for no benefit.
  check (jsonb_typeof(metadata) = 'object')
);

comment on column public.normalized_events.metadata is
  'Provider-specific long tail not hoisted into a column, plus `service` '
  '("gmail"|"drive"|"chat") for the merged google connector. Shape varies by '
  'provider+type; validated at the app layer, not by a DB constraint.';

-- Hot path 1: recent activity timeline for a client space.
-- `id desc` in the index (not just as an ORDER BY tiebreak) makes the sort
-- fully index-ordered and keyset pagination exact when many events share a
-- timestamp (bursty Slack channels do this constantly).
create index normalized_events_cs_recent_idx
  on public.normalized_events (client_space_id, occurred_at desc, id desc);

-- Filtered variants the dashboard actually renders (by type / by connector).
create index normalized_events_cs_type_recent_idx
  on public.normalized_events (client_space_id, type, occurred_at desc);
create index normalized_events_cs_provider_recent_idx
  on public.normalized_events (client_space_id, provider, occurred_at desc);

-- LLM feeder queue: "events not yet processed". Partial index stays tiny in
-- steady state — this is the highest-value index in the schema for the
-- sync->LLM handoff.
create index normalized_events_unprocessed_idx
  on public.normalized_events (client_space_id, occurred_at)
  where processed_at is null;

-- A GIN index on metadata (jsonb_path_ops) is deliberately deferred until a
-- real metadata filter exists in the product — it would be the second-largest
-- index in the DB and would slow every insert on the highest-write table for
-- a query pattern that doesn't exist yet.

alter table public.normalized_events enable row level security;

create policy normalized_events_select on public.normalized_events for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.normalized_events to authenticated;
revoke insert, update, delete on public.normalized_events from authenticated, anon;

-- =========================================================================
-- event_attachments: per-attachment extraction state for a normalized_event.
--
-- Its own table rather than a column on normalized_events because normalize()
-- is a pure function with no I/O (connectors/types.ts): it can only ever
-- *describe* an attachment, never download or parse bytes. Extraction happens
-- later in a separate job (/api/jobs/attachments), and normalized_events.body
-- is written exactly once at normalize time — so there is no later point at
-- which extracted text could be appended into it. This table is the durable
-- state between "we know this file exists" and "we have its text".
--
-- One row per attachment, not per message-with-attachments: a Slack message
-- or Gmail email can carry more than one file, and per-attachment status is
-- exactly what the Data/Integrations UI wants to show.
-- =========================================================================
create table public.event_attachments (
  id                     uuid primary key,   -- app-generated UUIDv7
  client_space_id        uuid not null,
  integration_id         uuid not null,
  normalized_event_id    uuid not null references public.normalized_events (id) on delete cascade,
  provider               public.connector_provider not null,

  provider_attachment_id text not null,  -- Slack file id, Gmail MIME part attachmentId, Chat resourceName
  filename               text,
  mime_type              text,
  size_bytes             bigint,

  -- Opaque, provider-specific handle the download step needs. Mirrors why
  -- integration_cursors.cursor is jsonb: the shape genuinely differs per
  -- provider and validating it is the app's job.
  download_ref           jsonb not null default '{}'::jsonb,

  status                 text not null default 'pending'
                           check (status in ('pending', 'extracted', 'skipped', 'failed')),
  -- Shares its vocabulary with connectors/google_drive/text.ts's
  -- TextSkipReason deliberately, so both extraction paths report skips in the
  -- same words. Not a CHECK-constrained enum: the reason vocabulary is an
  -- app-layer concern shared across two TypeScript modules.
  skip_reason            text,

  extracted_text         text,
  extracted_chars        integer,
  text_truncated         boolean not null default false,

  storage_path           text,  -- path within the private 'attachments' bucket; null until uploaded
  error                  text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade,

  -- Idempotency key for at-least-once job delivery: re-running the
  -- attachments job (or a re-synced message) must not create duplicate rows.
  unique (normalized_event_id, provider_attachment_id),
  check (jsonb_typeof(download_ref) = 'object')
);

comment on column public.event_attachments.download_ref is
  'Provider-specific download handle, opaque to the DB. Slack: {"url_private_download":"..."}. '
  'Gmail: {"messageId":"...","attachmentId":"..."}. Google Chat: {"kind":"chat_media","resourceName":"..."} '
  'or {"kind":"drive","fileId":"..."}. Validated at the app layer.';

-- The attachments job's work queue. Mirrors normalized_events_unprocessed_idx's
-- shape and rationale — stays tiny in steady state.
create index event_attachments_pending_idx
  on public.event_attachments (integration_id, created_at)
  where status = 'pending';

-- Lets the LLM context loader (services/action-items/generate.ts) fetch every
-- extracted attachment for a batch of events in one chunked .in() query.
create index event_attachments_event_idx
  on public.event_attachments (normalized_event_id)
  where status = 'extracted';

create trigger trg_event_attachments_updated_at
  before update on public.event_attachments
  for each row execute function public.set_updated_at();

alter table public.event_attachments enable row level security;

-- Readable by anyone who can see the client space (same posture as
-- normalized_events, so the UI can list "this message had 2 attachments"
-- without a service-role proxy) but never writable by them — only the sync
-- job and the attachments job write these rows, both via the service client.
create policy event_attachments_select on public.event_attachments for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.event_attachments to authenticated;
revoke insert, update, delete on public.event_attachments from authenticated, anon;

-- =========================================================================
-- attachments Storage bucket: private, service-role only. Zero policies on
-- storage.objects for this bucket means only the service role (which bypasses
-- RLS) can read or write it; there is deliberately no client-facing
-- signed-URL flow yet.
--
-- Path convention (enforced at the app layer, not the DB):
-- {client_space_id}/{normalized_event_id}/{attachment_id}
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- =========================================================================
-- Retention: mirrors raw_events' documented 90-day retention intent but must
-- also delete the Storage object, not just the row — attachment bytes are the
-- heaviest and most sensitive thing this app stores. SECURITY DEFINER so it
-- can be granted to service_role only and invoked from a future cron schedule
-- without widening any client grant. Not wired to cron.schedule here; doing so
-- later is a one-line cron.schedule call, not a migration.
-- =========================================================================
create or replace function public.prune_event_attachments(p_older_than_days int default 90)
returns table (deleted_rows int, deleted_objects int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - (p_older_than_days || ' days')::interval;
  v_deleted_rows int;
  v_deleted_objects int;
begin
  with doomed as (
    select id, storage_path
    from public.event_attachments
    where created_at < v_cutoff
  ),
  objects_deleted as (
    delete from storage.objects
    where bucket_id = 'attachments'
      and name in (select storage_path from doomed where storage_path is not null)
    returning 1
  )
  select count(*) into v_deleted_objects from objects_deleted;

  delete from public.event_attachments
  where created_at < v_cutoff;
  get diagnostics v_deleted_rows = row_count;

  return query select v_deleted_rows, v_deleted_objects;
end;
$$;

revoke execute on function public.prune_event_attachments(int) from public, anon, authenticated;
grant execute on function public.prune_event_attachments(int) to service_role;
