create table public.sync_jobs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  project_id     uuid not null,
  integration_id uuid not null,
  status         public.sync_job_status not null default 'queued',
  trigger        public.sync_trigger not null default 'schedule',
  attempt        smallint not null default 1,
  max_attempts   smallint not null default 5,
  scheduled_for  timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  duration_ms    integer generated always as
    ((extract(epoch from (finished_at - started_at)) * 1000)::integer) stored,
  events_fetched integer not null default 0,
  events_written integer not null default 0,
  error_code     text,
  error_message  text,
  qstash_message_id text,
  idempotency_key    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (integration_id, workspace_id)
    references public.integrations (id, workspace_id) on delete cascade,
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade
);

-- Mutex: QStash delivers at-least-once, so a duplicate delivery must fail
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
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.sync_jobs to authenticated;
revoke insert, update, delete on public.sync_jobs from authenticated, anon;
