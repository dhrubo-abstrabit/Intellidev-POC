-- The job queue transport is pgmq + pg_cron only now — see
-- 20260820101500_pgmq_pg_cron.sql. `qstash_message_id` is a leftover from
-- the prior Upstash QStash transport: no app code has ever written it (pgmq's
-- own message id already lives on public.job_dispatches), and no index or
-- constraint references it. Dropping it rather than leaving it null forever.
alter table public.sync_jobs
  drop column qstash_message_id;
