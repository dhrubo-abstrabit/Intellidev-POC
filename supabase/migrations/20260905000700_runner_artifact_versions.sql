--------------------------------------------------------------------------------
-- Artifact versions — an iteration is a version, not a second artifact
--------------------------------------------------------------------------------
-- Writing a name that already exists replaced its content, and the previous content was gone.
-- That is the wrong half of the right instinct: an agent redrawing `architecture.mmd` means to
-- revise *that* diagram rather than leave two, but the earlier attempt is often the better one
-- and there was no way back to it.
--
-- So an artifact becomes an identity — a task and a name — and its content becomes a series of
-- versions. `current_version` is a pointer, which makes switching a person's decision costing
-- one column update rather than a copy of the bytes back over the top. Copying would also make
-- "which version am I looking at" unanswerable, since the copy is indistinguishable from a new
-- revision.
--
-- Content lives in exactly one place, the version row. The identity row keeps no body at all:
-- two possible homes for the same bytes is how they come to disagree, and the columns that held
-- them are dropped below *after* the copy.

CREATE TABLE IF NOT EXISTS "runner"."task_artifact_versions" (
    "artifact_id" uuid NOT NULL
        REFERENCES "runner"."task_artifacts"("id") ON DELETE CASCADE,
    /*
     * Monotonic per artifact, starting at 1.
     *
     * Assigned by the writer inside a transaction, not by a sequence: it has to be dense and
     * per-artifact, and a global sequence would number them 1, 7, 12 — which reads like versions
     * are missing.
     */
    "version" integer NOT NULL,

    /*
     * What the bytes are and how to show them, per version.
     *
     * On the version rather than the identity because they describe the content: a note that
     * gains a diagram may legitimately move from markdown to mermaid, and each version must
     * still be served as what it actually is.
     */
    "kind" text NOT NULL,
    "content_type" text NOT NULL,
    "title" text,

    -- Where this version's bytes live. Same two homes, same invariant as before.
    "storage" text NOT NULL,
    "body" text,
    "storage_key" text,
    "sha256" text NOT NULL,
    "bytes" integer NOT NULL,

    /*
     * Which run and stage produced *this version*.
     *
     * Previously these were on the artifact, so an overwrite lost who wrote the earlier
     * content — which is exactly the question a version history exists to answer.
     */
    "run_id" uuid REFERENCES "runner"."runs"("id") ON DELETE SET NULL,
    "stage" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,

    PRIMARY KEY ("artifact_id", "version"),

    CONSTRAINT "artifact_versions_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "artifact_versions_kind"
        CHECK ("kind" IN ('html', 'markdown', 'mermaid', 'image', 'file')),
    CONSTRAINT "artifact_versions_storage" CHECK ("storage" IN ('inline', 's3')),
    -- Exactly one home, and the one the row claims. See 0006.
    CONSTRAINT "artifact_versions_home" CHECK (
        ("storage" = 'inline' AND "body" IS NOT NULL AND "storage_key" IS NULL)
        OR ("storage" = 's3' AND "storage_key" IS NOT NULL AND "body" IS NULL)
    ),
    CONSTRAINT "artifact_versions_body_size"
        CHECK ("body" IS NULL OR octet_length("body") <= 1048576),
    CONSTRAINT "artifact_versions_bytes_match"
        CHECK ("storage" <> 'inline' OR "bytes" = octet_length("body"))
);

-- One object per version, so superseding one cannot orphan bytes in the bucket under a key
-- nothing references.
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_versions_storage_key_uniq"
    ON "runner"."task_artifact_versions" ("storage_key")
    WHERE "storage_key" IS NOT NULL;

-- Newest first, which is how a history is read.
CREATE INDEX IF NOT EXISTS "artifact_versions_recent_idx"
    ON "runner"."task_artifact_versions" ("artifact_id", "version" DESC);

--------------------------------------------------------------------------------
-- Which version an artifact is currently showing
--------------------------------------------------------------------------------
ALTER TABLE "runner"."task_artifacts"
    ADD COLUMN IF NOT EXISTS "current_version" integer;

--------------------------------------------------------------------------------
-- Move the existing content into version 1, before the columns go
--------------------------------------------------------------------------------
INSERT INTO "runner"."task_artifact_versions" (
    "artifact_id", "version", "kind", "content_type", "title",
    "storage", "body", "storage_key", "sha256", "bytes",
    "run_id", "stage", "created_at"
)
SELECT "id", 1, "kind", "content_type", "title",
       "storage", "body", "storage_key",
       -- 0006 added `sha256` as nullable; anything written before it has none to carry over.
       COALESCE("sha256", encode(digest(COALESCE("body", ''), 'sha256'), 'hex')),
       "bytes", "run_id", "stage", "created_at"
  FROM "runner"."task_artifacts"
 WHERE NOT EXISTS (
     SELECT 1 FROM "runner"."task_artifact_versions" v WHERE v."artifact_id" = "runner"."task_artifacts"."id"
 );

UPDATE "runner"."task_artifacts" SET "current_version" = 1 WHERE "current_version" IS NULL;

ALTER TABLE "runner"."task_artifacts" ALTER COLUMN "current_version" SET NOT NULL;

--------------------------------------------------------------------------------
-- One home for the bytes
--------------------------------------------------------------------------------
-- Dropped after the copy above. Leaving them would leave a second place an artifact's content
-- could appear to live, and the next person to read this schema would have to work out which
-- one wins. The constraints that referenced them go with them.
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_home";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_body_size";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_bytes_match";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_storage";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_kind";
DROP INDEX IF EXISTS "runner"."task_artifacts_storage_key_uniq";

ALTER TABLE "runner"."task_artifacts"
    DROP COLUMN IF EXISTS "body",
    DROP COLUMN IF EXISTS "storage",
    DROP COLUMN IF EXISTS "storage_key",
    DROP COLUMN IF EXISTS "sha256",
    DROP COLUMN IF EXISTS "bytes",
    DROP COLUMN IF EXISTS "content_type",
    DROP COLUMN IF EXISTS "kind",
    DROP COLUMN IF EXISTS "title",
    -- Which run and stage wrote it is now a property of each version, where it belongs.
    DROP COLUMN IF EXISTS "run_id",
    DROP COLUMN IF EXISTS "stage";

/*
 * `current_version` must name a version that exists.
 *
 * Deferrable, because creating an artifact writes the identity row and its first version in one
 * transaction — and one of the two has to be inserted first. Checked at commit, which is when
 * the pair is either coherent or not.
 */
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_current_version";
ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_current_version"
    FOREIGN KEY ("id", "current_version")
    REFERENCES "runner"."task_artifact_versions" ("artifact_id", "version")
    DEFERRABLE INITIALLY DEFERRED;

--------------------------------------------------------------------------------
-- Row level security on the versions
--------------------------------------------------------------------------------
ALTER TABLE "runner"."task_artifact_versions" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "artifact_versions_select" ON "runner"."task_artifact_versions";
DROP POLICY IF EXISTS "artifact_versions_write" ON "runner"."task_artifact_versions";

/*
 * A version is visible exactly when its artifact is.
 *
 * Expressed as a lookup through the parent rather than by copying `project_id` onto every
 * version row. Denormalising it would be faster to check and would introduce a second place the
 * tenancy could be wrong — and a version whose project disagreed with its artifact's is a
 * cross-tenant read waiting to happen.
 */
CREATE POLICY "artifact_versions_select" ON "runner"."task_artifact_versions"
    FOR SELECT TO "authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "runner"."task_artifacts" a
             WHERE a."id" = "artifact_id"
               AND a."client_space_id" IN (SELECT "public"."current_client_space_ids"())
               AND a."project_id" IN (SELECT "public"."current_project_ids"())
        )
    );

CREATE POLICY "artifact_versions_write" ON "runner"."task_artifact_versions"
    TO "authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "runner"."task_artifacts" a
             WHERE a."id" = "artifact_id"
               AND a."project_id" IN (SELECT "public"."manageable_project_ids"())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "runner"."task_artifacts" a
             WHERE a."id" = "artifact_id"
               AND a."project_id" IN (SELECT "public"."manageable_project_ids"())
        )
    );

--------------------------------------------------------------------------------
-- Grants the earlier migrations forgot
--------------------------------------------------------------------------------
-- FOUND BY AUDITING THEM. `stage_templates` (0004) and `task_artifacts` (0005) were created with
-- RLS enabled and policies written, and *no grants at all* — not even to `service_role`. Both
-- have worked the whole time because the control plane connects as the owning role, which is
-- exempt from both. The effect was more restrictive than intended rather than less, but it also
-- meant every policy on those two tables was unreachable: a missing GRANT denies the table
-- outright, so the rules describing who may read what have never once been consulted.
--
-- 0000 says this in as many words, and adds them per table precisely "so a table added later
-- does not silently inherit access" — which is exactly what happened. `GRANT ALL ON ALL TABLES`
-- there was a point-in-time statement and does not reach a table created afterwards.

-- Its policies split writes by scope — a project member may shape their own project's flow
-- without changing what every other project in the space inherits — so all four are granted and
-- the policies decide.
GRANT SELECT, INSERT, UPDATE, DELETE ON "runner"."stage_templates" TO "authenticated";

-- Reads only. Writing an artifact routes its bytes between two homes and appends a version, and
-- a direct INSERT would produce a row with no version at all — so that path stays with the
-- control plane, which is the only thing that knows how.
GRANT SELECT ON "runner"."task_artifacts"         TO "authenticated";
GRANT SELECT ON "runner"."task_artifact_versions" TO "authenticated";

GRANT ALL ON "runner"."stage_templates"           TO "service_role";
GRANT ALL ON "runner"."task_artifacts"            TO "service_role";
GRANT ALL ON "runner"."task_artifact_versions"    TO "service_role";
