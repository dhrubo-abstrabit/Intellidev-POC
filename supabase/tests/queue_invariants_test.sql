-- pgTAP invariants for the pgmq/pg_cron job queue (see
-- supabase/migrations/20260811100000_pgmq_pg_cron.sql). Run with
-- `supabase test db` (requires the local stack: `supabase start`).

begin;
select plan(10);

-- 1, 2 & 3. All three extensions dispatch_jobs()/dispatch_daily_tick()/
--    reap_job_dispatches() depend on are installed. pg_net is checked
--    explicitly and separately from pg_cron/pgmq: it was wrongly assumed
--    pre-installed on every environment when this migration was first
--    written (true on the local Docker image's own bootstrap, NOT true on
--    a hosted project that predates pg_net being enabled by default — see
--    20260811110000_pg_net_extension.sql), and nothing else here would
--    have caught that gap before it reached production.
select ok(
  exists(select 1 from pg_extension where extname = 'pg_cron'),
  'pg_cron extension is installed'
);
select ok(
  exists(select 1 from pg_extension where extname = 'pgmq'),
  'pgmq extension is installed'
);
select ok(
  exists(select 1 from pg_extension where extname = 'pg_net'),
  'pg_net extension is installed'
);

-- 3. The `jobs` queue exists.
select ok(
  exists(select 1 from pgmq.list_queues() where queue_name = 'jobs'),
  'the jobs queue exists'
);

-- 4. The three RPC wrappers the app calls over PostgREST exist and are
--    SECURITY DEFINER — same shape as the tenancy RLS helpers (see
--    schema_invariants_test.sql), since pgmq's own schema is otherwise
--    unreachable from the Supabase client.
select ok(
  (
    select count(*) = 3
    from pg_proc
    where proname in ('enqueue_job', 'ack_job', 'fail_job')
      and pronamespace = 'public'::regnamespace
      and prosecdef
  ),
  'enqueue_job, ack_job, and fail_job all exist and are SECURITY DEFINER'
);

-- 5. Same load-bearing check as schema_invariants_test.sql's #2, applied to
--    the six new functions: none of them are reachable by anon/authenticated
--    over PostgREST, even though they're SECURITY DEFINER.
select is(
  (
    select count(*)::int
    from information_schema.role_routine_grants
    where routine_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and routine_name in (
        'enqueue_job', 'ack_job', 'fail_job',
        'dispatch_jobs', 'dispatch_daily_tick', 'reap_job_dispatches'
      )
  ),
  0,
  'no job-queue function is executable by anon or authenticated'
);

-- 6. job_dispatches has row level security enabled and no client-role
--    grants — same shape as connector_credentials/raw_events/llm_runs.
select ok(
  (
    select c.relrowsecurity
    from pg_class c
    where c.relname = 'job_dispatches' and c.relnamespace = 'public'::regnamespace
  ),
  'job_dispatches has row level security enabled'
);
select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'job_dispatches'
      and grantee in ('anon', 'authenticated')
  ),
  0,
  'job_dispatches has no grants to anon or authenticated'
);

-- 7 & 8. The three schedules exist with the expected cadence, and
--    daily_tick starts deactivated (see the migration's header comment on
--    why: Vercel Cron's own daily tick is still live until the prod cutover
--    flips this on and removes vercel.json's `crons` block in the same
--    deploy).
select is(
  (select schedule from cron.job where jobname = 'job_dispatch'),
  '5 seconds',
  'job_dispatch runs every 5 seconds'
);
select is(
  (select active from cron.job where jobname = 'daily_tick'),
  false,
  'daily_tick is created inactive'
);

select * from finish();
rollback;
