-- =========================================================================
-- sync_jobs: one row per sync attempt.
--
-- RESTORED from the previous schema — the redesign as originally drafted had
-- no run history at all, only mutable last_error/consecutive_failures columns
-- on the connector. That silently dropped the invariant below, and with it
-- the ability to answer "how many syncs failed this week", to detect a stuck
-- run, or to stop two runs racing on one connector.
-- =========================================================================
create table public.sync_jobs (
  id                   uuid primary key default gen_random_uuid(),
  client_space_id      uuid not null,
  project_connector_id uuid not null,
  status               public.sync_job_status not null default 'queued',
  trigger              public.sync_trigger not null default 'schedule',
  attempt              smallint not null default 1,
  max_attempts         smallint not null default 5,
  scheduled_for        timestamptz not null default now(),
  started_at           timestamptz,
  finished_at          timestamptz,
  duration_ms          integer generated always as
                         ((extract(epoch from (finished_at - started_at)) * 1000)::integer) stored,
  events_fetched       integer not null default 0,
  events_written       integer not null default 0,
  error_code           text,
  error_message        text,
  idempotency_key      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (project_connector_id, client_space_id)
    references public.project_connectors (id, client_space_id) on delete cascade
);

-- THE invariant this table exists for: at most one live run per connector.
-- Without it, a retry that overlaps a slow run double-ingests every event in
-- the window, and both runs write conflicting cursors.
create unique index sync_jobs_one_active_per_connector
  on public.sync_jobs (project_connector_id)
  where status in ('queued', 'running');

create unique index sync_jobs_idempotency_uniq
  on public.sync_jobs (idempotency_key) where idempotency_key is not null;

create index sync_jobs_connector_recent_idx
  on public.sync_jobs (project_connector_id, created_at desc);

create trigger trg_sync_jobs_updated_at
  before update on public.sync_jobs
  for each row execute function public.set_updated_at();

-- =========================================================================
-- sync_batches / sync_batch_members: the daily coordination barrier.
--
-- Also RESTORED. These answer "has every connector in this client space
-- finished today?", which is the trigger condition for the nightly LLM pass.
-- Nothing else in the schema can answer it: a per-connector timestamp tells
-- you about one connector, not about the set.
--
-- Batched per CLIENT SPACE, not per project, because the digest and the task
-- board are client-space scoped — one client with four projects gets one
-- nightly run covering all of them.
-- =========================================================================
create table public.sync_batches (
  id               uuid primary key default gen_random_uuid(),
  client_space_id  uuid not null references public.client_spaces (id) on delete cascade,
  batch_date       date not null,
  llm_triggered_at timestamptz,
  created_at       timestamptz not null default now(),
  unique (client_space_id, batch_date)
);

create index sync_batches_space_date_idx
  on public.sync_batches (client_space_id, batch_date desc);

create table public.sync_batch_members (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references public.sync_batches (id) on delete cascade,
  project_connector_id uuid not null,
  client_space_id      uuid not null,
  completed_at         timestamptz,
  outcome              text check (outcome is null or outcome in ('succeeded', 'failed', 'skipped')),
  created_at           timestamptz not null default now(),
  foreign key (project_connector_id, client_space_id)
    references public.project_connectors (id, client_space_id) on delete cascade,
  unique (batch_id, project_connector_id)
);

-- "Is anything in this batch still outstanding?" — stays tiny in steady state.
create index sync_batch_members_pending_idx
  on public.sync_batch_members (batch_id)
  where completed_at is null;

-- =========================================================================
-- RLS — read-only to clients across all three. The sync engine writes these
-- via the service role; a member changing job state would desync the
-- dispatcher's bookkeeping.
-- =========================================================================
alter table public.sync_jobs          enable row level security;
alter table public.sync_batches       enable row level security;
alter table public.sync_batch_members enable row level security;

create policy sync_jobs_select on public.sync_jobs for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_jobs to authenticated;
revoke insert, update, delete on public.sync_jobs from authenticated, anon;

create policy sync_batches_select on public.sync_batches for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_batches to authenticated;
revoke insert, update, delete on public.sync_batches from authenticated, anon;

create policy sync_batch_members_select on public.sync_batch_members for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_batch_members to authenticated;
revoke insert, update, delete on public.sync_batch_members from authenticated, anon;
