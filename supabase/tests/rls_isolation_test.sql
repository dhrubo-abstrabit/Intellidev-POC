-- pgTAP cross-tenant isolation test. Run with `supabase test db`.
--
-- Verified passing against a live local Postgres instance (this CLI's
-- bundled GoTrue schema) as of the grants_hardening/service_role_grants
-- migrations.
--
-- Technique: impersonate a user by setting the `request.jwt.claim.sub`
-- config var that Supabase's `auth.uid()` reads, then switching to the
-- `authenticated` role for the rest of the transaction — the same
-- low-level mechanism PostgREST uses per-request, just driven by hand.

begin;
select plan(7);

-- Two users, minimal auth.users rows sufficient for the FK from public.users
-- and for auth.uid() to resolve during impersonation below.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('a0000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@example.com', 'x', now()),
  ('b0000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@example.com', 'x', now());

-- public.users rows are normally created by the trg_on_auth_user_created
-- trigger; assert that happened instead of inserting them ourselves.
select is(
  (select count(*)::int from public.users where id in ('a0000000-0000-0000-0000-00000000000a', 'b0000000-0000-0000-0000-00000000000b')),
  2,
  'auth.users insert fans out to public.users via the mirror trigger'
);

-- Tenants, workspaces, client spaces and projects created as postgres
-- (bypasses RLS) so the fixture setup itself isn't gated by the policies
-- under test.
--
-- MEMBERSHIP IS EXPLICIT HERE, and has to be. This fixture used to pass
-- `owner_id` to tenants and workspaces and rely on handle_new_tenant /
-- handle_new_workspace to fan out the membership rows. Both assumptions are
-- now wrong: the v2 rebuild dropped owner_id (ownership is a tenant_members
-- role, not a column — a column and a role row would be two sources of truth
-- for one fact), and those triggers return early when auth.uid() is null,
-- which it always is when inserting as `postgres`. The suite therefore
-- inserted nothing, granted nothing, and died on a missing column before
-- reaching any assertion.
insert into public.tenants (id, name, slug) values
  ('90000000-0000-0000-0000-000000000009', 'Acme Corp', 'acme-rls-test'),
  ('90000000-0000-0000-0000-00000000000f', 'Northwind Corp', 'northwind-rls-test');

insert into public.tenant_members (tenant_id, user_id, role) values
  ('90000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-00000000000a', 'owner'),
  ('90000000-0000-0000-0000-00000000000f', 'b0000000-0000-0000-0000-00000000000b', 'owner');

insert into public.workspaces (id, tenant_id, name, slug) values
  ('c0000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000009', 'Acme Technologies', 'acme-rls-test'),
  ('d0000000-0000-0000-0000-00000000000d', '90000000-0000-0000-0000-00000000000f', 'Northwind Traders', 'northwind-rls-test');

insert into public.workspace_members (workspace_id, tenant_id, user_id, role) values
  ('c0000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-00000000000a', 'admin'),
  ('d0000000-0000-0000-0000-00000000000d', '90000000-0000-0000-0000-00000000000f', 'b0000000-0000-0000-0000-00000000000b', 'admin');

-- Deliberately identical name across both workspaces — a leak that shows the
-- wrong workspace's client space or project would otherwise be easy to miss.
insert into public.client_spaces (id, workspace_id, tenant_id, name, slug) values
  ('10000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', '90000000-0000-0000-0000-000000000009', 'Internal Dashboard', 'internal-dashboard'),
  ('20000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-00000000000d', '90000000-0000-0000-0000-00000000000f', 'Internal Dashboard', 'internal-dashboard');

insert into public.projects (id, client_space_id, workspace_id, name, slug) values
  ('e0000000-0000-0000-0000-00000000000e', '10000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000c', 'Internal Dashboard', 'internal-dashboard'),
  ('f0000000-0000-0000-0000-00000000000f', '20000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-00000000000d', 'Internal Dashboard', 'internal-dashboard');

-- --- Impersonate Alice ---
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
set local role authenticated;

select is(
  (select count(*)::int from public.workspaces),
  1,
  'Alice sees exactly one workspace (her own)'
);
select is(
  (select id::text from public.workspaces limit 1),
  'c0000000-0000-0000-0000-00000000000c',
  'the workspace Alice sees is Acme, not Northwind'
);
select is(
  (select count(*)::int from public.client_spaces where id = '20000000-0000-0000-0000-000000000002'),
  0,
  'Alice cannot see Bob''s client space even though it shares her client space''s name'
);
select is(
  (select count(*)::int from public.projects where id = 'f0000000-0000-0000-0000-00000000000f'),
  0,
  'Alice cannot see Bob''s project even though it shares her project''s name'
);

-- Alice must not be able to read Bob's membership row via the comembers
-- policy — she is not a member of Bob's workspace.
select is(
  (select count(*)::int from public.workspace_members where workspace_id = 'd0000000-0000-0000-0000-00000000000d'),
  0,
  'Alice cannot see Northwind''s workspace_members rows'
);

reset role;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000000b', true);
set local role authenticated;

select is(
  (select id::text from public.workspaces limit 1),
  'd0000000-0000-0000-0000-00000000000d',
  'Bob sees Northwind, not Acme, when impersonated symmetrically'
);

select * from finish();
rollback;
