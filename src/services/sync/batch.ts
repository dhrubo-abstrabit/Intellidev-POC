import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { enqueueJob } from "@/lib/queue";
import { projectDayKey, utcWindowForDay } from "@/lib/date/project-day";

type ServiceClient = ReturnType<typeof createServiceClient>;

export type BatchMemberOutcome = "succeeded" | "failed" | "enqueue_failed" | "timed_out";

/**
 * Creates (or reuses, if this client space/day was already seeded — e.g. a
 * retried cron invocation) the coordination row for "every one of this
 * client space's due project connectors must report in before extraction runs for
 * batchDate", plus one membership row per project connector. Idempotent: safe to
 * call more than once for the same (client space, batchDate).
 *
 * Batched per CLIENT SPACE, not per project (see
 * supabase/migrations/20260901000900_sync.sql) — connectors, events and
 * the daily digest all belong to the client space; a project is a tagged
 * view over a subset of its action items, not a separate data owner.
 *
 * Returns `created: true` only for the call that actually inserted the row —
 * every other call (reused an existing row, or lost the 23505 insert race)
 * gets `false`. The cron tick uses this to enqueue the batch-timeout backstop
 * job exactly once per (space, day) rather than once per tick that happens to
 * see due connectors for a space whose batch already exists (see
 * src/app/api/cron/tick/route.ts) — load-bearing now that the tick runs every
 * minute instead of once a day.
 */
export async function seedBatchForClientSpace(
  service: ServiceClient,
  // No workspaceId: sync_batches is keyed on the client space alone now. The
  // batch is a coordination record for one engagement's daily sync, and every
  // access path to it flows through client_space_id.
  params: { clientSpaceId: string; batchDate: string; projectConnectorIds: string[] },
): Promise<{ batchId: string; created: boolean }> {
  const { clientSpaceId, batchDate, projectConnectorIds } = params;

  const { data: existing } = await service
    .from("sync_batches")
    .select("id")
    .eq("client_space_id", clientSpaceId)
    .eq("batch_date", batchDate)
    .maybeSingle();

  let batchId = existing?.id;
  let created = false;
  if (!batchId) {
    const { data: inserted, error } = await service
      .from("sync_batches")
      .insert({ client_space_id: clientSpaceId, batch_date: batchDate })
      .select("id")
      .single();
    if (error) {
      // Unique violation on (client_space_id, batch_date) means a concurrent
      // caller won the insert race — reuse its row rather than erroring.
      if (error.code !== "23505") throw new Error(`Could not seed sync batch: ${error.message}`);
      const { data: raceRow, error: raceError } = await service
        .from("sync_batches")
        .select("id")
        .eq("client_space_id", clientSpaceId)
        .eq("batch_date", batchDate)
        .single();
      if (raceError || !raceRow) throw new Error(`Could not resolve concurrently-seeded sync batch: ${raceError?.message}`);
      batchId = raceRow.id;
    } else {
      batchId = inserted.id;
      created = true;
    }
  }

  if (projectConnectorIds.length > 0) {
    await service.from("sync_batch_members").upsert(
      projectConnectorIds.map((projectConnectorId) => ({ batch_id: batchId, project_connector_id: projectConnectorId, client_space_id: clientSpaceId })),
      { onConflict: "batch_id,project_connector_id", ignoreDuplicates: true },
    );
  }

  return { batchId, created };
}

export type SettleBatchResult =
  | { inBatch: false }
  | {
      inBatch: true;
      firedLlmJob: boolean;
      /** True when THIS call's own compare-and-swap found its member row
       * already completed — i.e. this connector reported in once already
       * today (normal completion, or an earlier settle from the same run),
       * and is now reporting again with fresh work (e.g. a later manual
       * "Sync Now", or attachment extraction finishing after the batch
       * already fired). The batch-wide "every member done" trigger only
       * ever fires ONCE per (client space, batchDate) by design — a late
       * arrival like this is exactly what callers should treat as "not
       * covered by that one-shot trigger, fire your own" instead of
       * assuming someone else already handled it. False for an ordinary
       * in-progress member (remaining > 0) or the member that itself
       * completed the batch. */
      alreadySettled: boolean;
    };

/**
 * Reports one connector as done (terminal — no further chaining) for its
 * client space's batch on batchDate, and fires the day's LLM job exactly
 * once, the moment every member has reported in. Race-safe via two
 * independent conditional updates (`WHERE completed_at IS NULL` / `WHERE
 * llm_triggered_at IS NULL`), each a single-statement compare-and-swap that
 * Postgres serializes via ordinary row locking — no counter arithmetic, no
 * custom RPC.
 *
 * Returns `{inBatch: false}` when this connector isn't part of any active
 * batch for batchDate (batch never seeded, or this connector wasn't due
 * at cron time) — callers should fall back to their own immediate-trigger
 * behavior in that case. See `alreadySettled` above for the other case
 * callers need to handle explicitly: the batch's one-shot trigger already
 * fired earlier today, and this call is new work arriving after that.
 */
export async function settleBatchMembership(
  service: ServiceClient,
  params: { clientSpaceId: string; projectConnectorId: string; batchDate: string; outcome: BatchMemberOutcome },
): Promise<SettleBatchResult> {
  const { clientSpaceId, projectConnectorId, batchDate, outcome } = params;

  const { data: batch } = await service
    .from("sync_batches")
    .select("id, llm_triggered_at")
    .eq("client_space_id", clientSpaceId)
    .eq("batch_date", batchDate)
    .maybeSingle();
  if (!batch) return { inBatch: false };

  const { data: member } = await service
    .from("sync_batch_members")
    .select("id")
    .eq("batch_id", batch.id)
    .eq("project_connector_id", projectConnectorId)
    .maybeSingle();
  if (!member) return { inBatch: false };

  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await service
    .from("sync_batch_members")
    .update({ completed_at: nowIso, outcome })
    .eq("id", member.id)
    .is("completed_at", null)
    .select("id");
  // Surfaced loudly rather than folded into the "already settled" branch
  // below — a rejected update (e.g. a future outcome value added to
  // BatchMemberOutcome without a matching CHECK-constraint migration, the
  // exact shape of the enqueue_failed/timed_out bug this file used to have)
  // must not silently masquerade as a legitimate race.
  if (claimError) {
    throw new Error(`Could not settle batch member ${member.id} with outcome "${outcome}": ${claimError.message}`);
  }
  if (!claimed || claimed.length === 0) {
    // Already settled — either an earlier delivery of this SAME terminal
    // event (the job queue is at-least-once, in which case the caller that
    // won that race already did/is doing the remaining-count check below),
    // OR this connector produced fresh work AGAIN after already
    // completing its part of today's batch (a second manual "Sync Now", or
    // attachment extraction finishing after the batch's one-shot trigger
    // already fired). Only the caller can tell these apart (it knows
    // whether THIS call actually has new work) — alreadySettled:true is the
    // signal it needs to decide whether to fire its own catch-up trigger.
    return { inBatch: true, firedLlmJob: false, alreadySettled: true };
  }

  const { count: remaining } = await service
    .from("sync_batch_members")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batch.id)
    .is("completed_at", null);

  if ((remaining ?? 0) > 0) return { inBatch: true, firedLlmJob: false, alreadySettled: false };

  const { data: won, error: wonError } = await service
    .from("sync_batches")
    .update({ llm_triggered_at: nowIso })
    .eq("id", batch.id)
    .is("llm_triggered_at", null)
    .select("id");
  if (wonError) {
    throw new Error(`Could not mark batch ${batch.id} extraction-triggered: ${wonError.message}`);
  }

  return { inBatch: true, firedLlmJob: (won?.length ?? 0) === 1, alreadySettled: false };
}

/** Called by cron tick immediately when publishing a connector's own
 * `/api/jobs/sync` dispatch fails — that connector will never itself call
 * settleBatchMembership, so without this the batch would only ever complete
 * via the 2-hour timeout backstop. */
export async function markMemberEnqueueFailed(
  service: ServiceClient,
  params: { clientSpaceId: string; projectConnectorId: string; batchDate: string },
): Promise<SettleBatchResult> {
  return settleBatchMembership(service, { ...params, outcome: "enqueue_failed" });
}

// How far back to sweep for older unprocessed backlog every time a batch
// completes — caps a first-time connector backfill (which can pull in
// months of history in one go) at this many *distinct days* of automatic
// extraction, not a time window. Anything older stays available via the
// manual "Extract for this day" button on the Project Data page. Any day
// that doesn't make the cut this time isn't lost — the same sweep runs again
// the next time this client space's batch completes (tomorrow, ordinarily),
// so backlog converges over a few days instead of firing unbounded LLM spend
// in one shot.
const BACKFILL_DAY_CAP = 30;
// Bounds a single scan's read size the same way the Project Data page's own
// day-index query does (DAY_INDEX_ROW_LIMIT) — a scan that hasn't found
// BACKFILL_DAY_CAP distinct days within this many rows just means the rest
// get picked up by a later sweep, not silently dropped forever.
const BACKFILL_SCAN_ROW_LIMIT = 5000;
// dispatch_jobs() (20260901001500_pgmq_pg_cron.sql) drains up to 25 queued
// messages per 5-second tick via an async net.http_post per message, with no
// wait between them — enqueueing every swept day's LLM job at once (as this
// used to) could fire up to 25 concurrent generateActionItems runs for the
// SAME client space, each reading its own stale openActionItems snapshot
// before any sibling's writes land. That's exactly the condition that lets a
// paraphrased duplicate slip past the semantic consolidation matcher (see
// generate.ts) — the exact-hash unique index is the only thing that would
// still catch it, and paraphrases defeat that by design. Staggering spreads
// the dispatcher's per-tick batch back out so one day's job is very likely
// dispatched (and often finished) before the next day's job even becomes
// visible to read. Not a hard guarantee — a day with heavy event volume can
// still run past this many seconds — but it turns "up to 25 concurrent" into
// "at most a couple, briefly," which is the failure mode this exists to
// remove.
const DAY_JOB_STAGGER_SECONDS = 30;

// Rate-limits the `debounce: true` call site only (see the option below) —
// the "late arrival" trigger in run-sync.ts, which used to fire only for the
// rare manual "Sync now" landing after the day's batch already fired but
// became the ordinary case once the tick runs every minute instead of once a
// day. 15 minutes matches project_connectors.sync_interval_seconds' old
// historical default (900s), so a connector left on that cadence sees
// roughly the same extraction rhythm as before this feature existed.
const EXTRACTION_DEBOUNCE_MS = 15 * 60 * 1000;

/**
 * Fires the LLM job for a client space's batchDate once its batch is
 * confirmed complete, and sweeps for older unprocessed backlog at the same
 * time (see BACKFILL_DAY_CAP) — the general mechanism a first-time connector
 * backfill relies on to get more than just "today" extracted, but it applies
 * equally to e.g. a connector that was broken for a week and just caught up.
 *
 * `options.debounce` gates the call behind a per-client-space cooldown
 * (client_spaces.last_extraction_enqueued_at) via a single-statement
 * compare-and-swap — the same no-counter-arithmetic idiom
 * settleBatchMembership uses above. Callers that need a GUARANTEED trigger
 * (the once-per-day digest, a manual "Sync now" outside any batch) must NOT
 * set this: debouncing those could skip a day's digest entirely, or make a
 * user's manual sync appear to do nothing. It is safe to debounce the "late
 * arrival" call site specifically because this function only ever enqueues
 * work for events with processed_at IS NULL and re-sweeps older unprocessed
 * days on every later call — a skipped call delays extraction to the next
 * un-debounced or post-cooldown call, it never drops an event.
 */
export async function triggerDailyExtraction(
  service: ServiceClient,
  clientSpaceId: string,
  date: string,
  options?: { debounce?: boolean },
): Promise<void> {
  if (options?.debounce) {
    const cutoffIso = new Date(Date.now() - EXTRACTION_DEBOUNCE_MS).toISOString();
    const { data: won, error: debounceError } = await service
      .from("client_spaces")
      .update({ last_extraction_enqueued_at: new Date().toISOString() })
      .eq("id", clientSpaceId)
      .or(`last_extraction_enqueued_at.is.null,last_extraction_enqueued_at.lt.${cutoffIso}`)
      .select("id");
    if (debounceError) {
      // Fail closed: skip firing rather than risk unbounded extraction
      // rounds if the debounce check itself is broken. The next call (this
      // connector's next sync, or the guaranteed daily digest) still sweeps
      // whatever this one would have — see the doc comment above.
      console.error(`[sync] debounce check failed for client space ${clientSpaceId}; skipping this trigger:`, debounceError);
      return;
    }
    if (!won || won.length === 0) return; // another call already won this window
  }

  const dates = new Set([date]);

  const { data: clientSpace } = await service.from("client_spaces").select("timezone").eq("id", clientSpaceId).maybeSingle();
  const timezone = clientSpace?.timezone ?? "UTC";

  // Passing `timezone` gets the EXACT UTC instant of date's own local
  // midnight, not the generic ±1-day buffer utcWindowForDay falls back to
  // without it. That buffer exists so an over-fetch can be re-bucketed
  // precisely afterward (see fetchUnprocessedEventsForDay), but used as a
  // one-sided cutoff here it silently swallowed a full day of backlog: any
  // event on the day immediately before `date` was neither `date` itself
  // nor old enough to clear the buffer, so it was never swept until some
  // later day's cron run finally aged it past the gap. The exact boundary
  // has no such gap — anything before it is unambiguously an earlier
  // client-space-local day than `date`.
  const { gte: beforeDate } = utcWindowForDay(date, timezone);
  const { data: olderRows } = await service
    .from("normalized_events")
    .select("occurred_at")
    .eq("client_space_id", clientSpaceId)
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
      `[sync] client space ${clientSpaceId}: backlog scan hit its ${BACKFILL_SCAN_ROW_LIMIT}-row limit before finding ${BACKFILL_DAY_CAP} distinct days — remaining older backlog will be picked up by a future sweep`,
    );
  }

  await Promise.allSettled(
    [...dates].map((d, i) =>
      enqueueJob("/api/jobs/llm", { clientSpaceId, date: d }, { delaySeconds: i * DAY_JOB_STAGGER_SECONDS }).catch((err) => {
        console.error(`[sync] failed to enqueue LLM job for client space ${clientSpaceId} (date ${d}):`, err);
      }),
    ),
  );
}

export type ForceCompleteBatchResult = { clientSpaceId: string; batchDate: string; firedLlmJob: boolean };

/**
 * Backstop for a batch that never completed on its own — a lost job
 * delivery or a hard function timeout means some connector never reached
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
    .select("id, client_space_id, batch_date, llm_triggered_at")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return null;
  if (batch.llm_triggered_at) return { clientSpaceId: batch.client_space_id, batchDate: batch.batch_date, firedLlmJob: false };

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

  return { clientSpaceId: batch.client_space_id, batchDate: batch.batch_date, firedLlmJob: (won?.length ?? 0) === 1 };
}
