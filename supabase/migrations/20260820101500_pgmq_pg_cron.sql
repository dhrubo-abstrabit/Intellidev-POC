-- Job scheduling + queueing on pg_cron + pgmq rather than Vercel Cron +
-- Upstash QStash: Vercel Cron is capped at once/day on the Hobby plan, and
-- QStash's callback can never reach localhost, so a QStash-only queue can only
-- be exercised in production.
--
-- Dispatch model: pg_cron reads a small batch off pgmq every few seconds and
-- fires one async net.http_post per message at the job route, so each job
-- still gets its own Vercel invocation and full 60s function budget. The route
-- acks/nacks itself via the enqueue_job/ack_job/fail_job wrappers below — see
-- src/lib/queue/auth.ts.
--
-- pg_net is created in 20260820100100_extensions.sql, ahead of this file:
-- every function here references the `net` schema at definition time.
--
-- daily_tick is created but left INACTIVE. Flipping it on
-- (cron.alter_job(..., active => true)) and removing the `crons` block from
-- vercel.json happen together, in a prod-cutover step, not here — two active
-- ticks would double-fire every integration's sync.

create extension if not exists pg_cron;
create extension if not exists pgmq;

-- pgmq.create() builds pgmq.q_<name> and pgmq.a_<name> DYNAMICALLY, which
-- means they are not members of the pgmq extension. They therefore survive
-- both `drop extension pgmq` and a `supabase db reset` (which drops and
-- rebuilds `public`, not `pgmq`) — while the sequences and registry rows the
-- extension does own are rebuilt from scratch.
--
-- The result on any database that has run this migration before is a half-
-- state: pgmq.q_jobs exists, pgmq.q_jobs_msg_id_seq does not. pgmq.create()
-- then skips the table (its CREATE is IF NOT EXISTS) and immediately fails
-- referencing the missing sequence:
--
--   ERROR: relation "pgmq.q_jobs_msg_id_seq" does not exist (SQLSTATE 42P01)
--
-- Confirmed in practice against the cloud project, which is how this block
-- came to exist. Clearing the orphans first makes the migration idempotent
-- across resets. Dropping them is safe: a queue is transient state, and any
-- message still sitting in it at reset time refers to rows in a `public`
-- schema that no longer exists.
do $do$
begin
  if to_regclass('pgmq.q_jobs') is not null then
    execute 'drop table pgmq.q_jobs cascade';
  end if;
  if to_regclass('pgmq.a_jobs') is not null then
    execute 'drop table pgmq.a_jobs cascade';
  end if;
end
$do$;

select pgmq.create('jobs');

-- ---------------------------------------------------------------------------
-- Observability: maps a pgmq message to the net.http_post request(s) made for
-- it. Without this, "why did integration X's sync never run" has no answer
-- beyond "check pgmq.q_jobs" — which pg_net's own response log
-- (net._http_response) doesn't join back to, since it only has pg_net's
-- internal request id, not our msg_id.
-- ---------------------------------------------------------------------------
create table public.job_dispatches (
  id            uuid primary key default gen_random_uuid(),
  msg_id        bigint not null,
  route         text not null,
  attempt       integer not null,
  request_id    bigint,
  status_code   integer,
  error         text,
  dispatched_at timestamptz not null default now(),
  resolved_at   timestamptz
);

create index job_dispatches_request_id_idx on public.job_dispatches (request_id)
  where resolved_at is null;
create index job_dispatches_msg_id_idx on public.job_dispatches (msg_id);

alter table public.job_dispatches enable row level security;

-- Service-role-only, same shape as raw_events/llm_runs/integration_cursors:
-- no policies, no client role has any grant. service_role's access comes from
-- the blanket `alter default privileges ... to service_role` in
-- 20260820101400_service_role_grants.sql, not from a grant here.
revoke all on public.job_dispatches from anon, authenticated;

-- ---------------------------------------------------------------------------
-- public wrappers around pgmq. PostgREST only exposes public/graphql_public,
-- so pgmq.* is otherwise unreachable from the Supabase client the app already
-- uses (createServiceClient()). All three are SECURITY DEFINER so the calling
-- role doesn't need direct grants on pgmq's own tables/functions.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_job(p_route text, p_payload jsonb, p_delay_seconds int default 0)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg_id bigint;
begin
  v_msg_id := (
    select * from pgmq.send(
      'jobs',
      jsonb_build_object('route', p_route, 'payload', p_payload),
      p_delay_seconds
    )
  );
  return v_msg_id;
end;
$$;

create or replace function public.ack_job(p_msg_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.job_dispatches
  set status_code = 200, resolved_at = now()
  where msg_id = p_msg_id and resolved_at is null;

  return pgmq.delete('jobs', p_msg_id);
end;
$$;

-- p_attempt is the read_ct pgmq reported when the dispatcher handed this
-- message to the route (carried over via the x-job-attempt header — see
-- dispatch_jobs() below and src/lib/queue/auth.ts). fail_job never reads
-- pgmq's internal tables itself; it trusts what the dispatcher observed.
create or replace function public.fail_job(p_msg_id bigint, p_attempt int, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_backoff int;
  v_count int;
begin
  v_backoff := 60 * greatest(p_attempt, 1);

  update public.job_dispatches
  set error = p_error, resolved_at = now()
  where msg_id = p_msg_id and resolved_at is null;

  select count(*) into v_count from pgmq.set_vt('jobs', p_msg_id, v_backoff);
  return v_count > 0;
end;
$$;

revoke execute on function public.enqueue_job(text, jsonb, int) from public, anon, authenticated;
revoke execute on function public.ack_job(bigint) from public, anon, authenticated;
revoke execute on function public.fail_job(bigint, int, text) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, jsonb, int) to service_role;
grant execute on function public.ack_job(bigint) to service_role;
grant execute on function public.fail_job(bigint, int, text) to service_role;

-- ---------------------------------------------------------------------------
-- Dispatcher + reaper, called only by pg_cron, never over PostgREST. Locked
-- down the same way as everything else regardless, as defense-in-depth.
--
-- Secret + base URL live in Vault, not in this migration (migrations are
-- committed). Insert them per-environment:
--   select vault.create_secret('<value>', 'job_dispatch_secret');
--   select vault.create_secret('<value>', 'app_base_url');
-- job_dispatch_secret is deliberately the same value as that environment's
-- CRON_SECRET — same trust boundary as the Vercel Cron bearer check, so the
-- job routes' auth check needs no new secret to reason about.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_jobs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_key constant bigint := hashtext('public.dispatch_jobs');
  v_secret text;
  v_base_url text;
  v_msg record;
  v_route text;
  v_payload jsonb;
  v_request_id bigint;
begin
  if not pg_try_advisory_lock(v_lock_key) then
    return; -- a previous tick is still draining the queue; skip this one.
  end if;

  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'job_dispatch_secret';
    select decrypted_secret into v_base_url from vault.decrypted_secrets where name = 'app_base_url';

    if v_secret is null or v_base_url is null then
      raise warning 'dispatch_jobs: job_dispatch_secret or app_base_url missing from Vault; skipping';
    else
      for v_msg in select * from pgmq.read('jobs', 90, 25) loop
        v_route := v_msg.message ->> 'route';
        v_payload := v_msg.message -> 'payload';

        -- Dead letter: a message that has failed this many times is archived
        -- (pgmq.a_jobs) rather than retried forever.
        if v_msg.read_ct > 3 then
          perform pgmq.archive('jobs', v_msg.msg_id);
          insert into public.job_dispatches (msg_id, route, attempt, error, resolved_at)
          values (v_msg.msg_id, v_route, v_msg.read_ct, 'max attempts exceeded; archived', now());
          continue;
        end if;

        -- timeout_milliseconds must exceed every job route's maxDuration
        -- (60s): pg_net's 5s default would cancel the request mid-flight and
        -- Vercel would see that as a client disconnect, indistinguishable from
        -- "the job is stuck" — the single most likely cause of jobs retrying
        -- forever if ever changed back.
        select net.http_post(
          url := v_base_url || v_route,
          body := v_payload,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_secret,
            'x-job-msg-id', v_msg.msg_id::text,
            'x-job-attempt', v_msg.read_ct::text
          ),
          timeout_milliseconds := 70000
        ) into v_request_id;

        insert into public.job_dispatches (msg_id, route, attempt, request_id)
        values (v_msg.msg_id, v_route, v_msg.read_ct, v_request_id);
      end loop;
    end if;
  exception when others then
    perform pg_advisory_unlock(v_lock_key);
    raise;
  end;

  perform pg_advisory_unlock(v_lock_key);
end;
$$;

-- The once-a-day fan-out. Same route, same bearer check as
-- src/app/api/cron/tick/route.ts — a GET, so net.http_get, not net.http_post.
create or replace function public.dispatch_daily_tick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_base_url text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'job_dispatch_secret';
  select decrypted_secret into v_base_url from vault.decrypted_secrets where name = 'app_base_url';

  if v_secret is null or v_base_url is null then
    raise warning 'dispatch_daily_tick: job_dispatch_secret or app_base_url missing from Vault; skipping';
    return;
  end if;

  perform net.http_get(
    url := v_base_url || '/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 70000
  );
end;
$$;

-- Records pg_net's async response back onto job_dispatches (pg_net makes the
-- HTTP call outside the calling transaction, so dispatch_jobs() never sees the
-- outcome itself) and keeps both job_dispatches and pg_net's own response log
-- bounded — net._http_response otherwise grows forever.
create or replace function public.reap_job_dispatches()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.job_dispatches jd
  set status_code = r.status_code,
      error = case when r.timed_out then 'timed out' else r.error_msg end,
      resolved_at = now()
  from net._http_response r
  where jd.request_id = r.id
    and jd.resolved_at is null;

  delete from public.job_dispatches
  where resolved_at is not null and resolved_at < now() - interval '7 days';

  delete from net._http_response
  where created < now() - interval '1 day';
end;
$$;

revoke execute on function public.dispatch_jobs() from public, anon, authenticated;
revoke execute on function public.dispatch_daily_tick() from public, anon, authenticated;
revoke execute on function public.reap_job_dispatches() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Schedules. cron.schedule() is idempotent by job name (re-running updates the
-- existing job rather than erroring or duplicating it), so this file is safe
-- to apply more than once.
-- ---------------------------------------------------------------------------
select cron.schedule('job_dispatch', '5 seconds', $cmd$select public.dispatch_jobs();$cmd$);
select cron.schedule('job_reap', '* * * * *', $cmd$select public.reap_job_dispatches();$cmd$);

do $do$
declare
  v_job_id bigint;
begin
  v_job_id := cron.schedule('daily_tick', '0 6 * * *', $cmd$select public.dispatch_daily_tick();$cmd$);
  perform cron.alter_job(v_job_id, active => false);
end;
$do$;
