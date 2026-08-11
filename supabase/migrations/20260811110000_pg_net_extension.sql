-- pg_net is required by dispatch_jobs()/dispatch_daily_tick()/reap_job_dispatches()
-- (20260811100000_pgmq_pg_cron.sql) for net.http_post/net.http_get/net._http_response.
-- Wrongly assumed to be universally pre-installed when that migration was
-- written — true on this project's local Docker image (the Supabase CLI's
-- own bootstrap registers it there), but NOT true on a hosted project that
-- predates pg_net being enabled by default. Confirmed missing on the cloud
-- project (`schema "net" does not exist` from cron.job_run_details) despite
-- being present locally — this migration is what actually closes that gap.
create extension if not exists pg_net;
