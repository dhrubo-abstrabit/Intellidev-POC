-- pgTAP role × permission × table matrix. Run with `supabase test db`.
--
-- This is the contract the RBAC migrations are checked against. It asserts
-- what each role CAN do and — more importantly — what it CANNOT, because a
-- permission system is only as good as its denials and a denial is exactly
-- the thing that fails silently when it regresses.
--
-- Technique, same as rls_isolation_test.sql: impersonate by setting the
-- `request.jwt.claim.sub` config var that auth.uid() reads, then switch to
-- the `authenticated` role for the rest of the transaction — the same
-- low-level mechanism PostgREST uses per request, driven by hand.
--
-- Fixtures are inserted as `postgres`, which bypasses RLS, so setting up the
-- world is not itself gated by the policies under test.

begin;
select plan(28);

-- =========================================================================
-- Helpers.
--
-- affected() runs a statement and reports how many rows it touched, or -1 if
-- it raised. That distinction matters here: RLS refuses a write in two
-- different ways depending on which half of the policy rejected it — a USING
-- clause that matches nothing silently affects 0 rows, while a failed WITH
-- CHECK raises 42501. Collapsing both into one number lets every write
-- assertion below read the same way regardless of which mechanism did the
-- refusing.
--
-- SECURITY INVOKER (the default) is essential: the statement must run with
-- the impersonated caller's privileges, not the definer's.
-- =========================================================================
create function pg_temp.affected(p_sql text) returns integer
language plpgsql as $$
declare n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when others then
  return -1;
end $$;

-- =========================================================================
-- Users. public.users rows arrive via the trg_on_auth_user_created mirror.
-- =========================================================================
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('0a000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'towner@example.com',   'x', now()),
  ('0b000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tbilling@example.com', 'x', now()),
  ('0c000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'tmember@example.com',  'x', now()),
  ('0d000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'wadmin@example.com',   'x', now()),
  ('0e000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sadmin@example.com',   'x', now()),
  ('0f000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smember@example.com',  'x', now()),
  ('10000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sviewer@example.com',  'x', now());

-- =========================================================================
-- The hierarchy.
-- =========================================================================
insert into public.tenants (id, name, slug)
values ('aaaa0000-0000-0000-0000-00000000000a', 'Matrix Tenant', 'matrix-tenant');

insert into public.tenant_subscriptions (tenant_id, plan, seats)
values ('aaaa0000-0000-0000-0000-00000000000a', 'pro', 25);

insert into public.workspaces (id, tenant_id, name, slug)
values ('bbbb0000-0000-0000-0000-00000000000b', 'aaaa0000-0000-0000-0000-00000000000a', 'Matrix Workspace', 'matrix-ws');

insert into public.client_spaces (id, tenant_id, workspace_id, name, slug)
values ('cccc0000-0000-0000-0000-00000000000c', 'aaaa0000-0000-0000-0000-00000000000a',
        'bbbb0000-0000-0000-0000-00000000000b', 'Matrix Space', 'matrix-space');

insert into public.projects (id, client_space_id, workspace_id, name, slug)
values ('dddd0000-0000-0000-0000-00000000000d', 'cccc0000-0000-0000-0000-00000000000c',
        'bbbb0000-0000-0000-0000-00000000000b', 'Matrix Project', 'matrix-project');

-- =========================================================================
-- Memberships. space_members / workspace_members provision the tenant roster
-- row themselves via ensure_tenant_membership(), so only the tenant-level
-- roles need inserting by hand.
-- =========================================================================
insert into public.tenant_members (tenant_id, user_id, role) values
  ('aaaa0000-0000-0000-0000-00000000000a', '0a000000-0000-0000-0000-00000000000a', 'owner'),
  ('aaaa0000-0000-0000-0000-00000000000a', '0b000000-0000-0000-0000-00000000000b', 'billing_admin'),
  ('aaaa0000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-00000000000c', 'member');

insert into public.workspace_members (workspace_id, tenant_id, user_id, role) values
  ('bbbb0000-0000-0000-0000-00000000000b', 'aaaa0000-0000-0000-0000-00000000000a', '0d000000-0000-0000-0000-00000000000d', 'admin');

insert into public.space_members (client_space_id, tenant_id, user_id, role) values
  ('cccc0000-0000-0000-0000-00000000000c', 'aaaa0000-0000-0000-0000-00000000000a', '0e000000-0000-0000-0000-00000000000e', 'admin'),
  ('cccc0000-0000-0000-0000-00000000000c', 'aaaa0000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-00000000000f', 'member'),
  ('cccc0000-0000-0000-0000-00000000000c', 'aaaa0000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000010', 'viewer');

-- =========================================================================
-- Content. CN1 feeds the project connector and must survive; CN2 is the
-- target of the delete assertions, kept separate so cascading it away cannot
-- take the normalized event with it.
-- =========================================================================
-- auth_mode 'none' avoids space_connections_auth_mode_chk's requirement that
-- a nango connection carry a connection id and config key, neither of which
-- this test has any use for.
insert into public.space_connections (id, client_space_id, provider, auth_mode, external_account_id) values
  ('eeee0000-0000-0000-0000-00000000000e', 'cccc0000-0000-0000-0000-00000000000c', 'slack', 'none', 'T-MATRIX-1'),
  ('eeee0000-0000-0000-0000-000000000002', 'cccc0000-0000-0000-0000-00000000000c', 'mock',  'none', 'T-MATRIX-2');

insert into public.project_connectors (id, client_space_id, project_id, connection_id, provider)
values ('ffff0000-0000-0000-0000-00000000000f', 'cccc0000-0000-0000-0000-00000000000c',
        'dddd0000-0000-0000-0000-00000000000d', 'eeee0000-0000-0000-0000-00000000000e', 'slack');

insert into public.normalized_events
  (id, client_space_id, project_id, project_connector_id, provider, type, occurred_at, dedupe_key)
values ('1111aaaa-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-00000000000c',
        'dddd0000-0000-0000-0000-00000000000d', 'ffff0000-0000-0000-0000-00000000000f',
        'slack', 'slack.message', now(), 'matrix-dedupe-1');

insert into public.tasks
  (id, client_space_id, workspace_id, project_id, title, confidence, for_date, dedupe_hash)
values ('2222aaaa-0000-0000-0000-000000000002', 'cccc0000-0000-0000-0000-00000000000c',
        'bbbb0000-0000-0000-0000-00000000000b', 'dddd0000-0000-0000-0000-00000000000d',
        'Matrix task', 0.9, current_date, 'matrix-hash-1');

insert into public.context_documents (id, client_space_id, project_id, kind, title, source)
values ('3333aaaa-0000-0000-0000-000000000003', 'cccc0000-0000-0000-0000-00000000000c',
        'dddd0000-0000-0000-0000-00000000000d', 'business_context', 'Matrix doc', 'pasted');

-- =========================================================================
-- SPACE VIEWER — the role that did nothing before this change.
-- =========================================================================
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000010', true);
set local role authenticated;

select is((select count(*)::int from public.tasks), 1,
  'space viewer can READ the task board');

select is(pg_temp.affected(
    $$update public.tasks set status = 'done' where id = '2222aaaa-0000-0000-0000-000000000002'$$),
  0, 'space viewer CANNOT update a task');

select is(pg_temp.affected(
    $$update public.tasks set assignee_id = '10000000-0000-0000-0000-000000000010'
      where id = '2222aaaa-0000-0000-0000-000000000002'$$),
  0, 'space viewer CANNOT assign a task');

select is((select count(*)::int from public.normalized_events), 1,
  'space viewer can READ ingested activity');

select is((select count(*)::int from public.context_documents), 1,
  'space viewer can READ context documents');

select is(pg_temp.affected(
    $$insert into public.context_documents (client_space_id, kind, title, source)
      values ('cccc0000-0000-0000-0000-00000000000c', 'prd', 'viewer doc', 'pasted')$$),
  -1, 'space viewer CANNOT write a context document');

select is((select count(*)::int from public.projects), 1,
  'space viewer can see the project');

select is(pg_temp.affected(
    $$delete from public.space_connections where id = 'eeee0000-0000-0000-0000-000000000002'$$),
  0, 'space viewer CANNOT disconnect a provider');

reset role;

-- =========================================================================
-- SPACE MEMBER — does the work, does not administer access.
-- =========================================================================
select set_config('request.jwt.claim.sub', '0f000000-0000-0000-0000-00000000000f', true);
set local role authenticated;

select is(pg_temp.affected(
    $$update public.tasks set status = 'in_progress' where id = '2222aaaa-0000-0000-0000-000000000002'$$),
  1, 'space member CAN update a task');

select is(pg_temp.affected(
    $$insert into public.context_documents (client_space_id, kind, title, source)
      values ('cccc0000-0000-0000-0000-00000000000c', 'prd', 'member doc', 'pasted')$$),
  1, 'space member CAN write a context document');

select is(pg_temp.affected(
    $$delete from public.space_connections where id = 'eeee0000-0000-0000-0000-000000000002'$$),
  0, 'space member CANNOT disconnect a provider');

select is(pg_temp.affected(
    $$update public.client_spaces set name = 'renamed by member'
      where id = 'cccc0000-0000-0000-0000-00000000000c'$$),
  0, 'space member CANNOT rename the client space');

reset role;

-- =========================================================================
-- SPACE ADMIN — runs the engagement.
-- =========================================================================
select set_config('request.jwt.claim.sub', '0e000000-0000-0000-0000-00000000000e', true);
set local role authenticated;

select is(pg_temp.affected(
    $$update public.client_spaces set name = 'renamed by admin'
      where id = 'cccc0000-0000-0000-0000-00000000000c'$$),
  1, 'space admin CAN rename the client space');

select is(pg_temp.affected(
    $$delete from public.space_connections where id = 'eeee0000-0000-0000-0000-000000000002'$$),
  1, 'space admin CAN disconnect a provider');

select is(pg_temp.affected(
    $$delete from public.client_spaces where id = 'cccc0000-0000-0000-0000-00000000000c'$$),
  0, 'space admin CANNOT delete the client space (workspace authority only)');

reset role;

-- =========================================================================
-- WORKSPACE ADMIN — manages the shape of an engagement, reads none of it.
-- This is the split that used to live in prose across two helper functions
-- and now lives in the grid as an absent row.
-- =========================================================================
select set_config('request.jwt.claim.sub', '0d000000-0000-0000-0000-00000000000d', true);
set local role authenticated;

select is((select count(*)::int from public.normalized_events), 0,
  'workspace admin CANNOT read ingested activity');

select is((select count(*)::int from public.tasks), 0,
  'workspace admin CANNOT read the task board');

select is((select count(*)::int from public.context_documents), 0,
  'workspace admin CANNOT read context documents');

select is((select count(*)::int from public.client_spaces), 1,
  'workspace admin CAN see the client space row');

select is(pg_temp.affected(
    $$update public.client_spaces set description = 'by ws admin'
      where id = 'cccc0000-0000-0000-0000-00000000000c'$$),
  1, 'workspace admin CAN manage the client space');

reset role;

-- =========================================================================
-- TENANT OWNER — authority everywhere beneath, still no ingested data
-- without an explicit space_members row.
-- =========================================================================
select set_config('request.jwt.claim.sub', '0a000000-0000-0000-0000-00000000000a', true);
set local role authenticated;

select is((select count(*)::int from public.normalized_events), 0,
  'tenant owner CANNOT read ingested activity without joining the space');

select is((select count(*)::int from public.tenant_subscriptions), 1,
  'tenant owner CAN read billing');

select is((select count(*)::int from public.client_spaces), 1,
  'tenant owner CAN see client spaces beneath them');

reset role;

-- =========================================================================
-- TENANT MEMBER — roster presence, nothing else.
-- =========================================================================
select set_config('request.jwt.claim.sub', '0c000000-0000-0000-0000-00000000000c', true);
set local role authenticated;

select is((select count(*)::int from public.tenant_subscriptions), 0,
  'plain tenant member CANNOT read billing');

select is((select count(*)::int from public.client_spaces), 0,
  'plain tenant member CANNOT see client spaces');

select is((select count(*)::int from public.space_members), 0,
  'plain tenant member CANNOT see a client space roster');

reset role;

-- =========================================================================
-- Grid invariants. These restate, as tests, the two rules the seed's own DO
-- block asserts at migration time — so a later seed edit that breaks them
-- fails here too, not only on a fresh migration run.
-- =========================================================================
select is(
  (select coalesce(string_agg(scope_level || '/' || role_key || ':' || permission, ', '), '')
   from public.role_permissions
   where role_key = 'viewer'
     and permission in (select key from public.permissions where requires is not null)),
  '',
  'no viewer role holds any write permission');

select is(
  (select coalesce(string_agg(scope_level || '/' || role_key || ':' || permission, ', '), '')
   from public.role_permissions
   where scope_level in ('tenant', 'workspace')
     and permission in ('data.read', 'task.read', 'task.update', 'task.assign',
                        'document.read', 'document.write', 'sync.trigger')),
  '',
  'no tenant or workspace role reaches ingested client data');

select * from finish();
rollback;
