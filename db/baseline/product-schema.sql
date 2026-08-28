


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."chunk_source" AS ENUM (
    'normalized_event',
    'event_attachment',
    'context_document'
);


ALTER TYPE "public"."chunk_source" OWNER TO "postgres";


CREATE TYPE "public"."connector_auth_mode" AS ENUM (
    'nango',
    'api_key',
    'none'
);


ALTER TYPE "public"."connector_auth_mode" OWNER TO "postgres";


CREATE TYPE "public"."connector_provider" AS ENUM (
    'slack',
    'google',
    'supabase',
    'openai_codex',
    'github',
    'mock',
    'gmail',
    'google_drive',
    'google_chat',
    'clickup'
);


ALTER TYPE "public"."connector_provider" OWNER TO "postgres";


CREATE TYPE "public"."embed_status" AS ENUM (
    'pending',
    'embedded',
    'failed',
    'skipped'
);


ALTER TYPE "public"."embed_status" OWNER TO "postgres";


CREATE TYPE "public"."integration_status" AS ENUM (
    'pending',
    'connected',
    'degraded',
    'error',
    'revoked',
    'disconnected'
);


ALTER TYPE "public"."integration_status" OWNER TO "postgres";


CREATE TYPE "public"."llm_run_kind" AS ENUM (
    'extract',
    'reconcile',
    'daily_summary',
    'embed',
    'backfill'
);


ALTER TYPE "public"."llm_run_kind" OWNER TO "postgres";


CREATE TYPE "public"."llm_run_status" AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
);


ALTER TYPE "public"."llm_run_status" OWNER TO "postgres";


CREATE TYPE "public"."project_role" AS ENUM (
    'member',
    'viewer'
);


ALTER TYPE "public"."project_role" OWNER TO "postgres";


CREATE TYPE "public"."project_visibility" AS ENUM (
    'space',
    'restricted'
);


ALTER TYPE "public"."project_visibility" OWNER TO "postgres";


CREATE TYPE "public"."space_role" AS ENUM (
    'admin',
    'member',
    'viewer'
);


ALTER TYPE "public"."space_role" OWNER TO "postgres";


CREATE TYPE "public"."sync_job_status" AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);


ALTER TYPE "public"."sync_job_status" OWNER TO "postgres";


CREATE TYPE "public"."sync_trigger" AS ENUM (
    'schedule',
    'manual',
    'webhook',
    'backfill'
);


ALTER TYPE "public"."sync_trigger" OWNER TO "postgres";


CREATE TYPE "public"."task_kind" AS ENUM (
    'action',
    'risk',
    'blocker',
    'update',
    'follow_up'
);


ALTER TYPE "public"."task_kind" OWNER TO "postgres";


CREATE TYPE "public"."task_priority" AS ENUM (
    'low',
    'medium',
    'high',
    'urgent'
);


ALTER TYPE "public"."task_priority" OWNER TO "postgres";


CREATE TYPE "public"."task_status" AS ENUM (
    'pending',
    'in_progress',
    'done',
    'dismissed',
    'snoozed'
);


ALTER TYPE "public"."task_status" OWNER TO "postgres";


CREATE TYPE "public"."tenant_role" AS ENUM (
    'owner',
    'billing_admin',
    'member'
);


ALTER TYPE "public"."tenant_role" OWNER TO "postgres";


CREATE TYPE "public"."workspace_role" AS ENUM (
    'admin',
    'member',
    'viewer'
);


ALTER TYPE "public"."workspace_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_invitation"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user uuid := auth.uid();
  v_inv  public.invitations;
begin
  if v_user is null then
    raise exception 'must be signed in to accept an invitation';
  end if;

  select * into v_inv
  from public.invitations
  where token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if v_inv.id is null then
    raise exception 'invitation not found';
  end if;
  if v_inv.revoked_at is not null then
    raise exception 'invitation has been revoked';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invitation has already been accepted';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invitation has expired';
  end if;

  -- Level 1 — always. Every deeper membership FKs to this row, so it must
  -- exist first. An existing row is upgraded only if the invite names a
  -- tenant_role, never downgraded.
  insert into public.tenant_members (tenant_id, user_id, role, invited_by)
  values (v_inv.tenant_id, v_user, coalesce(v_inv.tenant_role, 'member'), v_inv.invited_by)
  on conflict (tenant_id, user_id) do update
    set role = case when v_inv.tenant_role is not null then v_inv.tenant_role
                    else public.tenant_members.role end;

  -- Level 2
  if v_inv.workspace_id is not null and v_inv.workspace_role is not null then
    insert into public.workspace_members (workspace_id, tenant_id, user_id, role, invited_by)
    values (v_inv.workspace_id, v_inv.tenant_id, v_user, v_inv.workspace_role, v_inv.invited_by)
    on conflict (workspace_id, user_id) do update set role = v_inv.workspace_role;
  end if;

  -- Level 3
  if v_inv.client_space_id is not null and v_inv.space_role is not null then
    insert into public.space_members (client_space_id, tenant_id, user_id, role, invited_by)
    values (v_inv.client_space_id, v_inv.tenant_id, v_user, v_inv.space_role, v_inv.invited_by)
    on conflict (client_space_id, user_id) do update set role = v_inv.space_role;
  end if;

  -- Level 4. Requires space standing, which project_members' FK enforces —
  -- so a project-scoped invite MUST also carry a space_role, or this throws.
  -- That is intentional: it surfaces a malformed invite loudly at accept time
  -- rather than granting a partial scope silently.
  if v_inv.project_id is not null then
    insert into public.project_members (project_id, client_space_id, user_id, role, added_by)
    values (v_inv.project_id, v_inv.client_space_id, v_user, v_inv.project_role, v_inv.invited_by)
    on conflict (project_id, user_id) do update set role = v_inv.project_role;
  end if;

  update public.invitations
  set accepted_at = now(), accepted_by = v_user
  where id = v_inv.id;

  return v_inv.id;
end;
$$;


ALTER FUNCTION "public"."accept_invitation"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ack_job"("p_msg_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  update public.job_dispatches
  set status_code = 200, resolved_at = now()
  where msg_id = p_msg_id and resolved_at is null;

  return pgmq.delete('jobs', p_msg_id);
end;
$$;


ALTER FUNCTION "public"."ack_job"("p_msg_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_tenant_and_workspace"("p_name" "text", "p_slug" "text") RETURNS TABLE("tenant_id" "uuid", "workspace_id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_tenant_id    uuid;
  v_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.tenants (name, slug) values (p_name, p_slug)
  returning id into v_tenant_id;

  insert into public.workspaces (tenant_id, name, slug) values (v_tenant_id, p_name, p_slug)
  returning id into v_workspace_id;

  return query select v_tenant_id, v_workspace_id;
end;
$$;


ALTER FUNCTION "public"."create_tenant_and_workspace"("p_name" "text", "p_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_client_space_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select sm.client_space_id from public.space_members sm where sm.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_client_space_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_project_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select p.id
  from public.projects p
  where p.visibility = 'space'
    and p.client_space_id in (select public.current_client_space_ids())
  union
  select pm.project_id
  from public.project_members pm
  where pm.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_project_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_tenant_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select tm.tenant_id from public.tenant_members tm where tm.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."current_tenant_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_workspace_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select wm.workspace_id from public.workspace_members wm where wm.user_id = auth.uid()
  union
  select w.id
  from public.workspaces w
  join public.tenant_members tm on tm.tenant_id = w.tenant_id
  where tm.user_id = auth.uid() and tm.role = 'owner';
$$;


ALTER FUNCTION "public"."current_workspace_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_daily_tick"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."dispatch_daily_tick"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_jobs"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
        -- Vercel would see that as a client disconnect, indistinguishable
        -- from "the job is stuck" — the single most likely cause of jobs
        -- retrying forever if this is ever changed back.
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


ALTER FUNCTION "public"."dispatch_jobs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_job"("p_route" "text", "p_payload" "jsonb", "p_delay_seconds" integer DEFAULT 0) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."enqueue_job"("p_route" "text", "p_payload" "jsonb", "p_delay_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_tenant_membership"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.tenant_members (tenant_id, user_id, role)
  values (new.tenant_id, new.user_id, 'member')
  on conflict (tenant_id, user_id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."ensure_tenant_membership"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_job"("p_msg_id" bigint, "p_attempt" integer, "p_error" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."fail_job"("p_msg_id" bigint, "p_attempt" integer, "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_similar_open_tasks"("p_client_space_id" "uuid", "p_embedding" "public"."vector", "p_limit" integer DEFAULT 5) RETURNS TABLE("task_id" "uuid", "title" "text", "distance" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select t.id, t.title, t.embedding operator(public.<=>) p_embedding as distance
  from public.tasks t
  where t.client_space_id = p_client_space_id
    and t.status in ('pending', 'in_progress')
    and t.embedding is not null
  order by t.embedding operator(public.<=>) p_embedding
  limit p_limit;
$$;


ALTER FUNCTION "public"."find_similar_open_tasks"("p_client_space_id" "uuid", "p_embedding" "public"."vector", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forbid_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception '% is not permitted on %', tg_op, tg_table_name
    using hint = coalesce(tg_argv[0], 'this table is append-only');
  return null;
end;
$$;


ALTER FUNCTION "public"."forbid_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_last_space_admin"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  remaining integer;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;

  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    select count(*) into remaining
    from public.space_members
    where client_space_id = old.client_space_id and role = 'admin' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'client space % must keep at least one admin', old.client_space_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_last_space_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_last_tenant_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  remaining integer;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) into remaining
    from public.tenant_members
    where tenant_id = old.tenant_id and role = 'owner' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'tenant % must keep at least one owner', old.tenant_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_last_tenant_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_last_workspace_admin"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  remaining integer;
begin
  if pg_trigger_depth() > 1 then
    return coalesce(old, new);
  end if;

  if (tg_op = 'DELETE' and old.role = 'admin')
     or (tg_op = 'UPDATE' and old.role = 'admin' and new.role <> 'admin') then
    select count(*) into remaining
    from public.workspace_members
    where workspace_id = old.workspace_id and role = 'admin' and user_id <> old.user_id;
    if remaining = 0 then
      raise exception 'workspace % must keep at least one admin', old.workspace_id;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_last_workspace_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_client_space"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    return new;   -- service-role provisioning with no actor.
  end if;
  insert into public.space_members (client_space_id, tenant_id, user_id, role)
  values (new.id, new.tenant_id, auth.uid(), 'admin')
  on conflict (client_space_id, user_id) do update set role = 'admin';
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_client_space"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_project"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user uuid := coalesce(new.created_by, auth.uid());
begin
  if v_user is null then
    return new;   -- service-role backfill with no actor; nothing to grant.
  end if;

  if exists (
    select 1 from public.space_members sm
    where sm.client_space_id = new.client_space_id and sm.user_id = v_user
  ) then
    insert into public.project_members (project_id, client_space_id, user_id, role, added_by)
    values (new.id, new.client_space_id, v_user, 'member', v_user)
    on conflict (project_id, user_id) do nothing;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_project"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_tenant"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    return new;   -- service-role provisioning with no actor; nothing to grant.
  end if;
  insert into public.tenant_members (tenant_id, user_id, role)
  values (new.id, auth.uid(), 'owner')
  on conflict (tenant_id, user_id) do update set role = 'owner';
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_tenant"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_workspace"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    return new;
  end if;
  insert into public.workspace_members (workspace_id, tenant_id, user_id, role)
  values (new.id, new.tenant_id, auth.uid(), 'admin')
  on conflict (workspace_id, user_id) do update set role = 'admin';
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_workspace"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_space_role"("p_client_space_id" "uuid", "p_roles" "public"."space_role"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.space_members sm
    where sm.client_space_id = p_client_space_id
      and sm.user_id = auth.uid()
      and sm.role = any (p_roles)
  );
$$;


ALTER FUNCTION "public"."has_space_role"("p_client_space_id" "uuid", "p_roles" "public"."space_role"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_tenant_role"("p_tenant_id" "uuid", "p_roles" "public"."tenant_role"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.tenant_members tm
    where tm.tenant_id = p_tenant_id and tm.user_id = auth.uid() and tm.role = any (p_roles)
  );
$$;


ALTER FUNCTION "public"."has_tenant_role"("p_tenant_id" "uuid", "p_roles" "public"."tenant_role"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_workspace_role"("p_workspace_id" "uuid", "p_roles" "public"."workspace_role"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid() and wm.role = any (p_roles)
  ) or exists (
    select 1
    from public.workspaces w
    join public.tenant_members tm on tm.tenant_id = w.tenant_id
    where w.id = p_workspace_id and tm.user_id = auth.uid() and tm.role = 'owner'
  );
$$;


ALTER FUNCTION "public"."has_workspace_role"("p_workspace_id" "uuid", "p_roles" "public"."workspace_role"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manageable_client_space_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select sm.client_space_id
  from public.space_members sm
  where sm.user_id = auth.uid() and sm.role = 'admin'
  union
  select cs.id
  from public.client_spaces cs
  where cs.workspace_id in (
    select wm.workspace_id from public.workspace_members wm
    where wm.user_id = auth.uid() and wm.role = 'admin'
  )
  union
  -- Tenant owners retain authority everywhere beneath them, consistently with
  -- has_workspace_role()'s second arm.
  select cs.id
  from public.client_spaces cs
  join public.tenant_members tm on tm.tenant_id = cs.tenant_id
  where tm.user_id = auth.uid() and tm.role = 'owner';
$$;


ALTER FUNCTION "public"."manageable_client_space_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."manageable_project_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
  select p.id
  from public.projects p
  where p.client_space_id in (select public.manageable_client_space_ids())
  union
  select pm.project_id
  from public.project_members pm
  where pm.user_id = auth.uid() and pm.role = 'member';
$$;


ALTER FUNCTION "public"."manageable_project_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_event_attachments"("p_older_than_days" integer DEFAULT 90) RETURNS TABLE("deleted_rows" integer, "deleted_objects" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cutoff timestamptz := now() - (p_older_than_days || ' days')::interval;
  v_deleted_rows int;
  v_deleted_objects int;
begin
  with doomed as (
    select id, storage_path from public.event_attachments where created_at < v_cutoff
  ),
  objects_deleted as (
    delete from storage.objects
    where bucket_id = 'attachments'
      and name in (select storage_path from doomed where storage_path is not null)
    returning 1
  )
  select count(*) into v_deleted_objects from objects_deleted;

  delete from public.event_attachments where created_at < v_cutoff;
  get diagnostics v_deleted_rows = row_count;

  return query select v_deleted_rows, v_deleted_objects;
end;
$$;


ALTER FUNCTION "public"."prune_event_attachments"("p_older_than_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reap_job_dispatches"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."reap_job_dispatches"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_project_connector_provider"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_provider public.connector_provider;
begin
  select sc.provider into v_provider
  from public.space_connections sc
  where sc.id = new.connection_id;

  if v_provider is null then
    raise exception 'space_connection % not found', new.connection_id;
  end if;

  new.provider := v_provider;
  return new;
end;
$$;


ALTER FUNCTION "public"."sync_project_connector_provider"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "workspace_id" "uuid",
    "client_space_id" "uuid",
    "project_id" "uuid",
    "actor_user_id" "uuid",
    "actor_type" "text" DEFAULT 'user'::"text" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text",
    "target_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "audit_logs_action_check" CHECK (("action" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'::"text")),
    CONSTRAINT "audit_logs_actor_type_check" CHECK (("actor_type" = ANY (ARRAY['user'::"text", 'system'::"text", 'service'::"text"]))),
    CONSTRAINT "audit_logs_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text"))
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."client_spaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "timezone" "text" DEFAULT 'UTC'::"text" NOT NULL,
    "context_profile" "text",
    "archived_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "client_spaces_context_profile_check" CHECK ((("context_profile" IS NULL) OR ("length"("context_profile") <= 4000))),
    CONSTRAINT "client_spaces_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 160))),
    CONSTRAINT "client_spaces_slug_check" CHECK (("slug" ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'::"text"))
);


ALTER TABLE "public"."client_spaces" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."context_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "source" "text" NOT NULL,
    "external_ref" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "storage_path" "text",
    "mime_type" "text",
    "extracted_text" "text",
    "extraction_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "extraction_error" "text",
    "archived_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "context_documents_external_ref_check" CHECK (("jsonb_typeof"("external_ref") = 'object'::"text")),
    CONSTRAINT "context_documents_extraction_status_check" CHECK (("extraction_status" = ANY (ARRAY['pending'::"text", 'extracted'::"text", 'skipped'::"text", 'failed'::"text"]))),
    CONSTRAINT "context_documents_kind_check" CHECK (("kind" = ANY (ARRAY['business_context'::"text", 'prd'::"text", 'meeting_notes'::"text", 'glossary'::"text"]))),
    CONSTRAINT "context_documents_source_check" CHECK (("source" = ANY (ARRAY['upload'::"text", 'google_doc'::"text", 'pasted'::"text"]))),
    CONSTRAINT "context_documents_title_check" CHECK ((("length"("btrim"("title")) >= 1) AND ("length"("btrim"("title")) <= 300)))
);


ALTER TABLE "public"."context_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."daily_summaries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "summary_date" "date" NOT NULL,
    "headline" "text",
    "summary" "text" NOT NULL,
    "highlights" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metrics" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "llm_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "daily_summaries_highlights_check" CHECK (("jsonb_typeof"("highlights") = 'array'::"text")),
    CONSTRAINT "daily_summaries_metrics_check" CHECK (("jsonb_typeof"("metrics") = 'object'::"text"))
);


ALTER TABLE "public"."daily_summaries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."event_attachments" (
    "id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "normalized_event_id" "uuid" NOT NULL,
    "provider" "public"."connector_provider" NOT NULL,
    "provider_attachment_id" "text" NOT NULL,
    "filename" "text",
    "mime_type" "text",
    "size_bytes" bigint,
    "download_ref" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "skip_reason" "text",
    "extracted_text" "text",
    "extracted_chars" integer,
    "text_truncated" boolean DEFAULT false NOT NULL,
    "storage_path" "text",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "project_connector_id" "uuid" NOT NULL,
    CONSTRAINT "event_attachments_download_ref_check" CHECK (("jsonb_typeof"("download_ref") = 'object'::"text")),
    CONSTRAINT "event_attachments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'extracted'::"text", 'skipped'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."event_attachments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."event_attachments"."download_ref" IS 'Provider-specific download handle, opaque to the DB. Slack: {"url_private_download":"..."}. Gmail: {"messageId":"...","attachmentId":"..."}. Google Chat: {"kind":"chat_media","resourceName":"..."}. App-layer validated.';



CREATE TABLE IF NOT EXISTS "public"."invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "workspace_id" "uuid",
    "client_space_id" "uuid",
    "project_id" "uuid",
    "email" "extensions"."citext" NOT NULL,
    "tenant_role" "public"."tenant_role",
    "workspace_role" "public"."workspace_role",
    "space_role" "public"."space_role",
    "project_role" "public"."project_role",
    "token_hash" "bytea" NOT NULL,
    "invited_by" "uuid",
    "accepted_by" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "accepted_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "invitations_email_check" CHECK ((("email")::"text" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::"text")),
    CONSTRAINT "invitations_expires_after_creation_chk" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "invitations_grants_something_chk" CHECK ((("tenant_role" IS NOT NULL) OR ("workspace_role" IS NOT NULL) OR ("space_role" IS NOT NULL) OR ("project_role" IS NOT NULL))),
    CONSTRAINT "invitations_role_depth_chk" CHECK (((("workspace_role" IS NULL) OR ("workspace_id" IS NOT NULL)) AND (("space_role" IS NULL) OR ("client_space_id" IS NOT NULL)) AND (("project_role" IS NULL) OR ("project_id" IS NOT NULL)))),
    CONSTRAINT "invitations_scope_chain_chk" CHECK (((("project_id" IS NULL) OR ("client_space_id" IS NOT NULL)) AND (("client_space_id" IS NULL) OR ("workspace_id" IS NOT NULL))))
);


ALTER TABLE "public"."invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."job_dispatches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "msg_id" bigint NOT NULL,
    "route" "text" NOT NULL,
    "attempt" integer NOT NULL,
    "request_id" bigint,
    "status_code" integer,
    "error" "text",
    "dispatched_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."job_dispatches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."llm_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "kind" "public"."llm_run_kind" NOT NULL,
    "status" "public"."llm_run_status" DEFAULT 'queued'::"public"."llm_run_status" NOT NULL,
    "model" "text" NOT NULL,
    "provider" "text" DEFAULT 'anthropic'::"text" NOT NULL,
    "prompt_version" "text" NOT NULL,
    "prompt" "jsonb",
    "response" "jsonb",
    "prompt_tokens" integer,
    "completion_tokens" integer,
    "cache_read_tokens" integer,
    "cache_creation_tokens" integer,
    "cost_usd" numeric(10,6),
    "latency_ms" integer,
    "error_message" "text",
    "idempotency_key" "text",
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."llm_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."normalized_events" (
    "id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "project_connector_id" "uuid" NOT NULL,
    "raw_event_id" "uuid",
    "provider" "public"."connector_provider" NOT NULL,
    "type" "text" NOT NULL,
    "actor" "text",
    "actor_display" "text",
    "actor_email" "extensions"."citext",
    "resource" "text",
    "resource_type" "text",
    "resource_url" "text",
    "title" "text",
    "body" "text",
    "occurred_at" timestamp with time zone NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "dedupe_key" "text" NOT NULL,
    "deleted_upstream_at" timestamp with time zone,
    "superseded_by" "uuid",
    "processed_at" timestamp with time zone,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "normalized_events_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "normalized_events_type_check" CHECK (("type" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'::"text"))
);


ALTER TABLE "public"."normalized_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."normalized_events"."metadata" IS 'Provider-specific long tail not hoisted into a column, plus `service` ("gmail"|"drive"|"chat") for the merged google connector — since provider is written verbatim as ''google'' for all three, that tag is the only thing distinguishing them. Do not drop it.';



CREATE TABLE IF NOT EXISTS "public"."project_connector_cursors" (
    "project_connector_id" "uuid" NOT NULL,
    "scope_key" "text" DEFAULT 'default'::"text" NOT NULL,
    "cursor" "jsonb" NOT NULL,
    "last_advanced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_connector_cursors" OWNER TO "postgres";


COMMENT ON COLUMN "public"."project_connector_cursors"."cursor" IS 'Provider-specific resume position. Slack: {"provider":"slack","oldestTs":"..."}. Google: {"provider":"google","gmail":{...},"drive":{...},"chat":{...}}. Validated at the app layer with a Zod discriminated union.';



CREATE TABLE IF NOT EXISTS "public"."project_connectors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "provider" "public"."connector_provider" NOT NULL,
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "sync_enabled" boolean DEFAULT true NOT NULL,
    "sync_interval_seconds" integer DEFAULT 900 NOT NULL,
    "next_sync_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sync_started_at" timestamp with time zone,
    "last_sync_succeeded_at" timestamp with time zone,
    "last_error" "text",
    "consecutive_failures" smallint DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "project_connectors_config_check" CHECK (("jsonb_typeof"("config") = 'object'::"text")),
    CONSTRAINT "project_connectors_sync_interval_seconds_check" CHECK ((("sync_interval_seconds" >= 60) AND ("sync_interval_seconds" <= 86400)))
);


ALTER TABLE "public"."project_connectors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."project_members" (
    "project_id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."project_role",
    "added_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "visibility" "public"."project_visibility" DEFAULT 'space'::"public"."project_visibility" NOT NULL,
    "archived_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "projects_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 160))),
    CONSTRAINT "projects_slug_check" CHECK (("slug" ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'::"text")),
    CONSTRAINT "projects_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."raw_events" (
    "id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "project_connector_id" "uuid" NOT NULL,
    "sync_job_id" "uuid",
    "provider" "public"."connector_provider" NOT NULL,
    "provider_event_id" "text",
    "payload" "jsonb" NOT NULL,
    "payload_hash" "bytea",
    "occurred_at" timestamp with time zone,
    "ingested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."raw_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."search_chunks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "source_kind" "public"."chunk_source" NOT NULL,
    "source_id" "uuid" NOT NULL,
    "chunk_index" smallint DEFAULT 0 NOT NULL,
    "provider" "public"."connector_provider",
    "occurred_at" timestamp with time zone NOT NULL,
    "title" "text",
    "content" "text" NOT NULL,
    "source_url" "text",
    "fts" "tsvector" GENERATED ALWAYS AS (("setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("title", ''::"text")), 'A'::"char") || "setweight"("to_tsvector"('"english"'::"regconfig", COALESCE("content", ''::"text")), 'B'::"char"))) STORED,
    "embedding" "public"."vector"(384),
    "embedding_model" "text",
    "embed_status" "public"."embed_status" DEFAULT 'pending'::"public"."embed_status" NOT NULL,
    "embed_attempts" smallint DEFAULT 0 NOT NULL,
    "embed_error" "text",
    "embedded_at" timestamp with time zone,
    "content_hash" "bytea" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "search_chunks_embedded_has_model_chk" CHECK ((("embed_status" <> 'embedded'::"public"."embed_status") OR (("embedding" IS NOT NULL) AND ("embedding_model" IS NOT NULL))))
);


ALTER TABLE "public"."search_chunks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."space_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "provider" "public"."connector_provider" NOT NULL,
    "auth_mode" "public"."connector_auth_mode" NOT NULL,
    "nango_connection_id" "text",
    "nango_provider_config_key" "text",
    "secret_ciphertext" "bytea",
    "secret_iv" "bytea",
    "secret_key_version" smallint,
    "secret_rotated_at" timestamp with time zone,
    "external_account_id" "text" NOT NULL,
    "external_account_label" "text",
    "account_domain" "text",
    "config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "public"."integration_status" DEFAULT 'pending'::"public"."integration_status" NOT NULL,
    "last_validated_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "connected_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "space_connections_auth_mode_chk" CHECK (((("auth_mode" = 'nango'::"public"."connector_auth_mode") AND ("nango_connection_id" IS NOT NULL) AND ("nango_provider_config_key" IS NOT NULL) AND ("secret_ciphertext" IS NULL)) OR (("auth_mode" = 'api_key'::"public"."connector_auth_mode") AND ("secret_ciphertext" IS NOT NULL) AND ("secret_iv" IS NOT NULL) AND ("secret_key_version" IS NOT NULL) AND ("nango_connection_id" IS NULL)) OR (("auth_mode" = 'none'::"public"."connector_auth_mode") AND ("nango_connection_id" IS NULL) AND ("nango_provider_config_key" IS NULL) AND ("secret_ciphertext" IS NULL) AND ("secret_iv" IS NULL) AND ("secret_key_version" IS NULL)))),
    CONSTRAINT "space_connections_config_check" CHECK (("jsonb_typeof"("config") = 'object'::"text"))
);


ALTER TABLE "public"."space_connections" OWNER TO "postgres";


COMMENT ON COLUMN "public"."space_connections"."auth_mode" IS 'nango   - Nango holds token custody; nango_connection_id identifies it. api_key - a locally-sealed AES-256-GCM secret, for providers with no OAuth           dance (Supabase, OpenAI Codex). none    - no credential at all. The mock connector, which is load-bearing           for tests and local dev without live OAuth.';



COMMENT ON COLUMN "public"."space_connections"."nango_provider_config_key" IS 'The Nango integration id this connection belongs to (e.g. "google", "slack") — distinct from connector_provider, since one Nango integration can back a provider value covering several sub-services.';



CREATE TABLE IF NOT EXISTS "public"."space_members" (
    "client_space_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."space_role" DEFAULT 'member'::"public"."space_role" NOT NULL,
    "invited_by" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."space_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_batch_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "project_connector_id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "completed_at" timestamp with time zone,
    "outcome" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sync_batch_members_outcome_check" CHECK ((("outcome" IS NULL) OR ("outcome" = ANY (ARRAY['succeeded'::"text", 'failed'::"text", 'skipped'::"text"]))))
);


ALTER TABLE "public"."sync_batch_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "batch_date" "date" NOT NULL,
    "llm_triggered_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sync_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "project_connector_id" "uuid" NOT NULL,
    "status" "public"."sync_job_status" DEFAULT 'queued'::"public"."sync_job_status" NOT NULL,
    "trigger" "public"."sync_trigger" DEFAULT 'schedule'::"public"."sync_trigger" NOT NULL,
    "attempt" smallint DEFAULT 1 NOT NULL,
    "max_attempts" smallint DEFAULT 5 NOT NULL,
    "scheduled_for" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "duration_ms" integer GENERATED ALWAYS AS (((EXTRACT(epoch FROM ("finished_at" - "started_at")) * (1000)::numeric))::integer) STORED,
    "events_fetched" integer DEFAULT 0 NOT NULL,
    "events_written" integer DEFAULT 0 NOT NULL,
    "error_code" "text",
    "error_message" "text",
    "idempotency_key" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sync_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."task_sources" (
    "task_id" "uuid" NOT NULL,
    "normalized_event_id" "uuid" NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "chunk_id" "uuid",
    "role" "text" DEFAULT 'mentioned'::"text" NOT NULL,
    "relevance" numeric(4,3),
    "llm_run_id" "uuid",
    "linked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "task_sources_relevance_check" CHECK ((("relevance" IS NULL) OR (("relevance" >= (0)::numeric) AND ("relevance" <= (1)::numeric)))),
    CONSTRAINT "task_sources_role_check" CHECK (("role" = ANY (ARRAY['created_from'::"text", 'enriched'::"text", 'mentioned'::"text"])))
);


ALTER TABLE "public"."task_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "client_space_id" "uuid" NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "llm_run_id" "uuid",
    "kind" "public"."task_kind" DEFAULT 'action'::"public"."task_kind" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "priority" "public"."task_priority" DEFAULT 'medium'::"public"."task_priority" NOT NULL,
    "status" "public"."task_status" DEFAULT 'pending'::"public"."task_status" NOT NULL,
    "confidence" numeric(4,3) NOT NULL,
    "for_date" "date" NOT NULL,
    "due_at" timestamp with time zone,
    "owner_hint" "text",
    "assignee_id" "uuid",
    "assignee_team_member_id" "uuid",
    "embedding" "public"."vector"(384),
    "embedding_model" "text",
    "embedding_src_hash" "bytea",
    "dedupe_hash" "text" NOT NULL,
    "superseded_by" "uuid",
    "resolved_at" timestamp with time zone,
    "snoozed_until" timestamp with time zone,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tasks_confidence_check" CHECK ((("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric))),
    CONSTRAINT "tasks_embedded_has_model_chk" CHECK ((("embedding" IS NULL) OR ("embedding_model" IS NOT NULL))),
    CONSTRAINT "tasks_single_assignee_chk" CHECK ((("assignee_id" IS NULL) OR ("assignee_team_member_id" IS NULL))),
    CONSTRAINT "tasks_title_check" CHECK ((("length"("btrim"("title")) >= 1) AND ("length"("btrim"("title")) <= 300)))
);


ALTER TABLE "public"."tasks" OWNER TO "postgres";


COMMENT ON COLUMN "public"."tasks"."assignee_team_member_id" IS 'A team_members roster contact assigned to this task — mutually exclusive with assignee_id (see tasks_single_assignee_chk). A roster contact has no login, so there is no "my tasks" access path for this column and deliberately no index mirroring tasks_assignee_open_idx.';



CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workspace_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "extensions"."citext" NOT NULL,
    "role" "text",
    "description" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "team_members_description_check" CHECK ((("description" IS NULL) OR ("length"("description") <= 2000))),
    CONSTRAINT "team_members_email_check" CHECK ((("email")::"text" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::"text")),
    CONSTRAINT "team_members_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 160))),
    CONSTRAINT "team_members_role_check" CHECK ((("role" IS NULL) OR ("length"("btrim"("role")) <= 160)))
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_members" (
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."tenant_role" DEFAULT 'member'::"public"."tenant_role" NOT NULL,
    "invited_by" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tenant_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "stripe_customer_id" "text",
    "stripe_subscription_id" "text",
    "plan" "text" DEFAULT 'trial'::"text" NOT NULL,
    "status" "text" DEFAULT 'trialing'::"text" NOT NULL,
    "seats" integer,
    "max_workspaces" integer,
    "max_client_spaces" integer,
    "max_projects" integer,
    "trial_ends_at" timestamp with time zone,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tenant_subscriptions_max_client_spaces_check" CHECK ((("max_client_spaces" IS NULL) OR ("max_client_spaces" > 0))),
    CONSTRAINT "tenant_subscriptions_max_projects_check" CHECK ((("max_projects" IS NULL) OR ("max_projects" > 0))),
    CONSTRAINT "tenant_subscriptions_max_workspaces_check" CHECK ((("max_workspaces" IS NULL) OR ("max_workspaces" > 0))),
    CONSTRAINT "tenant_subscriptions_plan_check" CHECK (("plan" ~ '^[a-z][a-z0-9_]{1,40}$'::"text")),
    CONSTRAINT "tenant_subscriptions_seats_check" CHECK ((("seats" IS NULL) OR ("seats" > 0))),
    CONSTRAINT "tenant_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['trialing'::"text", 'active'::"text", 'past_due'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tenant_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "domain" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tenants_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 160))),
    CONSTRAINT "tenants_settings_check" CHECK (("jsonb_typeof"("settings") = 'object'::"text")),
    CONSTRAINT "tenants_slug_check" CHECK (("slug" ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'::"text")),
    CONSTRAINT "tenants_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'suspended'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tenants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "email" "extensions"."citext" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspace_members" (
    "workspace_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."workspace_role" DEFAULT 'member'::"public"."workspace_role" NOT NULL,
    "invited_by" "uuid",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."workspace_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."workspaces" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "description" "text",
    "logo_path" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workspaces_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 120))),
    CONSTRAINT "workspaces_slug_check" CHECK (("slug" ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'::"text"))
);


ALTER TABLE "public"."workspaces" OWNER TO "postgres";


ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_id_tenant_id_key" UNIQUE ("id", "tenant_id");



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_id_workspace_id_key" UNIQUE ("id", "workspace_id");



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_workspace_id_slug_key" UNIQUE ("workspace_id", "slug");



ALTER TABLE ONLY "public"."context_documents"
    ADD CONSTRAINT "context_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_summaries"
    ADD CONSTRAINT "daily_summaries_client_space_id_summary_date_key" UNIQUE ("client_space_id", "summary_date");



ALTER TABLE ONLY "public"."daily_summaries"
    ADD CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."event_attachments"
    ADD CONSTRAINT "event_attachments_normalized_event_id_provider_attachment_i_key" UNIQUE ("normalized_event_id", "provider_attachment_id");



ALTER TABLE ONLY "public"."event_attachments"
    ADD CONSTRAINT "event_attachments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."job_dispatches"
    ADD CONSTRAINT "job_dispatches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_id_client_space_id_key" UNIQUE ("id", "client_space_id");



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."normalized_events"
    ADD CONSTRAINT "normalized_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."normalized_events"
    ADD CONSTRAINT "normalized_events_project_connector_id_dedupe_key_key" UNIQUE ("project_connector_id", "dedupe_key");



ALTER TABLE ONLY "public"."project_connector_cursors"
    ADD CONSTRAINT "project_connector_cursors_pkey" PRIMARY KEY ("project_connector_id", "scope_key");



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_id_client_space_id_key" UNIQUE ("id", "client_space_id");



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_id_project_id_client_space_id_key" UNIQUE ("id", "project_id", "client_space_id");



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_project_id_connection_id_key" UNIQUE ("project_id", "connection_id");



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_client_space_id_slug_key" UNIQUE ("client_space_id", "slug");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_id_client_space_id_key" UNIQUE ("id", "client_space_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_id_workspace_id_key" UNIQUE ("id", "workspace_id");



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."raw_events"
    ADD CONSTRAINT "raw_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."search_chunks"
    ADD CONSTRAINT "search_chunks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."search_chunks"
    ADD CONSTRAINT "search_chunks_source_kind_source_id_chunk_index_key" UNIQUE ("source_kind", "source_id", "chunk_index");



ALTER TABLE ONLY "public"."space_connections"
    ADD CONSTRAINT "space_connections_client_space_id_provider_external_account_key" UNIQUE ("client_space_id", "provider", "external_account_id");



ALTER TABLE ONLY "public"."space_connections"
    ADD CONSTRAINT "space_connections_id_client_space_id_key" UNIQUE ("id", "client_space_id");



ALTER TABLE ONLY "public"."space_connections"
    ADD CONSTRAINT "space_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."space_members"
    ADD CONSTRAINT "space_members_pkey" PRIMARY KEY ("client_space_id", "user_id");



ALTER TABLE ONLY "public"."sync_batch_members"
    ADD CONSTRAINT "sync_batch_members_batch_id_project_connector_id_key" UNIQUE ("batch_id", "project_connector_id");



ALTER TABLE ONLY "public"."sync_batch_members"
    ADD CONSTRAINT "sync_batch_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_batches"
    ADD CONSTRAINT "sync_batches_client_space_id_batch_date_key" UNIQUE ("client_space_id", "batch_date");



ALTER TABLE ONLY "public"."sync_batches"
    ADD CONSTRAINT "sync_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_jobs"
    ADD CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_pkey" PRIMARY KEY ("task_id", "normalized_event_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_id_workspace_id_key" UNIQUE ("id", "workspace_id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_workspace_id_email_key" UNIQUE ("workspace_id", "email");



ALTER TABLE ONLY "public"."tenant_members"
    ADD CONSTRAINT "tenant_members_pkey" PRIMARY KEY ("tenant_id", "user_id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id", "user_id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_id_tenant_id_key" UNIQUE ("id", "tenant_id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_tenant_id_slug_key" UNIQUE ("tenant_id", "slug");



CREATE INDEX "audit_logs_actor_idx" ON "public"."audit_logs" USING "btree" ("actor_user_id", "created_at" DESC) WHERE ("actor_user_id" IS NOT NULL);



CREATE INDEX "audit_logs_target_idx" ON "public"."audit_logs" USING "btree" ("target_type", "target_id");



CREATE INDEX "audit_logs_tenant_recent_idx" ON "public"."audit_logs" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "client_spaces_workspace_idx" ON "public"."client_spaces" USING "btree" ("workspace_id") WHERE ("archived_at" IS NULL);



CREATE UNIQUE INDEX "context_documents_live_source_uniq" ON "public"."context_documents" USING "btree" ("client_space_id", "project_id", "external_ref") NULLS NOT DISTINCT WHERE (("archived_at" IS NULL) AND ("external_ref" <> '{}'::"jsonb"));



CREATE INDEX "context_documents_pending_idx" ON "public"."context_documents" USING "btree" ("client_space_id", "created_at") WHERE ("extraction_status" = 'pending'::"text");



CREATE INDEX "context_documents_space_idx" ON "public"."context_documents" USING "btree" ("client_space_id", "kind") WHERE ("archived_at" IS NULL);



CREATE INDEX "daily_summaries_cs_date_idx" ON "public"."daily_summaries" USING "btree" ("client_space_id", "summary_date" DESC);



CREATE INDEX "event_attachments_event_idx" ON "public"."event_attachments" USING "btree" ("normalized_event_id") WHERE ("status" = 'extracted'::"text");



CREATE INDEX "event_attachments_pending_idx" ON "public"."event_attachments" USING "btree" ("project_connector_id", "created_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "invitations_email_idx" ON "public"."invitations" USING "btree" ("email") WHERE (("accepted_at" IS NULL) AND ("revoked_at" IS NULL));



CREATE INDEX "invitations_expiry_idx" ON "public"."invitations" USING "btree" ("expires_at") WHERE (("accepted_at" IS NULL) AND ("revoked_at" IS NULL));



CREATE UNIQUE INDEX "invitations_pending_uniq" ON "public"."invitations" USING "btree" ("tenant_id", "email", "workspace_id", "client_space_id", "project_id") NULLS NOT DISTINCT WHERE (("accepted_at" IS NULL) AND ("revoked_at" IS NULL));



CREATE INDEX "invitations_tenant_idx" ON "public"."invitations" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "job_dispatches_msg_id_idx" ON "public"."job_dispatches" USING "btree" ("msg_id");



CREATE INDEX "job_dispatches_request_id_idx" ON "public"."job_dispatches" USING "btree" ("request_id") WHERE ("resolved_at" IS NULL);



CREATE INDEX "llm_runs_cs_recent_idx" ON "public"."llm_runs" USING "btree" ("client_space_id", "created_at" DESC);



CREATE UNIQUE INDEX "llm_runs_idempotency_uniq" ON "public"."llm_runs" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "llm_runs_tenant_metering_idx" ON "public"."llm_runs" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "normalized_events_cs_recent_idx" ON "public"."normalized_events" USING "btree" ("client_space_id", "occurred_at" DESC, "id" DESC) WHERE ("deleted_upstream_at" IS NULL);



CREATE INDEX "normalized_events_project_recent_idx" ON "public"."normalized_events" USING "btree" ("project_id", "occurred_at" DESC, "id" DESC) WHERE ("deleted_upstream_at" IS NULL);



CREATE INDEX "normalized_events_unprocessed_idx" ON "public"."normalized_events" USING "btree" ("client_space_id", "occurred_at") WHERE (("processed_at" IS NULL) AND ("deleted_upstream_at" IS NULL));



CREATE INDEX "project_connectors_connection_idx" ON "public"."project_connectors" USING "btree" ("connection_id");



CREATE INDEX "project_connectors_due_for_sync_idx" ON "public"."project_connectors" USING "btree" ("next_sync_at") WHERE ("enabled" AND "sync_enabled");



CREATE INDEX "project_connectors_project_idx" ON "public"."project_connectors" USING "btree" ("project_id", "provider");



CREATE INDEX "project_members_user_idx" ON "public"."project_members" USING "btree" ("user_id", "project_id");



CREATE INDEX "projects_client_space_status_idx" ON "public"."projects" USING "btree" ("client_space_id", "status");



CREATE INDEX "projects_restricted_idx" ON "public"."projects" USING "btree" ("client_space_id") WHERE ("visibility" = 'restricted'::"public"."project_visibility");



CREATE UNIQUE INDEX "raw_events_hash_uniq" ON "public"."raw_events" USING "btree" ("project_connector_id", "payload_hash") WHERE (("provider_event_id" IS NULL) AND ("payload_hash" IS NOT NULL));



CREATE UNIQUE INDEX "raw_events_provider_event_uniq" ON "public"."raw_events" USING "btree" ("project_connector_id", "provider_event_id") WHERE ("provider_event_id" IS NOT NULL);



CREATE INDEX "raw_events_retention_idx" ON "public"."raw_events" USING "btree" ("ingested_at");



CREATE INDEX "search_chunks_embed_queue_idx" ON "public"."search_chunks" USING "btree" ("client_space_id", "created_at") WHERE ("embed_status" = 'pending'::"public"."embed_status");



CREATE INDEX "search_chunks_embedding_idx" ON "public"."search_chunks" USING "hnsw" ("embedding" "public"."vector_cosine_ops");



CREATE INDEX "search_chunks_fts_idx" ON "public"."search_chunks" USING "gin" ("fts");



CREATE INDEX "search_chunks_source_idx" ON "public"."search_chunks" USING "btree" ("source_kind", "source_id");



CREATE INDEX "search_chunks_space_time_idx" ON "public"."search_chunks" USING "btree" ("client_space_id", "occurred_at" DESC);



CREATE UNIQUE INDEX "space_connections_nango_connection_id_idx" ON "public"."space_connections" USING "btree" ("nango_connection_id") WHERE ("nango_connection_id" IS NOT NULL);



CREATE INDEX "space_connections_space_provider_idx" ON "public"."space_connections" USING "btree" ("client_space_id", "provider");



CREATE INDEX "space_members_user_id_idx" ON "public"."space_members" USING "btree" ("user_id", "client_space_id");



CREATE INDEX "sync_batch_members_pending_idx" ON "public"."sync_batch_members" USING "btree" ("batch_id") WHERE ("completed_at" IS NULL);



CREATE INDEX "sync_batches_space_date_idx" ON "public"."sync_batches" USING "btree" ("client_space_id", "batch_date" DESC);



CREATE INDEX "sync_jobs_connector_recent_idx" ON "public"."sync_jobs" USING "btree" ("project_connector_id", "created_at" DESC);



CREATE UNIQUE INDEX "sync_jobs_idempotency_uniq" ON "public"."sync_jobs" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE UNIQUE INDEX "sync_jobs_one_active_per_connector" ON "public"."sync_jobs" USING "btree" ("project_connector_id") WHERE ("status" = ANY (ARRAY['queued'::"public"."sync_job_status", 'running'::"public"."sync_job_status"]));



CREATE INDEX "task_sources_event_idx" ON "public"."task_sources" USING "btree" ("normalized_event_id");



CREATE INDEX "task_sources_timeline_idx" ON "public"."task_sources" USING "btree" ("task_id", "role", "linked_at");



CREATE INDEX "tasks_assignee_open_idx" ON "public"."tasks" USING "btree" ("assignee_id", "for_date" DESC) WHERE (("status" = ANY (ARRAY['pending'::"public"."task_status", 'in_progress'::"public"."task_status"])) AND ("assignee_id" IS NOT NULL));



CREATE INDEX "tasks_board_idx" ON "public"."tasks" USING "btree" ("client_space_id", "for_date" DESC, "priority" DESC) WHERE ("status" = ANY (ARRAY['pending'::"public"."task_status", 'in_progress'::"public"."task_status"]));



CREATE INDEX "tasks_embedding_idx" ON "public"."tasks" USING "hnsw" ("embedding" "public"."vector_cosine_ops") WHERE ("status" = ANY (ARRAY['pending'::"public"."task_status", 'in_progress'::"public"."task_status"]));



CREATE UNIQUE INDEX "tasks_open_dedupe_uniq" ON "public"."tasks" USING "btree" ("client_space_id", "dedupe_hash") WHERE ("status" = ANY (ARRAY['pending'::"public"."task_status", 'in_progress'::"public"."task_status"]));



CREATE INDEX "tasks_project_open_idx" ON "public"."tasks" USING "btree" ("project_id", "for_date" DESC) WHERE (("status" = ANY (ARRAY['pending'::"public"."task_status", 'in_progress'::"public"."task_status"])) AND ("project_id" IS NOT NULL));



CREATE INDEX "tasks_snoozed_idx" ON "public"."tasks" USING "btree" ("snoozed_until") WHERE ("status" = 'snoozed'::"public"."task_status");



CREATE INDEX "team_members_workspace_id_name_idx" ON "public"."team_members" USING "btree" ("workspace_id", "name");



CREATE INDEX "tenant_members_user_id_idx" ON "public"."tenant_members" USING "btree" ("user_id", "tenant_id");



CREATE INDEX "workspace_members_user_id_idx" ON "public"."workspace_members" USING "btree" ("user_id", "workspace_id");



CREATE INDEX "workspaces_tenant_id_idx" ON "public"."workspaces" USING "btree" ("tenant_id");



CREATE OR REPLACE TRIGGER "trg_audit_logs_no_delete" BEFORE DELETE ON "public"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_mutation"('audit_logs is append-only');



CREATE OR REPLACE TRIGGER "trg_audit_logs_no_update" BEFORE UPDATE ON "public"."audit_logs" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_mutation"('audit_logs is append-only');



CREATE OR REPLACE TRIGGER "trg_client_spaces_updated_at" BEFORE UPDATE ON "public"."client_spaces" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_context_documents_updated_at" BEFORE UPDATE ON "public"."context_documents" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_daily_summaries_updated_at" BEFORE UPDATE ON "public"."daily_summaries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_event_attachments_updated_at" BEFORE UPDATE ON "public"."event_attachments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_guard_last_space_admin" BEFORE DELETE OR UPDATE ON "public"."space_members" FOR EACH ROW EXECUTE FUNCTION "public"."guard_last_space_admin"();



CREATE OR REPLACE TRIGGER "trg_guard_last_tenant_owner" BEFORE DELETE OR UPDATE ON "public"."tenant_members" FOR EACH ROW EXECUTE FUNCTION "public"."guard_last_tenant_owner"();



CREATE OR REPLACE TRIGGER "trg_guard_last_workspace_admin" BEFORE DELETE OR UPDATE ON "public"."workspace_members" FOR EACH ROW EXECUTE FUNCTION "public"."guard_last_workspace_admin"();



CREATE OR REPLACE TRIGGER "trg_invitations_updated_at" BEFORE UPDATE ON "public"."invitations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_llm_runs_updated_at" BEFORE UPDATE ON "public"."llm_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_on_client_space_created" AFTER INSERT ON "public"."client_spaces" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_client_space"();



CREATE OR REPLACE TRIGGER "trg_on_project_created" AFTER INSERT ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_project"();



CREATE OR REPLACE TRIGGER "trg_on_tenant_created" AFTER INSERT ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_tenant"();



CREATE OR REPLACE TRIGGER "trg_on_workspace_created" AFTER INSERT ON "public"."workspaces" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_workspace"();



CREATE OR REPLACE TRIGGER "trg_project_connector_cursors_updated_at" BEFORE UPDATE ON "public"."project_connector_cursors" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_project_connectors_sync_provider" BEFORE INSERT OR UPDATE OF "connection_id" ON "public"."project_connectors" FOR EACH ROW EXECUTE FUNCTION "public"."sync_project_connector_provider"();



CREATE OR REPLACE TRIGGER "trg_project_connectors_updated_at" BEFORE UPDATE ON "public"."project_connectors" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_project_members_updated_at" BEFORE UPDATE ON "public"."project_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_projects_updated_at" BEFORE UPDATE ON "public"."projects" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_search_chunks_updated_at" BEFORE UPDATE ON "public"."search_chunks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_space_connections_updated_at" BEFORE UPDATE ON "public"."space_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_space_members_ensure_roster" BEFORE INSERT ON "public"."space_members" FOR EACH ROW EXECUTE FUNCTION "public"."ensure_tenant_membership"();



CREATE OR REPLACE TRIGGER "trg_space_members_updated_at" BEFORE UPDATE ON "public"."space_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_jobs_updated_at" BEFORE UPDATE ON "public"."sync_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tasks_updated_at" BEFORE UPDATE ON "public"."tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_team_members_updated_at" BEFORE UPDATE ON "public"."team_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_members_updated_at" BEFORE UPDATE ON "public"."tenant_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_subscriptions_updated_at" BEFORE UPDATE ON "public"."tenant_subscriptions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenants_updated_at" BEFORE UPDATE ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_users_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_workspace_members_ensure_roster" BEFORE INSERT ON "public"."workspace_members" FOR EACH ROW EXECUTE FUNCTION "public"."ensure_tenant_membership"();



CREATE OR REPLACE TRIGGER "trg_workspace_members_updated_at" BEFORE UPDATE ON "public"."workspace_members" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_workspaces_updated_at" BEFORE UPDATE ON "public"."workspaces" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."client_spaces"
    ADD CONSTRAINT "client_spaces_workspace_id_tenant_id_fkey" FOREIGN KEY ("workspace_id", "tenant_id") REFERENCES "public"."workspaces"("id", "tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_documents"
    ADD CONSTRAINT "context_documents_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_documents"
    ADD CONSTRAINT "context_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."context_documents"
    ADD CONSTRAINT "context_documents_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_summaries"
    ADD CONSTRAINT "daily_summaries_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_summaries"
    ADD CONSTRAINT "daily_summaries_llm_run_id_fkey" FOREIGN KEY ("llm_run_id") REFERENCES "public"."llm_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."event_attachments"
    ADD CONSTRAINT "event_attachments_connector_fkey" FOREIGN KEY ("project_connector_id", "project_id", "client_space_id") REFERENCES "public"."project_connectors"("id", "project_id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_attachments"
    ADD CONSTRAINT "event_attachments_normalized_event_id_fkey" FOREIGN KEY ("normalized_event_id") REFERENCES "public"."normalized_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."event_attachments"
    ADD CONSTRAINT "event_attachments_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_client_space_id_workspace_id_fkey" FOREIGN KEY ("client_space_id", "workspace_id") REFERENCES "public"."client_spaces"("id", "workspace_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_project_id_workspace_id_fkey" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "public"."projects"("id", "workspace_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."invitations"
    ADD CONSTRAINT "invitations_workspace_id_tenant_id_fkey" FOREIGN KEY ("workspace_id", "tenant_id") REFERENCES "public"."workspaces"("id", "tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_client_space_id_tenant_id_fkey" FOREIGN KEY ("client_space_id", "tenant_id") REFERENCES "public"."client_spaces"("id", "tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."llm_runs"
    ADD CONSTRAINT "llm_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."normalized_events"
    ADD CONSTRAINT "normalized_events_project_connector_id_project_id_client_s_fkey" FOREIGN KEY ("project_connector_id", "project_id", "client_space_id") REFERENCES "public"."project_connectors"("id", "project_id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."normalized_events"
    ADD CONSTRAINT "normalized_events_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."normalized_events"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_connector_cursors"
    ADD CONSTRAINT "project_connector_cursors_project_connector_id_fkey" FOREIGN KEY ("project_connector_id") REFERENCES "public"."project_connectors"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_connection_id_client_space_id_fkey" FOREIGN KEY ("connection_id", "client_space_id") REFERENCES "public"."space_connections"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_connectors"
    ADD CONSTRAINT "project_connectors_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_client_space_id_user_id_fkey" FOREIGN KEY ("client_space_id", "user_id") REFERENCES "public"."space_members"("client_space_id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."project_members"
    ADD CONSTRAINT "project_members_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_client_space_id_workspace_id_fkey" FOREIGN KEY ("client_space_id", "workspace_id") REFERENCES "public"."client_spaces"("id", "workspace_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."projects"
    ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."raw_events"
    ADD CONSTRAINT "raw_events_project_connector_id_project_id_client_space_id_fkey" FOREIGN KEY ("project_connector_id", "project_id", "client_space_id") REFERENCES "public"."project_connectors"("id", "project_id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."raw_events"
    ADD CONSTRAINT "raw_events_sync_job_id_fkey" FOREIGN KEY ("sync_job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."search_chunks"
    ADD CONSTRAINT "search_chunks_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."search_chunks"
    ADD CONSTRAINT "search_chunks_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."space_connections"
    ADD CONSTRAINT "space_connections_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."space_connections"
    ADD CONSTRAINT "space_connections_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."space_members"
    ADD CONSTRAINT "space_members_client_space_id_tenant_id_fkey" FOREIGN KEY ("client_space_id", "tenant_id") REFERENCES "public"."client_spaces"("id", "tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."space_members"
    ADD CONSTRAINT "space_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."space_members"
    ADD CONSTRAINT "space_members_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."tenant_members"("tenant_id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."space_members"
    ADD CONSTRAINT "space_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sync_batch_members"
    ADD CONSTRAINT "sync_batch_members_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."sync_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sync_batch_members"
    ADD CONSTRAINT "sync_batch_members_project_connector_id_client_space_id_fkey" FOREIGN KEY ("project_connector_id", "client_space_id") REFERENCES "public"."project_connectors"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sync_batches"
    ADD CONSTRAINT "sync_batches_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sync_jobs"
    ADD CONSTRAINT "sync_jobs_project_connector_id_client_space_id_fkey" FOREIGN KEY ("project_connector_id", "client_space_id") REFERENCES "public"."project_connectors"("id", "client_space_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "public"."search_chunks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_client_space_id_fkey" FOREIGN KEY ("client_space_id") REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_llm_run_id_fkey" FOREIGN KEY ("llm_run_id") REFERENCES "public"."llm_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_normalized_event_id_fkey" FOREIGN KEY ("normalized_event_id") REFERENCES "public"."normalized_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_sources"
    ADD CONSTRAINT "task_sources_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_assignee_team_member_id_workspace_id_fkey" FOREIGN KEY ("assignee_team_member_id", "workspace_id") REFERENCES "public"."team_members"("id", "workspace_id") ON DELETE SET NULL ("assignee_team_member_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_client_space_id_workspace_id_fkey" FOREIGN KEY ("client_space_id", "workspace_id") REFERENCES "public"."client_spaces"("id", "workspace_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_llm_run_id_client_space_id_fkey" FOREIGN KEY ("llm_run_id", "client_space_id") REFERENCES "public"."llm_runs"("id", "client_space_id") ON DELETE SET NULL ("llm_run_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_project_id_client_space_id_fkey" FOREIGN KEY ("project_id", "client_space_id") REFERENCES "public"."projects"("id", "client_space_id") ON DELETE SET NULL ("project_id");



ALTER TABLE ONLY "public"."tasks"
    ADD CONSTRAINT "tasks_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."tasks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_members"
    ADD CONSTRAINT "tenant_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_members"
    ADD CONSTRAINT "tenant_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_members"
    ADD CONSTRAINT "tenant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "public"."tenant_members"("tenant_id", "user_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspace_members"
    ADD CONSTRAINT "workspace_members_workspace_id_tenant_id_fkey" FOREIGN KEY ("workspace_id", "tenant_id") REFERENCES "public"."workspaces"("id", "tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."workspaces"
    ADD CONSTRAINT "workspaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_select_admin" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING (("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]) OR (("workspace_id" IS NOT NULL) AND "public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"]))));



ALTER TABLE "public"."client_spaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "client_spaces_delete" ON "public"."client_spaces" FOR DELETE TO "authenticated" USING ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"]));



CREATE POLICY "client_spaces_insert" ON "public"."client_spaces" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"]));



CREATE POLICY "client_spaces_select" ON "public"."client_spaces" FOR SELECT TO "authenticated" USING ((("id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) OR ("id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")) OR ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "client_spaces_update" ON "public"."client_spaces" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids"))) WITH CHECK (("id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



ALTER TABLE "public"."context_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "context_documents_select" ON "public"."context_documents" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND (("project_id" IS NULL) OR ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")))));



CREATE POLICY "context_documents_write" ON "public"."context_documents" TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")) OR (("project_id" IS NOT NULL) AND ("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids"))))) WITH CHECK ((("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")) OR (("project_id" IS NOT NULL) AND ("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids")))));



ALTER TABLE "public"."daily_summaries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "daily_summaries_select" ON "public"."daily_summaries" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



ALTER TABLE "public"."event_attachments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_attachments_select" ON "public"."event_attachments" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids"))));



ALTER TABLE "public"."invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invitations_select_admin" ON "public"."invitations" FOR SELECT TO "authenticated" USING (("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]) OR (("workspace_id" IS NOT NULL) AND "public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"])) OR (("client_space_id" IS NOT NULL) AND ("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")))));



CREATE POLICY "invitations_write_admin" ON "public"."invitations" TO "authenticated" USING (("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]) OR (("workspace_id" IS NOT NULL) AND "public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"])) OR (("client_space_id" IS NOT NULL) AND ("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids"))))) WITH CHECK (("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]) OR (("workspace_id" IS NOT NULL) AND "public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"])) OR (("client_space_id" IS NOT NULL) AND ("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")))));



ALTER TABLE "public"."job_dispatches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."llm_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."normalized_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "normalized_events_select" ON "public"."normalized_events" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids"))));



CREATE POLICY "pm_select_peers" ON "public"."project_members" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")));



CREATE POLICY "pm_select_self" ON "public"."project_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "pm_write_manager" ON "public"."project_members" TO "authenticated" USING (("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids"))) WITH CHECK (("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids")));



ALTER TABLE "public"."project_connector_cursors" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."project_connectors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "project_connectors_select" ON "public"."project_connectors" FOR SELECT TO "authenticated" USING (("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")));



CREATE POLICY "project_connectors_write" ON "public"."project_connectors" TO "authenticated" USING (("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids"))) WITH CHECK (("project_id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids")));



ALTER TABLE "public"."project_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "projects_delete" ON "public"."projects" FOR DELETE TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



CREATE POLICY "projects_insert" ON "public"."projects" FOR INSERT TO "authenticated" WITH CHECK (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



CREATE POLICY "projects_select" ON "public"."projects" FOR SELECT TO "authenticated" USING ((("id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")) OR ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "projects_update" ON "public"."projects" FOR UPDATE TO "authenticated" USING (("id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids"))) WITH CHECK (("id" IN ( SELECT "public"."manageable_project_ids"() AS "manageable_project_ids")));



ALTER TABLE "public"."raw_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."search_chunks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "search_chunks_select" ON "public"."search_chunks" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND (("project_id" IS NULL) OR ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")))));



CREATE POLICY "sm_select_comembers" ON "public"."space_members" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



CREATE POLICY "sm_select_managers" ON "public"."space_members" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



CREATE POLICY "sm_select_self" ON "public"."space_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "sm_write_admin" ON "public"."space_members" TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids"))) WITH CHECK (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



ALTER TABLE "public"."space_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "space_connections_delete" ON "public"."space_connections" FOR DELETE TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids")));



CREATE POLICY "space_connections_select" ON "public"."space_connections" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) OR ("client_space_id" IN ( SELECT "public"."manageable_client_space_ids"() AS "manageable_client_space_ids"))));



ALTER TABLE "public"."space_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sync_batch_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_batch_members_select" ON "public"."sync_batch_members" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



ALTER TABLE "public"."sync_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_batches_select" ON "public"."sync_batches" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



ALTER TABLE "public"."sync_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_jobs_select" ON "public"."sync_jobs" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



ALTER TABLE "public"."task_sources" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "task_sources_select" ON "public"."task_sources" FOR SELECT TO "authenticated" USING (("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")));



ALTER TABLE "public"."tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tasks_select" ON "public"."tasks" FOR SELECT TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND (("project_id" IS NULL) OR ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")))));



CREATE POLICY "tasks_update" ON "public"."tasks" FOR UPDATE TO "authenticated" USING ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND (("project_id" IS NULL) OR ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids"))))) WITH CHECK ((("client_space_id" IN ( SELECT "public"."current_client_space_ids"() AS "current_client_space_ids")) AND (("project_id" IS NULL) OR ("project_id" IN ( SELECT "public"."current_project_ids"() AS "current_project_ids")))));



ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "team_members_select" ON "public"."team_members" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "public"."current_workspace_ids"() AS "current_workspace_ids")));



CREATE POLICY "team_members_write_admin" ON "public"."team_members" TO "authenticated" USING ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"])) WITH CHECK ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"]));



ALTER TABLE "public"."tenant_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_members_select_peers" ON "public"."tenant_members" FOR SELECT TO "authenticated" USING (("tenant_id" IN ( SELECT "public"."current_tenant_ids"() AS "current_tenant_ids")));



CREATE POLICY "tenant_members_select_self" ON "public"."tenant_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "tenant_members_write_owner" ON "public"."tenant_members" TO "authenticated" USING ("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"])) WITH CHECK ("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]));



ALTER TABLE "public"."tenant_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_subscriptions_select" ON "public"."tenant_subscriptions" FOR SELECT TO "authenticated" USING (("tenant_id" IN ( SELECT "public"."current_tenant_ids"() AS "current_tenant_ids")));



ALTER TABLE "public"."tenants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenants_insert" ON "public"."tenants" FOR INSERT TO "authenticated" WITH CHECK (true);



CREATE POLICY "tenants_select" ON "public"."tenants" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "public"."current_tenant_ids"() AS "current_tenant_ids")));



CREATE POLICY "tenants_update" ON "public"."tenants" FOR UPDATE TO "authenticated" USING ("public"."has_tenant_role"("id", ARRAY['owner'::"public"."tenant_role"])) WITH CHECK ("public"."has_tenant_role"("id", ARRAY['owner'::"public"."tenant_role"]));



ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_select_comembers" ON "public"."users" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."tenant_members" "tm"
  WHERE (("tm"."user_id" = "users"."id") AND ("tm"."tenant_id" IN ( SELECT "public"."current_tenant_ids"() AS "current_tenant_ids"))))));



CREATE POLICY "users_select_self" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "users_update_self" ON "public"."users" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "wm_select_comembers" ON "public"."workspace_members" FOR SELECT TO "authenticated" USING (("workspace_id" IN ( SELECT "public"."current_workspace_ids"() AS "current_workspace_ids")));



CREATE POLICY "wm_select_self" ON "public"."workspace_members" FOR SELECT TO "authenticated" USING (("user_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "wm_write_admin" ON "public"."workspace_members" TO "authenticated" USING ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"])) WITH CHECK ("public"."has_workspace_role"("workspace_id", ARRAY['admin'::"public"."workspace_role"]));



ALTER TABLE "public"."workspace_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."workspaces" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "workspaces_delete" ON "public"."workspaces" FOR DELETE TO "authenticated" USING ("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]));



CREATE POLICY "workspaces_insert" ON "public"."workspaces" FOR INSERT TO "authenticated" WITH CHECK ("public"."has_tenant_role"("tenant_id", ARRAY['owner'::"public"."tenant_role"]));



CREATE POLICY "workspaces_select" ON "public"."workspaces" FOR SELECT TO "authenticated" USING (("id" IN ( SELECT "public"."current_workspace_ids"() AS "current_workspace_ids")));



CREATE POLICY "workspaces_update" ON "public"."workspaces" FOR UPDATE TO "authenticated" USING ("public"."has_workspace_role"("id", ARRAY['admin'::"public"."workspace_role"])) WITH CHECK ("public"."has_workspace_role"("id", ARRAY['admin'::"public"."workspace_role"]));



REVOKE USAGE ON SCHEMA "public" FROM PUBLIC;
GRANT ALL ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_invitation"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_invitation"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."accept_invitation"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ack_job"("p_msg_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ack_job"("p_msg_id" bigint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_tenant_and_workspace"("p_name" "text", "p_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_tenant_and_workspace"("p_name" "text", "p_slug" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."create_tenant_and_workspace"("p_name" "text", "p_slug" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."current_client_space_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_client_space_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_client_space_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_project_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_project_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_project_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_tenant_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_tenant_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_tenant_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_workspace_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_workspace_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_workspace_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."dispatch_daily_tick"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispatch_daily_tick"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."dispatch_jobs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dispatch_jobs"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enqueue_job"("p_route" "text", "p_payload" "jsonb", "p_delay_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_job"("p_route" "text", "p_payload" "jsonb", "p_delay_seconds" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_tenant_membership"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_job"("p_msg_id" bigint, "p_attempt" integer, "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_job"("p_msg_id" bigint, "p_attempt" integer, "p_error" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."find_similar_open_tasks"("p_client_space_id" "uuid", "p_embedding" "public"."vector", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."find_similar_open_tasks"("p_client_space_id" "uuid", "p_embedding" "public"."vector", "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."forbid_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_last_space_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_last_tenant_owner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_last_workspace_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_client_space"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_project"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_tenant"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_workspace"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_space_role"("p_client_space_id" "uuid", "p_roles" "public"."space_role"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_space_role"("p_client_space_id" "uuid", "p_roles" "public"."space_role"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_space_role"("p_client_space_id" "uuid", "p_roles" "public"."space_role"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_tenant_role"("p_tenant_id" "uuid", "p_roles" "public"."tenant_role"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_tenant_role"("p_tenant_id" "uuid", "p_roles" "public"."tenant_role"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_tenant_role"("p_tenant_id" "uuid", "p_roles" "public"."tenant_role"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."has_workspace_role"("p_workspace_id" "uuid", "p_roles" "public"."workspace_role"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_workspace_role"("p_workspace_id" "uuid", "p_roles" "public"."workspace_role"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_workspace_role"("p_workspace_id" "uuid", "p_roles" "public"."workspace_role"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."manageable_client_space_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manageable_client_space_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."manageable_client_space_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."manageable_project_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."manageable_project_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."manageable_project_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_event_attachments"("p_older_than_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_event_attachments"("p_older_than_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reap_job_dispatches"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reap_job_dispatches"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_project_connector_provider"() TO "service_role";



GRANT SELECT ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT SELECT,INSERT,DELETE ON TABLE "public"."client_spaces" TO "authenticated";
GRANT ALL ON TABLE "public"."client_spaces" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."client_spaces" TO "authenticated";



GRANT UPDATE("description") ON TABLE "public"."client_spaces" TO "authenticated";



GRANT UPDATE("timezone") ON TABLE "public"."client_spaces" TO "authenticated";



GRANT UPDATE("context_profile") ON TABLE "public"."client_spaces" TO "authenticated";



GRANT UPDATE("archived_at") ON TABLE "public"."client_spaces" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."context_documents" TO "service_role";



GRANT SELECT ON TABLE "public"."daily_summaries" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_summaries" TO "service_role";



GRANT SELECT ON TABLE "public"."event_attachments" TO "authenticated";
GRANT ALL ON TABLE "public"."event_attachments" TO "service_role";



GRANT INSERT,DELETE ON TABLE "public"."invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."invitations" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("tenant_id") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("workspace_id") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("client_space_id") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("project_id") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("email") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("tenant_role") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("workspace_role") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("space_role") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("project_role") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("invited_by") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("accepted_by") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("expires_at") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("accepted_at") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("revoked_at"),UPDATE("revoked_at") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."invitations" TO "authenticated";



GRANT SELECT("updated_at") ON TABLE "public"."invitations" TO "authenticated";



GRANT ALL ON TABLE "public"."job_dispatches" TO "service_role";



GRANT ALL ON TABLE "public"."llm_runs" TO "service_role";



GRANT SELECT ON TABLE "public"."normalized_events" TO "authenticated";
GRANT ALL ON TABLE "public"."normalized_events" TO "service_role";



GRANT ALL ON TABLE "public"."project_connector_cursors" TO "service_role";



GRANT SELECT,INSERT,DELETE ON TABLE "public"."project_connectors" TO "authenticated";
GRANT ALL ON TABLE "public"."project_connectors" TO "service_role";



GRANT UPDATE("config") ON TABLE "public"."project_connectors" TO "authenticated";



GRANT UPDATE("enabled") ON TABLE "public"."project_connectors" TO "authenticated";



GRANT UPDATE("sync_enabled") ON TABLE "public"."project_connectors" TO "authenticated";



GRANT UPDATE("sync_interval_seconds") ON TABLE "public"."project_connectors" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."project_members" TO "service_role";



GRANT SELECT,INSERT,DELETE ON TABLE "public"."projects" TO "authenticated";
GRANT ALL ON TABLE "public"."projects" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."projects" TO "authenticated";



GRANT UPDATE("description") ON TABLE "public"."projects" TO "authenticated";



GRANT UPDATE("status") ON TABLE "public"."projects" TO "authenticated";



GRANT UPDATE("visibility") ON TABLE "public"."projects" TO "authenticated";



GRANT UPDATE("archived_at") ON TABLE "public"."projects" TO "authenticated";



GRANT ALL ON TABLE "public"."raw_events" TO "service_role";



GRANT SELECT ON TABLE "public"."search_chunks" TO "authenticated";
GRANT ALL ON TABLE "public"."search_chunks" TO "service_role";



GRANT DELETE ON TABLE "public"."space_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."space_connections" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("client_space_id") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("provider") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("auth_mode") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("external_account_id") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("external_account_label"),UPDATE("external_account_label") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("account_domain") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("config") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("last_validated_at") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("revoked_at") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("connected_by") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT("updated_at") ON TABLE "public"."space_connections" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."space_members" TO "authenticated";
GRANT ALL ON TABLE "public"."space_members" TO "service_role";



GRANT SELECT ON TABLE "public"."sync_batch_members" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_batch_members" TO "service_role";



GRANT SELECT ON TABLE "public"."sync_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_batches" TO "service_role";



GRANT SELECT ON TABLE "public"."sync_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_jobs" TO "service_role";



GRANT SELECT ON TABLE "public"."task_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."task_sources" TO "service_role";



GRANT SELECT ON TABLE "public"."tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."tasks" TO "service_role";



GRANT UPDATE("priority") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("status") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("due_at") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("assignee_id") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("assignee_team_member_id") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("resolved_at") ON TABLE "public"."tasks" TO "authenticated";



GRANT UPDATE("snoozed_until") ON TABLE "public"."tasks" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tenant_members" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_members" TO "service_role";



GRANT SELECT ON TABLE "public"."tenant_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_subscriptions" TO "service_role";



GRANT SELECT,INSERT ON TABLE "public"."tenants" TO "authenticated";
GRANT ALL ON TABLE "public"."tenants" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."tenants" TO "authenticated";



GRANT UPDATE("domain") ON TABLE "public"."tenants" TO "authenticated";



GRANT UPDATE("settings") ON TABLE "public"."tenants" TO "authenticated";



GRANT SELECT ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT UPDATE("full_name") ON TABLE "public"."users" TO "authenticated";



GRANT UPDATE("avatar_url") ON TABLE "public"."users" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."workspace_members" TO "authenticated";
GRANT ALL ON TABLE "public"."workspace_members" TO "service_role";



GRANT SELECT,INSERT,DELETE ON TABLE "public"."workspaces" TO "authenticated";
GRANT ALL ON TABLE "public"."workspaces" TO "service_role";



GRANT UPDATE("name") ON TABLE "public"."workspaces" TO "authenticated";



GRANT UPDATE("description") ON TABLE "public"."workspaces" TO "authenticated";



GRANT UPDATE("logo_path") ON TABLE "public"."workspaces" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";




