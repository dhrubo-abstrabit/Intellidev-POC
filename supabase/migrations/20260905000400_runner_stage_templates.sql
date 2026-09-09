--------------------------------------------------------------------------------
-- Stage templates — which stages a task runs, in what order
--------------------------------------------------------------------------------
-- Until now every run used one template compiled into the source. That is wrong in two
-- directions at once: a client space cannot decide that its work needs a review stage, and a
-- single task cannot skip one that does not apply to it.
--
-- Stored as JSONB rather than as a table of stage rows. The shape is already defined and
-- validated by `StageTemplate` in packages/shared, a template is always read and written whole,
-- and the ordering *is* the array — a `position` column would be a second source of truth for
-- something the array already says. Normalising it would buy joins nobody needs and invite a
-- template whose rows disagree about their own order.
--
-- Two scopes, mirroring integrations:
--
--   project_id IS NULL      the client space's template, shared by every project in it
--   project_id IS NOT NULL  a project's own, which overrides the space's
--
-- A task then either points at one or carries its own inline stages, so the resolution order is
-- task inline → task's chosen template → project default → space default → the built-in one.
-- Every level is optional, and the built-in default is what makes an unconfigured space work
-- exactly as it does today.

CREATE TABLE IF NOT EXISTS "runner"."stage_templates" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "client_space_id" uuid NOT NULL,
    -- NULL means the space's own template. Not a separate table, because the two differ only in
    -- scope and every query wants both.
    "project_id" uuid,
    "name" text NOT NULL,
    "description" text,
    -- The `stages` array of a StageTemplate, validated by zod on the way in and out. A CHECK
    -- constraint here could only assert that it is an array, which the application already
    -- knows, and would drift from the schema that matters.
    "stages" jsonb NOT NULL,
    /*
     * Exactly one default per scope, enforced below.
     *
     * "Default" is what a new task picks up without anyone choosing. Two defaults in one scope
     * would make dispatch depend on row order, which is the kind of bug that appears once a
     * month and cannot be reproduced.
     */
    "is_default" boolean NOT NULL DEFAULT false,
    "created_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,

    -- The same composite reference the other runner tables use: a project row carries its space,
    -- so a template cannot claim a project that belongs to a different one.
    CONSTRAINT "stage_templates_project_in_space" FOREIGN KEY ("project_id", "client_space_id")
        REFERENCES "public"."projects" ("id", "client_space_id") ON DELETE CASCADE,

    CONSTRAINT "stage_templates_name_not_blank" CHECK (length(btrim("name")) > 0)
);

-- One default per space, and one per project. Partial indexes rather than a single unique on
-- (space, project, is_default), because `project_id` is NULL for a space template and NULL is
-- distinct from itself in a unique index — which would let a space have any number of defaults.
CREATE UNIQUE INDEX IF NOT EXISTS "stage_templates_one_space_default"
    ON "runner"."stage_templates" ("client_space_id")
    WHERE "project_id" IS NULL AND "is_default";

CREATE UNIQUE INDEX IF NOT EXISTS "stage_templates_one_project_default"
    ON "runner"."stage_templates" ("project_id")
    WHERE "project_id" IS NOT NULL AND "is_default";

-- Names are how people refer to these, so they are unique within a scope.
CREATE UNIQUE INDEX IF NOT EXISTS "stage_templates_space_name_uniq"
    ON "runner"."stage_templates" ("client_space_id", "name")
    WHERE "project_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "stage_templates_project_name_uniq"
    ON "runner"."stage_templates" ("project_id", "name")
    WHERE "project_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "stage_templates_space_idx"
    ON "runner"."stage_templates" ("client_space_id");

--------------------------------------------------------------------------------
-- What a task runs
--------------------------------------------------------------------------------
-- Two columns rather than one, because they answer different questions.
--
-- `stage_template_id` is "use that saved template", which is the common case and keeps a task
-- following a template that is later edited. `stages` is "this task, specifically, runs these" —
-- a one-off that must not change under the task afterwards. A task carrying an inline array is
-- pinned to it; that is the point of having both.

ALTER TABLE "runner"."task_specs"
    ADD COLUMN IF NOT EXISTS "stage_template_id" uuid
        REFERENCES "runner"."stage_templates"("id") ON DELETE SET NULL;

ALTER TABLE "runner"."task_specs"
    ADD COLUMN IF NOT EXISTS "stages" jsonb;

CREATE INDEX IF NOT EXISTS "task_specs_stage_template_idx"
    ON "runner"."task_specs" ("stage_template_id");

--------------------------------------------------------------------------------
-- Durable run state, so an approval can outlive its container
--------------------------------------------------------------------------------
-- The stage engine already resumes from a cursor it loads from a state store. That store wrote a
-- file inside the container, which is sufficient for a run that never stops and useless for one
-- that does: a Fargate task that pauses for approval is *destroyed*, and its state with it.
--
-- Kept here so a resumed run reads what the previous container wrote. This is the whole reason
-- an approval can cost nothing while it waits — the alternative is a container idling for hours,
-- billed by the second, holding state it could have written down.
--
-- Its own column rather than a table: exactly one state per run, always read and written whole.

ALTER TABLE "runner"."runs"
    ADD COLUMN IF NOT EXISTS "engine_state" jsonb;

--------------------------------------------------------------------------------
-- RLS
--------------------------------------------------------------------------------
ALTER TABLE "runner"."stage_templates" ENABLE ROW LEVEL SECURITY;

-- Idempotent, so this migration converges rather than assuming absence — the baseline snapshot
-- includes whatever has already been applied.
DROP POLICY IF EXISTS "stage_templates_select" ON "runner"."stage_templates";
DROP POLICY IF EXISTS "stage_templates_write_space" ON "runner"."stage_templates";
DROP POLICY IF EXISTS "stage_templates_write_project" ON "runner"."stage_templates";

CREATE POLICY "stage_templates_select" ON "runner"."stage_templates"
    FOR SELECT TO "authenticated"
    USING (
        "client_space_id" IN (SELECT "public"."current_client_space_ids"())
        AND ("project_id" IS NULL OR "project_id" IN (SELECT "public"."current_project_ids"()))
    );

-- Writes split by scope, exactly as integrations does, and for the same reason: a project member
-- may shape their own project's flow without being able to change what every other project in
-- the space inherits.
CREATE POLICY "stage_templates_write_space" ON "runner"."stage_templates"
    TO "authenticated"
    USING (
        "project_id" IS NULL
        AND "client_space_id" IN (SELECT "public"."manageable_client_space_ids"())
    )
    WITH CHECK (
        "project_id" IS NULL
        AND "client_space_id" IN (SELECT "public"."manageable_client_space_ids"())
    );

CREATE POLICY "stage_templates_write_project" ON "runner"."stage_templates"
    TO "authenticated"
    USING (
        "project_id" IS NOT NULL
        AND "project_id" IN (SELECT "public"."manageable_project_ids"())
    )
    WITH CHECK (
        "project_id" IS NOT NULL
        AND "project_id" IN (SELECT "public"."manageable_project_ids"())
    );
