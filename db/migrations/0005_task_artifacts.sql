--------------------------------------------------------------------------------
-- Task artifacts — what an agent draws before it builds
--------------------------------------------------------------------------------
-- A run currently produces exactly two things a person can look at: an event log and a pull
-- request. Everything in between — the diagram the design stage worked out, the comparison it
-- weighed, the schema it settled on — exists only as prose in the log, and the stage after it
-- cannot read prose.
--
-- So: named artifacts, written by a stage and readable by the stages that follow it. Attached to
-- a task, and listable for the whole project, which is the shape asked for: you look at one
-- task's diagram while reviewing it, and at the project's when you want to know what has been
-- decided.
--
-- Three kinds, not a content type. `kind` admits exactly what the preview can render — html,
-- markdown, mermaid — where a content-type string admits a hundred values that mean the same
-- thing and several that mean "execute this". The preview branches on three cases; the column
-- says three.
--
-- The body lives here rather than in S3. Diagrams and notes are kilobytes, the control plane is
-- already the only thing a container can talk to, and putting them in the bucket would buy
-- presigned reads, a lifecycle policy and a second failure mode for no benefit at this size. The
-- cap below is what keeps that true: an artifact is something to read, not somewhere to put a
-- build output.

CREATE TABLE IF NOT EXISTS "runner"."task_artifacts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "client_space_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "task_id" uuid NOT NULL REFERENCES "public"."tasks"("id") ON DELETE CASCADE,
    /*
     * Which run and stage produced it. Both nullable: an artifact may outlive the run that wrote
     * it — runs are pruned, artifacts are the point — and a person may add one by hand with no
     * run behind it at all.
     *
     * `ON DELETE SET NULL` rather than CASCADE for the same reason: losing the diagram because
     * its run was tidied away would defeat the feature.
     */
    "run_id" uuid REFERENCES "runner"."runs"("id") ON DELETE SET NULL,
    "stage" text,
    -- How a stage refers to it, and how it is overwritten. See the unique index below.
    "name" text NOT NULL,
    "kind" text NOT NULL,
    "title" text,
    "body" text NOT NULL,
    -- Stored rather than computed on read: the list view shows sizes, and `length()` over every
    -- body to render a list is a table scan of the largest column in the row.
    "bytes" integer NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,

    -- The composite reference the other runner tables use: a project row carries its space, so
    -- an artifact cannot claim a project belonging to a different one.
    CONSTRAINT "task_artifacts_project_in_space" FOREIGN KEY ("project_id", "client_space_id")
        REFERENCES "public"."projects" ("id", "client_space_id") ON DELETE CASCADE,

    CONSTRAINT "task_artifacts_name_not_blank" CHECK (length(btrim("name")) > 0),
    -- Exactly what the preview can render. A kind it cannot render is a blank pane, and the
    -- agent finds out from the tool call rather than from somebody opening it a day later.
    CONSTRAINT "task_artifacts_kind" CHECK ("kind" IN ('html', 'markdown', 'mermaid')),
    /*
     * A megabyte, in bytes rather than characters.
     *
     * `length()` counts characters, so a body of multi-byte text would pass a character check
     * and still be a multiple of the intended size on disk and on the wire. The cap exists to
     * keep "the body lives in Postgres" true — and to stop an agent writing a build output here
     * instead of a diagram.
     */
    CONSTRAINT "task_artifacts_body_size" CHECK (octet_length("body") <= 1048576),
    CONSTRAINT "task_artifacts_bytes_match" CHECK ("bytes" = octet_length("body"))
);

/*
 * A name is how an artifact is referred to and overwritten.
 *
 * Unique per task, so a stage that re-renders `architecture.mmd` replaces it rather than leaving
 * two versions with no way to tell which is current. The lesson is recent: a blind insert
 * against a partial unique index is how the stage editor came to fail on every second save.
 */
CREATE UNIQUE INDEX IF NOT EXISTS "task_artifacts_task_name_uniq"
    ON "runner"."task_artifacts" ("task_id", "name");

-- The two ways they are read: one task's, and the project's most recent.
CREATE INDEX IF NOT EXISTS "task_artifacts_task_idx"
    ON "runner"."task_artifacts" ("task_id");
CREATE INDEX IF NOT EXISTS "task_artifacts_project_recent_idx"
    ON "runner"."task_artifacts" ("project_id", "updated_at" DESC);

--------------------------------------------------------------------------------
-- Row level security
--------------------------------------------------------------------------------
ALTER TABLE "runner"."task_artifacts" ENABLE ROW LEVEL SECURITY;

-- Idempotent, so the migration converges rather than assuming absence.
DROP POLICY IF EXISTS "task_artifacts_select" ON "runner"."task_artifacts";
DROP POLICY IF EXISTS "task_artifacts_write" ON "runner"."task_artifacts";

CREATE POLICY "task_artifacts_select" ON "runner"."task_artifacts"
    FOR SELECT TO "authenticated"
    USING (
        "client_space_id" IN (SELECT "public"."current_client_space_ids"())
        AND "project_id" IN (SELECT "public"."current_project_ids"())
    );

-- Project scope only. Unlike a stage template there is no space-wide artifact: it belongs to a
-- task, and a task belongs to exactly one project.
CREATE POLICY "task_artifacts_write" ON "runner"."task_artifacts"
    TO "authenticated"
    USING ("project_id" IN (SELECT "public"."manageable_project_ids"()))
    WITH CHECK ("project_id" IN (SELECT "public"."manageable_project_ids"()));
