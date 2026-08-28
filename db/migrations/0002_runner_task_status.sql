-- The runner's own task status, alongside the product's.
--
-- `public.task_status` has five values (pending, in_progress, done, dismissed, snoozed) and
-- the runner's state machine has eight. The mapping is not injective — dispatched, running,
-- waiting_capacity and in_review all mean `in_progress` on their board — so the runner's
-- status cannot be recovered from theirs and has to be stored.
--
-- Not solved by adding values to their enum: every index on public.tasks is partial on
-- `status IN ('pending','in_progress')`, so a task in a new state would silently drop out of
-- tasks_board_idx, tasks_open_dedupe_uniq, tasks_embedding_idx and the rest — invisible on
-- their board and no longer deduplicated. Their enum stays as it is, and gets the coarse
-- projection of ours.

ALTER TABLE "runner"."task_specs"
    ADD COLUMN IF NOT EXISTS "runner_status" text DEFAULT 'not_started' NOT NULL;

-- The vocabulary from packages/shared/src/ids.ts. Duplicated here on purpose: a status the
-- application does not know how to transition should not be storable, and a CHECK is the only
-- place that holds when a write comes from somewhere other than the control plane.
ALTER TABLE "runner"."task_specs"
    DROP CONSTRAINT IF EXISTS "task_specs_runner_status_check";
ALTER TABLE "runner"."task_specs"
    ADD CONSTRAINT "task_specs_runner_status_check" CHECK (
        "runner_status" IN (
            'not_started', 'dispatched', 'running', 'waiting_capacity',
            'in_review', 'done', 'blocked', 'failed'
        )
    );

-- The board reads open work by status, and the reconciler looks for tasks whose runner status
-- disagrees with their runs.
CREATE INDEX IF NOT EXISTS "task_specs_runner_status_idx"
    ON "runner"."task_specs" ("runner_status");

--------------------------------------------------------------------------------
-- The projection onto the product's status
--------------------------------------------------------------------------------
-- A function rather than a trigger, and rather than logic in TypeScript.
--
-- Not a trigger, because a task's product status is also a human's to change — dismissing or
-- snoozing a task is their prerogative, and a trigger firing on every runner status change
-- would fight that. The control plane calls this when it advances a run, which is exactly when
-- the projection should move.
--
-- Not in TypeScript, because the mapping is a property of the two vocabularies rather than of
-- one caller, and the same collapse would then have to be repeated by anything else that
-- writes a runner status.

CREATE OR REPLACE FUNCTION "runner"."product_status"("p_runner_status" text)
    RETURNS "public"."task_status"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE "p_runner_status"
    WHEN 'not_started'      THEN 'pending'
    -- Every in-flight runner state collapses to in_progress. The detail a person wants —
    -- which stage, which branch, the PR link — lives on runner.runs, where it can be shown
    -- without inventing statuses their board cannot index.
    WHEN 'dispatched'       THEN 'in_progress'
    WHEN 'running'          THEN 'in_progress'
    WHEN 'waiting_capacity' THEN 'in_progress'
    WHEN 'in_review'        THEN 'in_progress'
    WHEN 'done'             THEN 'done'
    -- Both stay open rather than becoming 'dismissed': a failed or blocked task is still work
    -- somebody wants doing, and dismissing it would hide it from the board that exists to
    -- surface exactly that.
    WHEN 'failed'           THEN 'pending'
    WHEN 'blocked'          THEN 'pending'
  END::"public"."task_status"
$$;

GRANT EXECUTE ON FUNCTION "runner"."product_status"(text) TO "authenticated", "service_role";
