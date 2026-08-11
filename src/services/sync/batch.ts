import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { enqueueJob } from "@/lib/queue";
import { projectDayKey, utcWindowForDay } from "@/lib/date/project-day";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type BatchMemberOutcome = "succeeded" | "failed" | "enqueue_failed" | "timed_out";

/**
 * Creates (or reuses, if this project/day was already seeded — e.g. a
 * retried cron invocation) the coordination row for "every one of this
 * project's due integrations must report in before extraction runs for
 * batchDate", plus one membership row per integration. Idempotent: safe to
 * call more than once for the same (project, batchDate).
 */
export async function seedBatchForProject(
  service: ServiceClient,
  params: { workspaceId: string; projectId: string; batchDate: string; integrationIds: string[] },
): Promise<string> {
  const { workspaceId, projectId, batchDate, integrationIds } = params;

  const { data: existing } = await service
    .from("sync_batches")
    .select("id")
    .eq("project_id", projectId)
    .eq("batch_date", batchDate)
    .maybeSingle();

  let batchId = existing?.id;
  if (!batchId) {
    const { data: inserted, error } = await service
      .from("sync_batches")
      .insert({ workspace_id: workspaceId, project_id: projectId, batch_date: batchDate })
      .select("id")
      .single();
    if (error) {
      // Unique violation on (project_id, batch_date) means a concurrent
      // caller won the insert race — reuse its row rather than erroring.
      if (error.code !== "23505") throw new Error(`Could not seed sync batch: ${error.message}`);
      const { data: raceRow, error: raceError } = await service
        .from("sync_batches")
        .select("id")
        .eq("project_id", projectId)
        .eq("batch_date", batchDate)
        .single();
      if (raceError || !raceRow) throw new Error(`Could not resolve concurrently-seeded sync batch: ${raceError?.message}`);
      batchId = raceRow.id;
    } else {
      batchId = inserted.id;
    }
  }

  if (integrationIds.length > 0) {
    await service.from("sync_batch_members").upsert(
      integrationIds.map((integrationId) => ({ batch_id: batchId, integration_id: integrationId, workspace_id: workspaceId })),
      { onConflict: "batch_id,integration_id", ignoreDuplicates: true },
    );
  }

  return batchId;
}

export type SettleBatchResult = { inBatch: false } | { inBatch: true; firedLlmJob: boolean };

/**
 * Reports one integration as done (terminal — no further chaining) for its
 * project's batch on batchDate, and fires the day's LLM job exactly once,
 * the moment every member has reported in. Race-safe via two independent
 * conditional updates (`WHERE completed_at IS NULL` / `WHERE
 * llm_triggered_at IS NULL`), each a single-statement compare-and-swap that
 * Postgres serializes via ordinary row locking — no counter arithmetic, no
 * custom RPC.
 *
 * Returns `{inBatch: false}` when this integration isn't part of any active
 * batch for batchDate (batch never seeded, or this integration wasn't due
 * at cron time) — callers should fall back to their own immediate-trigger
 * behavior in that case.
 */
export async function settleBatchMembership(
  service: ServiceClient,
  params: { projectId: string; integrationId: string; batchDate: string; outcome: BatchMemberOutcome },
): Promise<SettleBatchResult> {
  const { projectId, integrationId, batchDate, outcome } = params;

  const { data: batch } = await service
    .from("sync_batches")
    .select("id, llm_triggered_at")
    .eq("project_id", projectId)
    .eq("batch_date", batchDate)
    .maybeSingle();
  if (!batch) return { inBatch: false };

  const { data: member } = await service
    .from("sync_batch_members")
    .select("id")
    .eq("batch_id", batch.id)
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (!member) return { inBatch: false };

  const nowIso = new Date().toISOString();
  const { data: claimed } = await service
    .from("sync_batch_members")
    .update({ completed_at: nowIso, outcome })
    .eq("id", member.id)
    .is("completed_at", null)
    .select("id");
  if (!claimed || claimed.length === 0) {
    // Already settled by an earlier delivery of this same terminal event
    // (QStash is at-least-once) — the caller that won that race already
    // did (or is doing) the remaining-count check below.
    return { inBatch: true, firedLlmJob: false };
  }

  const { count: remaining } = await service
    .from("sync_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batch.id)
    .is("completed_at", null);

  if ((remaining ?? 0) > 0) return { inBatch: true, firedLlmJob: false };

  const { data: won } = await service
    .from("sync_batches")
    .update({ llm_triggered_at: nowIso })
    .eq("id", batch.id)
    .is("llm_triggered_at", null)
    .select("id");

  return { inBatch: true, firedLlmJob: (won?.length ?? 0) === 1 };
}

/** Called by cron tick immediately when publishing an integration's own
 * `/api/jobs/sync` dispatch fails — that integration will never itself call
 * settleBatchMembership, so without this the batch would only ever complete
 * via the 2-hour timeout backstop. */
export async function markMemberEnqueueFailed(
  service: ServiceClient,
  params: { projectId: string; integrationId: string; batchDate: string },
): Promise<SettleBatchResult> {
  return settleBatchMembership(service, { ...params, outcome: "enqueue_failed" });
}

// How far back to sweep for older unprocessed backlog every time a batch
// completes — caps a first-time connector backfill (which can pull in
// months of history in one go) at this many *distinct days* of automatic
// extraction, not a time window. Anything older stays available via the
// manual "Extract for this day" button on the Project Data page. Any day
// that doesn't make the cut this time isn't lost — the same sweep runs again
// the next time this project's batch completes (tomorrow, ordinarily), so
// backlog converges over a few days instead of firing unbounded LLM spend
// in one shot.
const BACKFILL_DAY_CAP = 30;
// Bounds a single scan's read size the same way the Project Data page's own
// day-index query does (DAY_INDEX_ROW_LIMIT) — a scan that hasn't found
// BACKFILL_DAY_CAP distinct days within this many rows just means the rest
// get picked up by a later sweep, not silently dropped forever.
const BACKFILL_SCAN_ROW_LIMIT = 5000;

/**
 * Fires the LLM job for a project's batchDate once its batch is confirmed
 * complete, and sweeps for older unprocessed backlog at the same time (see
 * BACKFILL_DAY_CAP) — the general mechanism a first-time connector backfill
 * relies on to get more than just "today" extracted, but it applies equally
 * to e.g. a connector that was broken for a week and just caught up.
 */
export async function triggerDailyExtraction(service: ServiceClient, projectId: string, date: string): Promise<void> {
  const dates = new Set([date]);

  const { data: project } = await service.from("projects").select("timezone").eq("id", projectId).maybeSingle();
  const timezone = project?.timezone ?? "UTC";

  // utcWindowForDay(date).gte is a full UTC day before date's local
  // midnight at any timezone offset — anything older than that is
  // unambiguously on an earlier project-local day than `date`, so this scan
  // never mis-attributes one of `date`'s own events as "older backlog".
  const { gte: beforeDate } = utcWindowForDay(date);
  const { data: olderRows } = await service
    .from("normalized_events")
    .select("occurred_at")
    .eq("project_id", projectId)
    .is("processed_at", null)
    .lt("occurred_at", beforeDate)
    .order("occurred_at", { ascending: false })
    .limit(BACKFILL_SCAN_ROW_LIMIT);

  for (const row of olderRows ?? []) {
    if (dates.size >= BACKFILL_DAY_CAP) break;
    dates.add(projectDayKey(row.occurred_at, timezone));
  }
  if (olderRows?.length === BACKFILL_SCAN_ROW_LIMIT && dates.size < BACKFILL_DAY_CAP) {
    console.warn(
      `[sync] project ${projectId}: backlog scan hit its ${BACKFILL_SCAN_ROW_LIMIT}-row limit before finding ${BACKFILL_DAY_CAP} distinct days — remaining older backlog will be picked up by a future sweep`,
    );
  }

  await Promise.allSettled(
    [...dates].map((d) =>
      enqueueJob("/api/jobs/llm", { projectId, date: d }).catch((err) => {
        console.error(`[sync] failed to enqueue LLM job for project ${projectId} (date ${d}):`, err);
      }),
    ),
  );
}

export type ForceCompleteBatchResult = { projectId: string; batchDate: string; firedLlmJob: boolean };

/**
 * Backstop for a batch that never completed on its own — a lost QStash
 * delivery or a hard function timeout means some integration never reached
 * a terminal state, and with cron running once/day there's no later tick to
 * notice. Called from a delayed job scheduled at batch-seed time (see
 * src/app/api/cron/tick/route.ts). No-ops if the batch already fired
 * normally. Returns null if the batch row itself doesn't exist (shouldn't
 * happen outside test cleanup).
 */
export async function forceCompleteTimedOutBatch(
  service: ServiceClient,
  batchId: string,
): Promise<ForceCompleteBatchResult | null> {
  const { data: batch } = await service
    .from("sync_batches")
    .select("id, project_id, batch_date, llm_triggered_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return null;
  if (batch.llm_triggered_at) return { projectId: batch.project_id, batchDate: batch.batch_date, firedLlmJob: false };

  const nowIso = new Date().toISOString();
  await service
    .from("sync_batch_members")
    .update({ completed_at: nowIso, outcome: "timed_out" })
    .eq("batch_id", batchId)
    .is("completed_at", null);

  const { data: won } = await service
    .from("sync_batches")
    .update({ llm_triggered_at: nowIso })
    .eq("id", batchId)
    .is("llm_triggered_at", null)
    .select("id");

  return { projectId: batch.project_id, batchDate: batch.batch_date, firedLlmJob: (won?.length ?? 0) === 1 };
}
