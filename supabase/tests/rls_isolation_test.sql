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
select plan(6);

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

-- Workspaces created as postgres (bypasses RLS) so the fixture setup itself
-- isn't gated by the policies under test.
insert into public.workspaces (id, name, slug, owner_id) values
  ('c0000000-0000-0000-0000-00000000000c', 'Acme Technologies', 'acme-rls-test', 'a0000000-0000-0000-0000-00000000000a'),
  ('d0000000-0000-0000-0000-00000000000d', 'Northwind Traders', 'northwind-rls-test', 'b0000000-0000-0000-0000-00000000000b');

-- Deliberately identical project name across both workspaces — a leak that
-- shows the wrong workspace's project would otherwise be easy to miss.
insert into public.projects (id, workspace_id, name, slug) values
  ('e0000000-0000-0000-0000-00000000000e', 'c0000000-0000-0000-0000-00000000000c', 'Internal Dashboard', 'internal-dashboard'),
  ('f0000000-0000-0000-0000-00000000000f', 'd0000000-0000-0000-0000-00000000000d', 'Internal Dashboard', 'internal-dashboard');

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
