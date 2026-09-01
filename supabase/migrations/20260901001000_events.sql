-- =========================================================================
-- raw_events: untouched provider payloads. SERVICE-ROLE ONLY — this table has
-- had zero redaction applied by definition (private DM content, member
-- emails, signed Drive URLs, sometimes provider tokens in webhook bodies).
--
-- `id` has NO default: the app generates a UUIDv7 (time-ordered) before
-- insert, so index locality on this append-only, high-volume table does not
-- require changing the column type later.
--
-- Deliberately NO inbound FKs and no FK to it from normalized_events, so it
-- stays freely prunable/partitionable (e.g. PARTITION BY RANGE (ingested_at))
-- without a schema redesign.
--
-- CHANGED from the previous schema: events now carry project_id, decided at
-- CONFIG time by which project scoped the connector, rather than being
-- client-space-only with attribution deferred to the LLM. The three-column FK
-- is what makes that attribution trustworthy.
-- =========================================================================
create table public.raw_events (
  id                   uuid primary key,
  client_space_id      uuid not null,
  project_id           uuid not null,
  project_connector_id uuid not null,
  sync_job_id          uuid references public.sync_jobs (id) on delete set null,
  provider             public.connector_provider not null,
  provider_event_id    text,        -- Slack ts, Drive revision id, etc.
  payload              jsonb not null,
  payload_hash         bytea,       -- sha256 fallback when no stable provider id
  occurred_at          timestamptz,
  ingested_at          timestamptz not null default now(),

  -- THREE columns, not two. Guarantees the event's project matches the
  -- project its connector actually belongs to — an event cannot claim
  -- project B while being sourced from project A's connector.
  foreign key (project_connector_id, project_id, client_space_id)
    references public.project_connectors (id, project_id, client_space_id) on delete cascade
);

-- Idempotent ingest is `insert ... on conflict do nothing returning id`.
-- Keyed on the CONNECTOR, not the event: two projects scoping the same Slack
-- channel each keep their own copy. That is the accepted duplicate-ingestion
-- consequence documented on project_connectors.
create unique index raw_events_provider_event_uniq
  on public.raw_events (project_connector_id, provider_event_id)
  where provider_event_id is not null;
create unique index raw_events_hash_uniq
  on public.raw_events (project_connector_id, payload_hash)
  where provider_event_id is null and payload_hash is not null;
create index raw_events_retention_idx on public.raw_events (ingested_at);

alter table public.raw_events enable row level security;
revoke all on public.raw_events from anon, authenticated;

-- =========================================================================
-- normalized_events: standardized event shape, read-only to clients.
--
-- `title`/`body`/`actor_email` are hoisted OUT of metadata because every LLM
-- prompt and every timeline row reads them — leaving them jsonb-only means
-- extraction on every read and no way to index them.
--
-- `type` is text + a regex CHECK, not an enum: normalized event types will
-- grow past 50 values as connectors are added, and an enum would couple every
-- new connector to a migration.
-- =========================================================================
create table public.normalized_events (
  id                   uuid primary key,   -- app-generated UUIDv7
  client_space_id      uuid not null,
  project_id           uuid not null,
  project_connector_id uuid not null,
  raw_event_id         uuid,               -- intentionally no FK, see above
  provider             public.connector_provider not null,

  type            text not null check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  actor           text,
  actor_display   text,
  actor_email     extensions.citext,
  resource        text,
  resource_type   text,
  resource_url    text,   -- THE click-through target. Every connector must set it.
  title           text,
  body            text,   -- plaintext, feeds the LLM prompt directly
  occurred_at     timestamptz not null,
  metadata        jsonb not null default '{}'::jsonb,

  dedupe_key      text not null,
  -- TOMBSTONE. Set when the provider reports the source removed upstream.
  -- The previous schema had no way to express this, so deleted content lived
  -- forever in the timeline and (now) would live forever in the search index.
  -- Gating on this is cheaper and more auditable than deleting the row, which
  -- would break task provenance.
  deleted_upstream_at timestamptz,
  -- An edit produces a NEW row (dedupe_key carries the revision); this points
  -- the superseded row forward to its replacement.
  superseded_by       uuid references public.normalized_events (id) on delete set null,
  processed_at        timestamptz,   -- set once an llm_run has consumed this
  ingested_at         timestamptz not null default now(),

  foreign key (project_connector_id, project_id, client_space_id)
    references public.project_connectors (id, project_id, client_space_id) on delete cascade,
  unique (project_connector_id, dedupe_key),
  check (jsonb_typeof(metadata) = 'object')
);

comment on column public.normalized_events.metadata is
  'Provider-specific long tail not hoisted into a column, plus `service` '
  '("gmail"|"drive"|"chat") for the merged google connector — since provider '
  'is written verbatim as ''google'' for all three, that tag is the only '
  'thing distinguishing them. Do not drop it.';

-- Hot path: recent activity for a client space. `id desc` in the index (not
-- just as an ORDER BY tiebreak) makes the sort fully index-ordered and keyset
-- pagination exact when many events share a timestamp (bursty channels do
-- this constantly).
create index normalized_events_cs_recent_idx
  on public.normalized_events (client_space_id, occurred_at desc, id desc)
  where deleted_upstream_at is null;
create index normalized_events_project_recent_idx
  on public.normalized_events (project_id, occurred_at desc, id desc)
  where deleted_upstream_at is null;

-- LLM feeder queue. Partial index stays tiny in steady state — the
-- highest-value index in the schema for the sync -> LLM handoff.
create index normalized_events_unprocessed_idx
  on public.normalized_events (client_space_id, occurred_at)
  where processed_at is null and deleted_upstream_at is null;

alter table public.normalized_events enable row level security;

create policy normalized_events_select on public.normalized_events for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and project_id in (select public.current_project_ids())
  );
grant select on public.normalized_events to authenticated;
revoke insert, update, delete on public.normalized_events from authenticated, anon;

-- =========================================================================
-- event_attachments: per-attachment extraction state.
--
-- Its own table rather than a column on normalized_events because normalize()
-- is a pure function with no I/O: it can only ever *describe* an attachment,
-- never download or parse bytes. Extraction happens later in a separate job,
-- and normalized_events.body is written exactly once at normalize time — so
-- there is no later point at which extracted text could be appended into it.
--
-- One row per attachment, not per message: a Slack message or Gmail email can
-- carry several files, and per-attachment status is what the UI shows.
-- =========================================================================
create table public.event_attachments (
  id                     uuid primary key,   -- app-generated UUIDv7
  client_space_id        uuid not null,
  project_id             uuid not null,
  normalized_event_id    uuid not null
                           references public.normalized_events (id) on delete cascade,
  provider               public.connector_provider not null,

  provider_attachment_id text not null,
  filename               text,
  mime_type              text,
  size_bytes             bigint,

  -- Opaque, provider-specific handle the download step needs. jsonb for the
  -- same reason as the cursor: the shape genuinely differs per provider.
  download_ref           jsonb not null default '{}'::jsonb,

  status                 text not null default 'pending'
                           check (status in ('pending', 'extracted', 'skipped', 'failed')),
  skip_reason            text,
  extracted_text         text,
  extracted_chars        integer,
  text_truncated         boolean not null default false,

  storage_path           text,  -- path in the private 'attachments' bucket
  error                  text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  -- Idempotency key for at-least-once job delivery: re-running the
  -- attachments job (or a re-synced message) must not create duplicate rows.
  unique (normalized_event_id, provider_attachment_id),
  check (jsonb_typeof(download_ref) = 'object')
);

comment on column public.event_attachments.download_ref is
  'Provider-specific download handle, opaque to the DB. Slack: '
  '{"url_private_download":"..."}. Gmail: {"messageId":"...","attachmentId":"..."}. '
  'Google Chat: {"kind":"chat_media","resourceName":"..."}. App-layer validated.';

create index event_attachments_pending_idx
  on public.event_attachments (project_id, created_at)
  where status = 'pending';
create index event_attachments_event_idx
  on public.event_attachments (normalized_event_id)
  where status = 'extracted';

create trigger trg_event_attachments_updated_at
  before update on public.event_attachments
  for each row execute function public.set_updated_at();

alter table public.event_attachments enable row level security;

create policy event_attachments_select on public.event_attachments for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and project_id in (select public.current_project_ids())
  );
grant select on public.event_attachments to authenticated;
revoke insert, update, delete on public.event_attachments from authenticated, anon;

-- =========================================================================
-- attachments Storage bucket: private, service-role only. Zero policies on
-- storage.objects for this bucket means only the service role (which bypasses
-- RLS) can read or write it.
--
-- Path convention (enforced at the app layer, not the DB):
--   {client_space_id}/{normalized_event_id}/{attachment_id}
--
-- NOTE: this bucket lives in the `storage` schema, OUTSIDE public. A
-- `drop schema public cascade` does not remove it, and its objects survive
-- independently of the rows below — any future schema reset must clear them
-- through the Storage API, never by deleting storage.objects rows (which
-- orphans the bytes in S3 permanently).
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- =========================================================================
-- Retention. Mirrors raw_events' 90-day intent but must also delete the
-- Storage object, not just the row — attachment bytes are the heaviest and
-- most sensitive thing this app stores. SECURITY DEFINER so it can be granted
-- to service_role only. Not wired to cron here; doing so later is a one-line
-- cron.schedule call, not a migration.
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
    select id, storage_path from public.event_attachments where created_at < v_cutoff
  ),
  objects_deleted as (
    delete from storage.objects
    where bucket_id = 'attachments'
      and name in (select storage_path from doomed where storage_path is not null)
    returning 1
  )
  select count(*) into v_deleted_objects from objects_deleted;

  delete from public.event_attachments where created_at < v_cutoff;
  get diagnostics v_deleted_rows = row_count;

  return query select v_deleted_rows, v_deleted_objects;
end;
$$;

revoke execute on function public.prune_event_attachments(int) from public, anon, authenticated;
grant execute on function public.prune_event_attachments(int) to service_role;
