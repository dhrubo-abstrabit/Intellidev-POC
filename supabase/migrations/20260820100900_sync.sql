create table public.sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  integration_id  uuid not null,
  status          public.sync_job_status not null default 'queued',
  trigger         public.sync_trigger not null default 'schedule',
  attempt         smallint not null default 1,
  max_attempts    smallint not null default 5,
  scheduled_for   timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  duration_ms     integer generated always as
    ((extract(epoch from (finished_at - started_at)) * 1000)::integer) stored,
  events_fetched  integer not null default 0,
  events_written  integer not null default 0,
  error_code      text,
  error_message   text,
  qstash_message_id text,
  idempotency_key   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade,
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade
);

-- Mutex: the queue delivers at-least-once, so a duplicate delivery must fail
-- this INSERT rather than double-advance the integration's cursor.
create unique index sync_jobs_one_active_per_integration
  on public.sync_jobs (integration_id)
  where status in ('queued', 'running');

create unique index sync_jobs_idempotency_key_uniq
  on public.sync_jobs (idempotency_key) where idempotency_key is not null;

create index sync_jobs_integration_recent_idx
  on public.sync_jobs (integration_id, created_at desc);

create trigger trg_sync_jobs_updated_at
  before update on public.sync_jobs
  for each row execute function public.set_updated_at();

alter table public.sync_jobs enable row level security;

-- Members can see sync history (surfaced on the Integrations page); only the
-- service role (which bypasses RLS) ever writes a row.
create policy sync_jobs_select on public.sync_jobs for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_jobs to authenticated;
revoke insert, update, delete on public.sync_jobs from authenticated, anon;

-- =========================================================================
-- Coordinates "wait for every connector to finish today, then run action-item
-- extraction once over the whole day" (see src/services/sync/batch.ts).
--
-- Membership rows, not a counter: the compare-and-swap needed to fire the LLM
-- job exactly once is a plain conditional `UPDATE ... WHERE completed_at IS
-- NULL RETURNING`, which Postgres already serializes correctly via ordinary
-- row locking. A membership table is also directly debuggable — "why hasn't
-- today's digest run" is a `select * from sync_batch_members where
-- completed_at is null`, not a mystery counter value.
--
-- Batched per CLIENT SPACE, not per project: the day's events and the daily
-- summary they feed both belong to the client space, and `batch_date` is
-- computed in client_spaces.timezone.
-- =========================================================================
create table public.sync_batches (
  id               uuid primary key default gen_random_uuid(),
  client_space_id  uuid not null,
  workspace_id     uuid not null,
  batch_date       date not null,
  llm_triggered_at timestamptz,
  created_at       timestamptz not null default now(),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  unique (client_space_id, batch_date)
);

-- One row per integration expected to report in for that day's batch,
-- seeded by the cron tick from that client space's due integrations.
create table public.sync_batch_members (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references public.sync_batches (id) on delete cascade,
  integration_id  uuid not null,
  client_space_id uuid not null,
  completed_at    timestamptz,
  -- 'succeeded' | 'failed' | 'enqueue_failed' | 'timed_out' — observability
  -- only, never branched on.
  outcome         text,
  created_at      timestamptz not null default now(),
  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade,
  unique (batch_id, integration_id)
);

create index sync_batch_members_pending_idx
  on public.sync_batch_members (batch_id)
  where completed_at is null;

alter table public.sync_batches       enable row level security;
alter table public.sync_batch_members enable row level security;

create policy sync_batches_select on public.sync_batches for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_batches to authenticated;
revoke insert, update, delete on public.sync_batches from authenticated, anon;

create policy sync_batch_members_select on public.sync_batch_members for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.sync_batch_members to authenticated;
revoke insert, update, delete on public.sync_batch_members from authenticated, anon;
