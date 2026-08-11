-- Coordinates "wait for every connector to finish today, then run action-item
-- extraction once over the whole day" (see src/services/sync/batch.ts).
--
-- Membership rows, not a counter: the compare-and-swap needed to fire the LLM
-- job exactly once is a plain conditional `UPDATE ... WHERE completed_at IS
-- NULL RETURNING`, which Postgres already serializes correctly via ordinary
-- row locking (same idiom as sync_jobs_one_active_per_integration below). A
-- membership table is also directly debuggable — "why hasn't today's digest
-- run" is a `select * from sync_batch_members where completed_at is null`,
-- not a mystery counter value.
create table public.sync_batches (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  project_id        uuid not null,
  batch_date        date not null,
  llm_triggered_at  timestamptz,
  created_at        timestamptz not null default now(),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  unique (project_id, batch_date)
);

-- One row per integration expected to report in for that day's batch,
-- seeded by cron tick from that project's due integrations.
create table public.sync_batch_members (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references public.sync_batches (id) on delete cascade,
  integration_id uuid not null,
  workspace_id   uuid not null,
  completed_at   timestamptz,
  -- 'succeeded' | 'failed' | 'enqueue_failed' | 'timed_out' — observability
  -- only, never branched on.
  outcome        text,
  created_at     timestamptz not null default now(),
  foreign key (integration_id, workspace_id)
    references public.integrations (id, workspace_id) on delete cascade,
  unique (batch_id, integration_id)
);

create index sync_batch_members_pending_idx
  on public.sync_batch_members (batch_id)
  where completed_at is null;

alter table public.sync_batches enable row level security;
alter table public.sync_batch_members enable row level security;

-- Same shape as sync_jobs: members can see batch state, only the service
-- role (which bypasses RLS) ever writes a row.
create policy sync_batches_select on public.sync_batches for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.sync_batches to authenticated;
revoke insert, update, delete on public.sync_batches from authenticated, anon;

create policy sync_batch_members_select on public.sync_batch_members for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.sync_batch_members to authenticated;
revoke insert, update, delete on public.sync_batch_members from authenticated, anon;
