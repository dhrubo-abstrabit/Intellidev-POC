--------------------------------------------------------------------------------
-- Artifacts that are not text
--------------------------------------------------------------------------------
-- 0005 stored every artifact body in a column, which is right for a diagram and wrong for a
-- screenshot. This makes the *home* of the bytes a property of the row rather than an assumption
-- of the schema, so adding images, PDFs or a large export later is a routing decision and not a
-- migration against a live table.
--
-- Two homes:
--
--   storage = 'inline'  the bytes are in `body`, as text. Diagrams and notes: kilobytes, read
--                       constantly, and read *as text* by the stages that follow.
--   storage = 's3'      the bytes are an object, and `storage_key` names it. Anything binary or
--                       large enough that a text column is the wrong instrument.
--
-- Explicit rather than inferred from which column is null. "Whichever one is set" is a rule that
-- lives in six places and disagrees in one of them; a discriminator with a CHECK is a rule the
-- database enforces once.
--
-- `content_type` is added alongside `kind` because they answer different questions. `kind` is how
-- to *present* it — draw it as a diagram, render it as markdown, show it as an image — and
-- `content_type` is what the bytes *are*, which is what an HTTP response needs. For text the two
-- are nearly redundant; for `image/png` versus `image/svg+xml` they are not, and guessing one
-- from the other is how an SVG ends up being served as a download.

ALTER TABLE "runner"."task_artifacts"
    -- What the bytes are, for serving them. Defaulted for the rows that already exist.
    ADD COLUMN IF NOT EXISTS "content_type" text NOT NULL DEFAULT 'text/plain; charset=utf-8',
    ADD COLUMN IF NOT EXISTS "storage" text NOT NULL DEFAULT 'inline',
    -- The object's key, when the bytes are not here. Null for an inline artifact.
    ADD COLUMN IF NOT EXISTS "storage_key" text,
    /*
     * The content hash.
     *
     * Not used to deduplicate yet — that is a later decision with its own trade-offs — but
     * stored from the start because it cannot be recovered afterwards for an object whose bytes
     * have moved, and because it is what makes "did this artifact change" answerable without
     * reading a megabyte.
     */
    ADD COLUMN IF NOT EXISTS "sha256" text;

-- Nullable, because an artifact whose bytes live in S3 has no body here. Was NOT NULL in 0005,
-- when a column was the only home there was.
ALTER TABLE "runner"."task_artifacts" ALTER COLUMN "body" DROP NOT NULL;

--------------------------------------------------------------------------------
-- Backfill, before the constraints that would reject the old rows
--------------------------------------------------------------------------------
-- Every existing artifact is inline text, so this is what they already were — written down.
UPDATE "runner"."task_artifacts"
   SET "storage" = 'inline',
       "content_type" = CASE "kind"
           WHEN 'html' THEN 'text/html; charset=utf-8'
           WHEN 'markdown' THEN 'text/markdown; charset=utf-8'
           ELSE 'text/plain; charset=utf-8'
       END,
       "sha256" = encode(digest("body", 'sha256'), 'hex')
 WHERE "sha256" IS NULL;

--------------------------------------------------------------------------------
-- The invariants
--------------------------------------------------------------------------------
-- Dropped first so the migration converges rather than assuming absence.
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_kind";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_storage";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_body_size";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_bytes_match";
ALTER TABLE "runner"."task_artifacts" DROP CONSTRAINT IF EXISTS "task_artifacts_home";

/*
 * The kinds the UI can present.
 *
 * Widened from the three text kinds to include the two that are not text. Still a closed set:
 * a kind nothing can render is a blank pane, and the write should fail rather than a person
 * discover it a day later.
 *
 *   image  shown as a picture — png, jpeg, svg, webp
 *   file   offered as a download, with no attempt to render it
 */
ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_kind"
    CHECK ("kind" IN ('html', 'markdown', 'mermaid', 'image', 'file'));

ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_storage" CHECK ("storage" IN ('inline', 's3'));

/*
 * Exactly one home, and it is the one the row claims.
 *
 * Without this a row can say `inline` while its body is null and its key is set — readable in
 * neither direction, and discovered by a preview showing nothing. The pairing is the invariant
 * worth spending a constraint on.
 */
ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_home" CHECK (
        ("storage" = 'inline' AND "body" IS NOT NULL AND "storage_key" IS NULL)
        OR ("storage" = 's3' AND "storage_key" IS NOT NULL AND "body" IS NULL)
    );

/*
 * A megabyte for an inline body, in bytes rather than characters.
 *
 * `length()` counts characters, so multi-byte text would pass a character check and still be a
 * multiple of the intended size on disk and on the wire. The cap is what keeps "inline means
 * small" true; anything larger belongs in the other home, and that is now a routing decision
 * rather than a refusal.
 */
ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_body_size"
    CHECK ("body" IS NULL OR octet_length("body") <= 1048576);

-- `bytes` is the size of the content, wherever it lives — so it can only be checked against the
-- body when the body is here.
ALTER TABLE "runner"."task_artifacts"
    ADD CONSTRAINT "task_artifacts_bytes_match"
    CHECK ("storage" <> 'inline' OR "bytes" = octet_length("body"));

-- One object per artifact, so a re-render cannot leave the previous bytes orphaned in the bucket
-- under a key nothing references.
CREATE UNIQUE INDEX IF NOT EXISTS "task_artifacts_storage_key_uniq"
    ON "runner"."task_artifacts" ("storage_key")
    WHERE "storage_key" IS NOT NULL;
