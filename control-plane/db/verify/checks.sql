-- Assertions about what the migrations built.
--
-- Structural rather than behavioural on purpose: every check here is about an invariant the
-- *database* enforces, so it fails if a future migration weakens a constraint, drops a policy,
-- or makes ciphertext reachable. A migration that applies cleanly but silently removes the
-- scope CHECK would pass a plain `psql -f` and fail here.
--
-- Any failure raises, so the script exits non-zero under ON_ERROR_STOP.

\set ON_ERROR_STOP on

DO $$
DECLARE
    n integer;
BEGIN
    ----------------------------------------------------------------------------
    -- The tables exist, and only the ones we meant to create
    ----------------------------------------------------------------------------
    SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema = 'runner';
    IF n <> 7 THEN
        RAISE EXCEPTION 'expected 7 runner tables, found %', n;
    END IF;

    ----------------------------------------------------------------------------
    -- RLS is on for every one of them
    ----------------------------------------------------------------------------
    SELECT count(*) INTO n
    FROM pg_tables WHERE schemaname = 'runner' AND NOT rowsecurity;
    IF n <> 0 THEN
        RAISE EXCEPTION '% runner table(s) have RLS disabled', n;
    END IF;

    ----------------------------------------------------------------------------
    -- credentials and run_tokens must have NO policies at all
    ----------------------------------------------------------------------------
    -- This is the strongest statement in the schema: RLS enabled with zero policies denies
    -- every row to every non-bypassing role. If someone later "helpfully" adds a policy here,
    -- secrets become reachable with a user's JWT.
    SELECT count(*) INTO n
    FROM pg_policies
    WHERE schemaname = 'runner' AND tablename IN ('credentials', 'run_tokens');
    IF n <> 0 THEN
        RAISE EXCEPTION 'runner.credentials/run_tokens must have no policies, found %', n;
    END IF;

    ----------------------------------------------------------------------------
    -- ...and authenticated must hold no grant on them either
    ----------------------------------------------------------------------------
    SELECT count(*) INTO n
    FROM information_schema.role_table_grants
    WHERE table_schema = 'runner'
      AND table_name IN ('credentials', 'run_tokens')
      AND grantee IN ('authenticated', 'anon');
    IF n <> 0 THEN
        RAISE EXCEPTION 'authenticated/anon hold % grant(s) on secret tables', n;
    END IF;

    ----------------------------------------------------------------------------
    -- public.tasks got an INSERT policy, which it did not have before
    ----------------------------------------------------------------------------
    SELECT count(*) INTO n
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'tasks' AND policyname = 'tasks_insert';
    IF n <> 1 THEN
        RAISE EXCEPTION 'public.tasks is missing the tasks_insert policy';
    END IF;

    ----------------------------------------------------------------------------
    -- The three defaults are set
    ----------------------------------------------------------------------------
    SELECT count(*) INTO n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tasks'
      AND column_name IN ('confidence', 'for_date', 'dedupe_hash')
      AND column_default IS NOT NULL;
    IF n <> 3 THEN
        RAISE EXCEPTION 'expected 3 defaulted columns on public.tasks, found %', n;
    END IF;

    RAISE NOTICE 'structure: ok';
END $$;

--------------------------------------------------------------------------------
-- The scope CHECK actually rejects what it claims to
--------------------------------------------------------------------------------
-- Negative tests, because a CHECK constraint that exists but does not bite is worse than no
-- constraint: it reads like a guarantee. Each block must fail, so an unexpected success is
-- what raises.

DO $$
DECLARE
    space1 uuid := 'cccccccc-0000-0000-0000-000000000001';
    space2 uuid := 'cccccccc-0000-0000-0000-000000000002';
    proj1  uuid := 'dddddddd-0000-0000-0000-000000000001';
    ok     boolean;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.client_spaces WHERE id = space1) THEN
        RAISE EXCEPTION 'seed missing — db/verify/seed.sql must run before checks';
    END IF;

    -- A GitHub installation is space-wide. Scoping one to a project would mean two projects
    -- in a space could hold different installations for the same org, and the broker would
    -- have no principled way to choose.
    ok := false;
    BEGIN
        INSERT INTO runner.integrations (client_space_id, project_id, kind, ref, display_name)
        VALUES (space1, proj1, 'github', '999', 'scoped github');
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'a project-scoped github row was accepted'; END IF;

    -- MCP is per project. A space-wide one would hand every project in the space a credential
    -- for a server it was never attached to.
    ok := false;
    BEGIN
        INSERT INTO runner.integrations (client_space_id, project_id, kind, ref, display_name)
        VALUES (space1, NULL, 'mcp', 'linear', 'space-wide mcp');
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'a space-wide mcp row was accepted'; END IF;

    -- The one that matters most: a project from space 2 paired with space 1's id. This is the
    -- shape a bug takes — a plausible-looking row that quietly widens access — and the
    -- composite foreign key is what makes it unrepresentable.
    ok := false;
    BEGIN
        INSERT INTO runner.integrations (client_space_id, project_id, kind, ref, display_name)
        VALUES (space1, 'dddddddd-0000-0000-0000-000000000002', 'mcp', 'linear', 'mismatched');
    EXCEPTION WHEN foreign_key_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'a project/space mismatch was accepted'; END IF;

    -- Same check on the repo allowlist, which is what gates what a run may touch.
    ok := false;
    BEGIN
        INSERT INTO runner.project_repos (client_space_id, project_id, installation_ref, owner, repo)
        VALUES (space2, proj1, '999', 'acme', 'checkout');
    EXCEPTION WHEN foreign_key_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'a mismatched project_repos row was accepted'; END IF;

    -- And the happy paths must still work, or the constraints are simply too tight.
    -- ON CONFLICT so this file is re-runnable against the same database. Without it the
    -- second run fails on the unique index and reports a defect that is not there, which is
    -- exactly the false negative that erodes trust in a check suite.
    INSERT INTO runner.integrations (client_space_id, project_id, kind, ref, display_name)
    VALUES (space1, NULL, 'github', '156419141', 'Acme org'),
           (space1, NULL, 'harness', 'claude-code', 'Claude Code seat'),
           (space1, proj1, 'mcp', 'linear', 'Linear')
    ON CONFLICT DO NOTHING;

    INSERT INTO runner.project_repos (client_space_id, project_id, installation_ref, owner, repo)
    VALUES (space1, proj1, '156419141', 'acme', 'checkout-service')
    ON CONFLICT DO NOTHING;

    -- Assert the accepted rows are actually there, which ON CONFLICT would otherwise hide.
    IF (SELECT count(*) FROM runner.integrations WHERE client_space_id = space1) <> 3 THEN
        RAISE EXCEPTION 'expected 3 integrations after the happy path';
    END IF;

    RAISE NOTICE 'scope checks: ok (4 rejected, 4 accepted)';
END $$;

--------------------------------------------------------------------------------
-- RLS, exercised as a real user rather than asserted
--------------------------------------------------------------------------------
-- A policy that exists proves nothing about what it permits. These run as `authenticated`
-- with request.jwt.claims set, which is exactly how the control plane will query, so what is
-- tested here is the path that ships.

DO $$
DECLARE
    n integer;
BEGIN
    -- The plain member of space one: may see the space's integrations...
    PERFORM set_config('request.jwt.claims',
        '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated;

    SELECT count(*) INTO n FROM runner.integrations;
    IF n <> 3 THEN RAISE EXCEPTION 'member should see 3 integrations, saw %', n; END IF;

    -- ...but must not be able to touch the space's shared harness seat, because a seat is
    -- shared by every project and costs money.
    BEGIN
        UPDATE runner.integrations SET display_name = 'hijacked' WHERE kind = 'harness';
        IF FOUND THEN RAISE EXCEPTION 'a plain member updated the space harness seat'; END IF;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    -- Ciphertext must be unreachable with any JWT: RLS on, no policy, no grant.
    BEGIN
        PERFORM count(*) FROM runner.credentials;
        RAISE EXCEPTION 'authenticated could read runner.credentials';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    BEGIN
        PERFORM count(*) FROM runner.run_tokens;
        RAISE EXCEPTION 'authenticated could read runner.run_tokens';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;

    RESET ROLE;

    -- A user in no space sees nothing at all, rather than everything.
    PERFORM set_config('request.jwt.claims',
        '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
    SET LOCAL ROLE authenticated;

    SELECT count(*) INTO n FROM runner.integrations;
    IF n <> 0 THEN RAISE EXCEPTION 'an outsider saw % integration(s)', n; END IF;

    SELECT count(*) INTO n FROM runner.project_repos;
    IF n <> 0 THEN RAISE EXCEPTION 'an outsider saw % repo(s)', n; END IF;

    RESET ROLE;
    RAISE NOTICE 'rls: ok';
END $$;

--------------------------------------------------------------------------------
-- Constraint definitions are present and say what we think
--------------------------------------------------------------------------------
-- Checked by definition rather than by insertion, so this runs without seed data and still
-- fails if a migration loosens the rule.

DO $$
DECLARE
    def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'integrations_scope_matches_kind';
    IF def IS NULL THEN
        RAISE EXCEPTION 'integrations_scope_matches_kind is missing';
    END IF;
    -- github must be space-only; mcp and skill must be project-only.
    IF def NOT LIKE '%github%' OR def NOT LIKE '%mcp%' OR def NOT LIKE '%skill%' THEN
        RAISE EXCEPTION 'scope CHECK no longer covers every kind: %', def;
    END IF;

    -- The composite reference is what makes a project/space mismatch impossible.
    SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'integrations_project_space_fkey';
    IF def IS NULL OR def NOT LIKE '%projects(id, client_space_id)%' THEN
        RAISE EXCEPTION 'integrations composite FK missing or changed: %', def;
    END IF;

    SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint WHERE conname = 'project_repos_project_space_fkey';
    IF def IS NULL OR def NOT LIKE '%projects(id, client_space_id)%' THEN
        RAISE EXCEPTION 'project_repos composite FK missing or changed: %', def;
    END IF;

    RAISE NOTICE 'constraints: ok';
END $$;

--------------------------------------------------------------------------------
-- Our policies call their helpers, rather than reimplementing tenancy
--------------------------------------------------------------------------------
-- If a policy here stops referencing the product's functions, the two models have begun to
-- drift and access will diverge from the rest of the database.

DO $$
DECLARE
    n integer;
BEGIN
    SELECT count(*) INTO n
    FROM pg_policies
    WHERE schemaname = 'runner'
      AND (qual LIKE '%current_%_ids%' OR qual LIKE '%manageable_%_ids%'
           OR with_check LIKE '%manageable_%_ids%' OR qual LIKE '%FROM public.tasks%'
           OR qual LIKE '%FROM runner.runs%' OR qual LIKE '%tasks%' OR qual LIKE '%runs%');
    IF n < 5 THEN
        RAISE EXCEPTION 'expected runner policies to delegate to the product helpers, matched %', n;
    END IF;
    RAISE NOTICE 'delegation: ok (% policies)', n;
END $$;
