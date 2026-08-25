-- =========================================================================
-- Activates daily_tick, created inactive by 20260820101500_pgmq_pg_cron.sql
-- specifically so it couldn't double-fire alongside Vercel Cron's own daily
-- schedule. That hazard is gone: vercel.json has been `{}` (no `crons`
-- block) since commit 5bcf4c8, well before this migration. The intended
-- "activate right after that deploy" follow-up was never actually done —
-- cron.job_run_details shows daily_tick has never executed once, meaning
-- there has been no scheduled sync in production at all since Vercel Cron
-- was removed (manual "Sync now" has been the only path). This migration,
-- plus giving src/app/api/cron/tick/route.ts its own `maxDuration = 60`
-- (dispatch_daily_tick() waits up to 70s for it, and the Hobby-plan default
-- is far shorter), closes that gap.
--
-- Looked up by jobname, not a hardcoded jobid — ids aren't guaranteed stable
-- across a schema rebuild (this table's jobs 1/2/3 happen to have been
-- reproduced after 20260820101500 was replayed during the 4-level restructure,
-- but that's not a guarantee to build on).
-- =========================================================================
do $do$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'daily_tick';
  if v_job_id is null then
    raise exception 'daily_tick job not found; 20260820101500_pgmq_pg_cron.sql must run first';
  end if;
  perform cron.alter_job(v_job_id, active := true);
end;
$do$;
