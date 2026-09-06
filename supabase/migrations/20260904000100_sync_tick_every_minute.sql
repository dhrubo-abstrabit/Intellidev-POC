-- Makes project_connectors.sync_interval_seconds actually meaningful.
--
-- Before this migration, due-ness was only ever re-evaluated once a day (see
-- dispatch_daily_tick below), so any sync_interval_seconds under ~24h was
-- indistinguishable from 24h — the column existed and was already
-- client-writable (20260901000800_connectors.sql), but nothing ever re-checked
-- it often enough to honor a shorter interval. This migration renames the
-- once-a-day dispatcher to a once-a-minute one, which is also the column's own
-- CHECK floor (between 60 and 86400 seconds).
--
-- Renaming daily_tick -> sync_tick (and dispatch_daily_tick ->
-- dispatch_sync_tick) rather than just rescheduling it in place: leaving a
-- function/job named "daily" running every 60 seconds would be exactly the
-- kind of stale, misleading name this schema otherwise avoids, and
-- supabase/tests/queue_invariants_test.sql pins the old name — so the rename
-- is caught by that test rather than silently misleading whoever reads it
-- next.

create or replace function public.dispatch_sync_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- This lock guards ONLY this function's own body (mirroring
  -- dispatch_jobs()'s pattern) — it does NOT make the downstream call to
  -- /api/cron/tick mutually exclusive. net.http_get is fire-and-forget:
  -- pg_net queues the request and this function returns immediately, long
  -- before the route itself (up to 60s, its own maxDuration) has responded.
  -- So two ticks 60 seconds apart CAN still have the route body running
  -- concurrently if the previous invocation is slow — that overlap is
  -- handled at the application layer instead:
  --   * a duplicate /api/jobs/sync enqueue for the same connector is a
  --     harmless no-op, caught by sync_jobs_one_active_per_connector
  --     (20260901000900_sync.sql).
  --   * a duplicate /api/jobs/batch-timeout enqueue for the same client
  --     space/day is avoided by seedBatchForClientSpace only asking the tick
  --     to schedule it when this call is the one that actually created the
  --     row (see the `created` return value in src/services/sync/batch.ts).
  -- What this lock DOES prevent: two concurrent executions of this PL/pgSQL
  -- body both reading Vault and firing their own net.http_get in the (very
  -- unlikely, given the body is a handful of fast selects) case pg_cron ever
  -- overlapped two runs of the same job.
  v_lock_key constant bigint := hashtext('public.dispatch_sync_tick');
  v_secret text;
  v_base_url text;
begin
  if not pg_try_advisory_lock(v_lock_key) then
    return; -- a previous tick's dispatch body is still in flight; skip this one.
  end if;

  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'job_dispatch_secret';
    select decrypted_secret into v_base_url from vault.decrypted_secrets where name = 'app_base_url';

    if v_secret is null or v_base_url is null then
      raise warning 'dispatch_sync_tick: job_dispatch_secret or app_base_url missing from Vault; skipping';
    else
      perform net.http_get(
        url := v_base_url || '/api/cron/tick',
        headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
        timeout_milliseconds := 70000
      );
    end if;
  exception when others then
    perform pg_advisory_unlock(v_lock_key);
    raise;
  end;

  perform pg_advisory_unlock(v_lock_key);
end;
$$;

revoke execute on function public.dispatch_sync_tick() from public, anon, authenticated;

-- cron.unschedule() raises if the job name doesn't exist, so guard it to keep
-- this migration re-runnable (cron.schedule() is already idempotent by name,
-- per the header comment in 20260901001500_pgmq_pg_cron.sql).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'daily_tick') then
    perform cron.unschedule('daily_tick');
  end if;
end
$$;

select cron.schedule('sync_tick', '* * * * *', $cmd$select public.dispatch_sync_tick();$cmd$);

drop function if exists public.dispatch_daily_tick();
