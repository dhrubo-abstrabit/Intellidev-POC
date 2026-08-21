-- Extensions used across the schema.
-- gen_random_uuid() is core in PG13+, no extension needed.
create extension if not exists pgcrypto with schema extensions;  -- gen_random_bytes, digest
create extension if not exists citext   with schema extensions;  -- case-insensitive email
create extension if not exists pg_trgm  with schema extensions;  -- future text search

-- pg_net is required by dispatch_jobs()/dispatch_daily_tick()/reap_job_dispatches()
-- for net.http_post / net.http_get / net._http_response. Created here rather
-- than alongside pg_cron/pgmq because those functions reference the `net`
-- schema at definition time: the previous schema learned this the hard way,
-- shipping the dispatcher before the extension and failing on the cloud
-- project with `schema "net" does not exist` while passing locally (the CLI's
-- own bootstrap registers pg_net in the local image). Ordering it first makes
-- that failure mode structurally impossible.
create extension if not exists pg_net;
