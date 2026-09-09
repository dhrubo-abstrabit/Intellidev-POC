-- The smallest tenancy that makes the negative tests meaningful.
--
-- Two spaces and two projects, deliberately: a single-space fixture cannot detect the bug that
-- matters most here — a row claiming a project in one space and a client_space_id from
-- another. Fixtures with one of everything pass constraints that are wrong.
--
-- Verification only. Never applied to a real database.

INSERT INTO "auth"."users" ("id", "email") VALUES
    ('11111111-1111-1111-1111-111111111111', 'admin@example.test'),
    ('22222222-2222-2222-2222-222222222222', 'member@example.test')
    ON CONFLICT DO NOTHING;

INSERT INTO "public"."users" ("id", "email", "full_name") VALUES
    ('11111111-1111-1111-1111-111111111111', 'admin@example.test', 'Space Admin'),
    ('22222222-2222-2222-2222-222222222222', 'member@example.test', 'Project Member')
    ON CONFLICT DO NOTHING;

INSERT INTO "public"."tenants" ("id", "name", "slug") VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme')
    ON CONFLICT DO NOTHING;

INSERT INTO "public"."workspaces" ("id", "tenant_id", "name", "slug") VALUES
    ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Delivery', 'delivery')
    ON CONFLICT DO NOTHING;

INSERT INTO "public"."client_spaces" ("id", "tenant_id", "workspace_id", "name", "slug") VALUES
    ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
     'bbbbbbbb-0000-0000-0000-000000000001', 'Space One', 'space-one'),
    -- The second space is what gives the mismatch tests something to be wrong about.
    ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
     'bbbbbbbb-0000-0000-0000-000000000001', 'Space Two', 'space-two')
    ON CONFLICT DO NOTHING;

INSERT INTO "public"."projects"
    ("id", "workspace_id", "client_space_id", "name", "slug", "visibility") VALUES
    ('dddddddd-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001',
     'cccccccc-0000-0000-0000-000000000001', 'Checkout', 'checkout', 'space'),
    ('dddddddd-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001',
     'cccccccc-0000-0000-0000-000000000002', 'Billing', 'billing', 'space')
    ON CONFLICT DO NOTHING;

-- One space admin, one plain member, so the write policies have both sides to distinguish.
INSERT INTO "public"."space_members" ("client_space_id", "tenant_id", "user_id", "role") VALUES
    ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
     '11111111-1111-1111-1111-111111111111', 'admin'),
    ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
     '22222222-2222-2222-2222-222222222222', 'member')
    ON CONFLICT DO NOTHING;
