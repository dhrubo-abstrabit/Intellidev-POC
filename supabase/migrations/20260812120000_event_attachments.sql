
-- =========================================================================
-- event_attachments: per-attachment extraction state for a normalized_event.
--
-- Why this exists as its own table rather than a column on normalized_events
-- or an inline append to `body`: normalize() is a pure function with no I/O
-- (see connectors/types.ts), so it can only ever *describe* an attachment
-- (filename/mime/a provider-specific download handle) — it cannot download
-- or parse bytes. Extraction therefore happens later, in a separate job
-- (/api/jobs/attachments), asynchronously from the sync that discovers the
-- attachment. normalized_events.body is written exactly once, at normalize
-- time (services/sync/run-sync.ts), so there is no later point at which
-- extracted text could be appended into it even if we wanted to. This table
-- is the durable state between "we know this file exists" (status=pending)
-- and "we have its text" (status=extracted).
--
-- One row per attachment, not per message-with-attachments: a Slack message
-- or Gmail email can carry more than one file, and per-attachment status
-- (this one parsed, that one skipped as binary) is exactly what the
-- Data/Integrations UI wants to show later.
-- =========================================================================
create table public.event_attachments (
  id                     uuid primary key,   -- app-generated UUIDv7, see raw_events' note in 20260803150800_events.sql
  workspace_id           uuid not null,
  project_id             uuid not null,
  integration_id         uuid not null,
  normalized_event_id    uuid not null references public.normalized_events (id) on delete cascade,
  provider               public.connector_provider not null,

  provider_attachment_id text not null,  -- Slack file id, Gmail MIME part attachmentId, Chat attachmentDataRef.resourceName
  filename               text,
  mime_type              text,
  size_bytes             bigint,

  -- Opaque, provider-specific handle the download step needs (Slack:
  -- {url_private_download}, Gmail: {messageId, attachmentId}, Chat:
  -- {kind:"chat_media", resourceName} | {kind:"drive", fileId}). Mirrors why
  -- integration_cursors.cursor is jsonb, not a typed column: the shape
  -- genuinely differs per provider and validating it is the app's job.
  download_ref           jsonb not null default '{}'::jsonb,

  status                 text not null default 'pending'
                           check (status in ('pending', 'extracted', 'skipped', 'failed')),
  -- Shares its vocabulary with connectors/google_drive/text.ts's
  -- TextSkipReason (binary, too_large, no_parser, unknown_mime, budget,
  -- deadline, ...) deliberately, so both extraction paths report skips in
  -- the same words. Not a CHECK-constrained enum: the reason vocabulary is
  -- an app-layer concern shared across two TypeScript modules, and a DB
  -- CHECK would just be a second place to keep in sync with it.
  skip_reason            text,

  extracted_text         text,
  extracted_chars        integer,
  text_truncated         boolean not null default false,

  storage_path           text,  -- path within the private 'attachments' bucket; null until uploaded
  error                  text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  foreign key (integration_id, workspace_id)
    references public.integrations (id, workspace_id) on delete cascade,
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,

  -- Idempotency key for at-least-once job delivery: re-running the
  -- attachments job (or a re-synced message) must not create duplicate rows
  -- for the same attachment.
  unique (normalized_event_id, provider_attachment_id),
  check (jsonb_typeof(download_ref) = 'object')
);

comment on column public.event_attachments.download_ref is
  'Provider-specific download handle, opaque to the DB. Slack: {"url_private_download":"..."}. '
  'Gmail: {"messageId":"...","attachmentId":"..."}. Google Chat: {"kind":"chat_media","resourceName":"..."} '
  'or {"kind":"drive","fileId":"..."}. Validated at the app layer.';

-- The attachments job's work queue: "attachments discovered but not yet
-- processed for this integration". Mirrors normalized_events_unprocessed_idx's
-- shape and rationale (20260803150800_events.sql) — stays tiny in steady
-- state since most attachments get processed within one job run.
create index event_attachments_pending_idx
  on public.event_attachments (integration_id, created_at)
  where status = 'pending';

-- Lets the LLM context loader (services/action-items/generate.ts) fetch
-- every extracted attachment for a batch of events in one chunked .in() query.
create index event_attachments_event_idx
  on public.event_attachments (normalized_event_id)
  where status = 'extracted';

create trigger trg_event_attachments_updated_at
  before update on public.event_attachments
  for each row execute function public.set_updated_at();

alter table public.event_attachments enable row level security;

-- Readable by workspace members (same posture as normalized_events, so a
-- future UI can list "this message had 2 attachments" without a service-role
-- proxy) but never writable by them — only the sync job and the attachments
-- job write these rows, both via the service-role client.
create policy event_attachments_select on public.event_attachments for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.event_attachments to authenticated;
revoke insert, update, delete on public.event_attachments from authenticated, anon;

-- =========================================================================
-- attachments Storage bucket: private, service-role only. This is the
-- first use of Supabase Storage anywhere in this project — no bucket
-- existed before this migration (supabase/config.toml enables Storage but
-- declares no bucket). Zero policies on storage.objects for this bucket
-- means only the service role (which bypasses RLS) can read or write it;
-- there is deliberately no client-facing signed-URL flow yet.
--
-- Path convention (enforced at the app layer, not the DB):
-- {workspace_id}/{project_id}/{normalized_event_id}/{attachment_id}
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- =========================================================================
-- Retention: mirrors raw_events' documented 90-day retention intent
-- (20260803150800_events.sql) but must also delete the Storage object, not
-- just the row — attachment bytes are the heaviest and most sensitive thing
-- this app stores. SECURITY DEFINER so it can be granted to service_role
-- only and invoked from a future cron schedule without widening any client
-- grant. Not wired to cron.schedule in this migration — see the pg_cron
-- wiring in 20260811100000_pgmq_pg_cron.sql for the pattern to follow when
-- this becomes a scheduled job; for now it's a callable function so
-- activating it later is a one-line cron.schedule call, not a migration.
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
