-- The contract between this repo and the product schema.
--
-- Every `runner.*` policy delegates authorization to four functions in `public` that another
-- repo owns and can change with `CREATE OR REPLACE`. That is the one way they can affect us
-- **invisibly**: structural changes are blocked by Postgres — our foreign keys make
-- public.tasks, public.projects, public.client_spaces and the
-- projects(id, client_space_id) unique constraint undroppable — but a redefined function
-- raises nothing. Widen `current_project_ids()` and every runner table silently becomes
-- visible to more people, with no migration and no error on our side.
--
-- So the definitions are pinned. A change fails this check instead of quietly changing who
-- can see what.
--
-- WHEN THIS FAILS: do not just update the hash. Read the new definition, work out what it
-- does to `runner` access, then update the pin in the same commit as whatever else that
-- requires. The failure is the conversation starter, not the problem.
--
-- Run against a live database with `pnpm db:contract`, and against the local replay as part
-- of `pnpm db:verify`.

\set ON_ERROR_STOP on

DO $$
DECLARE
    expected text[][] := ARRAY[
        -- Captured 2026-08-28 from nktmgdeeiukjimkwkylo.
        ['current_client_space_ids',    'b4d4743e37ec81f7860a6944e01fba3f'],
        ['current_project_ids',         '8fe0cbb612ad0489ddac3a8a4c6fc549'],
        ['manageable_client_space_ids', '9ba3ba4fc94bddb294cbb9b27d86cb9f'],
        ['manageable_project_ids',      '638b3f7017a8f95b03fb3ad25b02e606']
    ];
    fn      text;
    want    text;
    got     text;
    drifted text[] := ARRAY[]::text[];
    i       integer;
BEGIN
    FOR i IN 1 .. array_length(expected, 1) LOOP
        fn   := expected[i][1];
        want := expected[i][2];

        SELECT md5(pg_get_functiondef(p.oid)) INTO got
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = fn;

        IF got IS NULL THEN
            -- Gone entirely. Our policies would start raising, so this is loud rather than
            -- silent — but it still means authorization is broken.
            drifted := drifted || (fn || ' MISSING');
        ELSIF got <> want THEN
            drifted := drifted || (fn || ' changed (' || got || ')');
        END IF;
    END LOOP;

    IF array_length(drifted, 1) > 0 THEN
        RAISE EXCEPTION E'the authorization contract has drifted:\n    %\n\n'
            'Read the new definition(s) and work out the effect on runner.* access before '
            'updating the pins in db/contract.sql.', array_to_string(drifted, E'\n    ');
    END IF;

    RAISE NOTICE 'contract: ok (% helper functions pinned)', array_length(expected, 1);
END $$;
