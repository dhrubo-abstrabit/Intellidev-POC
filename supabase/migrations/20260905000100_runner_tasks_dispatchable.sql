-- Makes public.tasks dispatchable by a person.
--
-- This is the ONLY migration in this repo that touches `public`, and it is isolated in its own
-- file for that reason: it can be reviewed on its own, reverted on its own, or handed to the
-- team that owns the product schema to apply from their side instead. See DATABASE.md.
--
-- Everything here is additive. No column is dropped, renamed or retyped; no enum is altered;
-- no index is invalidated. Three defaults and one new policy.

--------------------------------------------------------------------------------
-- Defaults for columns that only an LLM pipeline could fill
--------------------------------------------------------------------------------
-- These three are NOT NULL and were written for generated tasks. A person creating a task has
-- no answer for any of them, and the alternative to a default is every insert site inventing
-- one — which is how they end up inconsistent.

-- A person's task is not a guess. The CHECK constrains this to 0..1, so 1.0 is the honest
-- value for "asserted, not inferred".
ALTER TABLE "public"."tasks" ALTER COLUMN "confidence" SET DEFAULT 1.0;

-- Their board indexes are all ordered by for_date, so a dispatched task needs one to appear
-- at all. Today is the only sensible answer for work created now.
ALTER TABLE "public"."tasks" ALTER COLUMN "for_date" SET DEFAULT CURRENT_DATE;

-- dedupe_hash exists so the generator does not raise the same task twice, and
-- tasks_open_dedupe_uniq makes it UNIQUE per space across open tasks. A human task has
-- nothing to deduplicate against, so it needs a value that cannot collide — deliberately
-- random rather than derived from the title, because two people asking for the same thing on
-- purpose must both succeed.
ALTER TABLE "public"."tasks" ALTER COLUMN "dedupe_hash" SET DEFAULT gen_random_uuid()::text;

--------------------------------------------------------------------------------
-- An INSERT policy, which did not exist
--------------------------------------------------------------------------------
-- public.tasks has SELECT and UPDATE policies for `authenticated` but no INSERT policy, so
-- until now tasks could only be created by the service role — correct while the ingest
-- pipeline was the only author, and the reason dispatching from the UI would have failed
-- with a bare RLS violation.
--
-- Deliberately stricter than their tasks_update policy, which uses current_* and therefore
-- lets a viewer edit. Creating a task that an agent will act on spends compute and touches a
-- repository, so it requires manage-level access. Widening it later is easy; discovering that
-- a viewer could dispatch runs would not be.

-- Dropped first so this migration converges rather than assuming absence.
--
-- A schema dump snapshots the *live* schema, so once this has been applied the committed
-- baseline contains this very policy — and `db:verify`, which replays baseline then migrations,
-- would fail on "policy already exists". The ALTER COLUMN statements above are naturally
-- idempotent; this one has to be made so. The end state is what matters, and
-- supabase/verify/checks.sql
-- is what asserts it.
DROP POLICY IF EXISTS "tasks_insert" ON "public"."tasks";

CREATE POLICY "tasks_insert" ON "public"."tasks"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        "client_space_id" IN (SELECT "public"."manageable_client_space_ids"())
        OR (
            "project_id" IS NOT NULL
            AND "project_id" IN (SELECT "public"."manageable_project_ids"())
        )
    );
