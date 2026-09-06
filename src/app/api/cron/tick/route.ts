import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cronEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { enqueueJob } from "@/lib/queue";
import { projectToday } from "@/lib/date/project-day";
import { seedBatchForClientSpace, markMemberEnqueueFailed, triggerDailyExtraction } from "@/services/sync/batch";

export const runtime = "nodejs";
// dispatch_daily_tick() waits up to 70s for this route (see the pgmq/pg_cron
// migration) — 60s is the ceiling on the Hobby plan. Without this export the
// route falls back to the platform default (10s) while fanning out one
// batch-seed plus one enqueue per due integration, and dispatch_daily_tick()
// writes nothing to job_dispatches, so a truncated run would leave no record
// at all that it happened.
export const maxDuration = 60;

// How long to wait for every member of a day's batch to report a terminal
// outcome before the batch-timeout job force-fires extraction anyway (see
// src/app/api/jobs/batch-timeout/route.ts) — covers a lost delivery or a
// hard function timeout, neither of which anything else here notices, given
// this tick only runs once/day (see the pgmq/pg_cron migration's note on
// why daily_tick is deliberately kept at that cadence for now).
const BATCH_TIMEOUT_DELAY_SECONDS = 2 * 60 * 60;

/**
 * Fired once/day by pg_cron's `dispatch_daily_tick()` (see
 * supabase/migrations/20260820101500_pgmq_pg_cron.sql), which sends
 * `Authorization: Bearer <job_dispatch_secret>` — deliberately the same
 * value as this environment's `CRON_SECRET` — via `net.http_get`. This check
 * is what stops anyone else from hitting this route and fanning out a sync
 * run for every integration on demand.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceClient();

  // The dispatch unit is the PROJECT CONNECTOR now. This predicate matches
  // project_connectors_due_for_sync_idx (partial, on next_sync_at where
  // enabled and sync_enabled) so the scan cost tracks due work, not table
  // size.
  //
  // `status` is deliberately NOT here: it lives on space_connections, because
  // a grant's health is a property of the grant, shared by every project in
  // the space. Filtering it needs a second read rather than an embedded
  // filter — the FK to space_connections is composite (connection_id,
  // client_space_id), which PostgREST cannot reliably auto-embed, and a wrong
  // guess there fails as a confusing 400 rather than a missing filter.
  const { data: dueConnectors, error } = await service
    .from("project_connectors")
    .select("id, client_space_id, connection_id")
    .lte("next_sync_at", new Date().toISOString())
    .eq("enabled", true)
    .eq("sync_enabled", true);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Drop connectors whose grant is unusable. A revoked or errored connection
  // would fail every fetch, and dispatching them would burn the whole batch
  // budget on guaranteed failures.
  const connectionIds = [...new Set((dueConnectors ?? []).map((c) => c.connection_id))];
  const { data: connections } = connectionIds.length
    ? await service.from("space_connections").select("id, status, revoked_at").in("id", connectionIds)
    : { data: [] as { id: string; status: string; revoked_at: string | null }[] };
  const usableConnectionIds = new Set(
    (connections ?? [])
      .filter((c) => c.revoked_at === null && (c.status === "connected" || c.status === "degraded"))
      .map((c) => c.id),
  );
  const due = (dueConnectors ?? []).filter((c) => usableConnectionIds.has(c.connection_id));

  const byClientSpace = new Map<string, { projectConnectorIds: string[] }>();
  for (const connector of due) {
    const group = byClientSpace.get(connector.client_space_id);
    if (group) group.projectConnectorIds.push(connector.id);
    else byClientSpace.set(connector.client_space_id, { projectConnectorIds: [connector.id] });
  }

  // Seed one batch per client space (needs each client space's timezone,
  // since "today" is a client-space-local calendar day, not a UTC one)
  // before dispatching any sync job — a sync that finishes and tries to
  // settle its membership before the batch row exists would otherwise be
  // treated as "not part of any batch" and fall back to the old
  // immediate-trigger behavior.
  const clientSpaceIds = [...byClientSpace.keys()];
  const { data: clientSpaces } = clientSpaceIds.length
    ? await service.from("client_spaces").select("id, timezone").in("id", clientSpaceIds)
    : { data: [] as { id: string; timezone: string }[] };
  const timezoneByClientSpace = new Map((clientSpaces ?? []).map((cs) => [cs.id, cs.timezone]));

  const batchByClientSpace = new Map<string, { batchId: string; batchDate: string }>();
  for (const [clientSpaceId, group] of byClientSpace) {
    const timezone = timezoneByClientSpace.get(clientSpaceId) ?? "UTC";
    const batchDate = projectToday(timezone);
    const { batchId, created } = await seedBatchForClientSpace(service, {
      clientSpaceId,
      batchDate,
      projectConnectorIds: group.projectConnectorIds,
    });
    batchByClientSpace.set(clientSpaceId, { batchId, batchDate });
    // Only the tick that actually CREATES today's batch schedules its
    // timeout backstop — every later tick this minute (this space still has
    // connectors due) reuses the same row and must not re-enqueue. Before
    // the tick ran every minute this was a non-issue (at most one tick/day
    // per space); at 1440 ticks/day, gating on `created` is what keeps this
    // at one delayed job per (space, day) instead of up to 1440 — see
    // seedBatchForClientSpace's own doc comment.
    if (created) {
      await enqueueJob("/api/jobs/batch-timeout", { batchId }, { delaySeconds: BATCH_TIMEOUT_DELAY_SECONDS }).catch((err) => {
        console.error(`[cron] failed to schedule batch timeout for client space ${clientSpaceId}:`, err);
      });
    }
  }

  const results = await Promise.allSettled(
    due.map(async (connector) => {
      try {
        await enqueueJob("/api/jobs/sync", { projectConnectorId: connector.id, trigger: "schedule" });
      } catch (err) {
        const batch = batchByClientSpace.get(connector.client_space_id);
        if (batch) {
          const settled = await markMemberEnqueueFailed(service, {
            clientSpaceId: connector.client_space_id,
            projectConnectorId: connector.id,
            batchDate: batch.batchDate,
          });
          if (settled.inBatch && settled.firedLlmJob) {
            await triggerDailyExtraction(service, connector.client_space_id, batch.batchDate);
          }
        }
        throw err;
      }
    }),
  );

  return NextResponse.json({
    due: due.length,
    // Connectors that were due but whose grant is revoked/errored, so were
    // deliberately not dispatched. Surfaced rather than silently dropped —
    // "due: 0, skipped: 5" is a diagnosable state; a bare "due: 0" is not.
    skippedUnusableConnection: (dueConnectors?.length ?? 0) - due.length,
    dispatched: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  });
}
