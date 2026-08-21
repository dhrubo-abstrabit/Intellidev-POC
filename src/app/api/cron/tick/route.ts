import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cronEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { enqueueJob } from "@/lib/queue";
import { projectToday } from "@/lib/date/project-day";
import { seedBatchForClientSpace, markMemberEnqueueFailed, triggerDailyExtraction } from "@/services/sync/batch";

export const runtime = "nodejs";

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
  const { data: dueIntegrations, error } = await service
    .from("integrations")
    .select("id, client_space_id, workspace_id")
    .lte("next_sync_at", new Date().toISOString())
    .eq("sync_enabled", true)
    .in("status", ["connected", "degraded"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const byClientSpace = new Map<string, { workspaceId: string; integrationIds: string[] }>();
  for (const integration of dueIntegrations ?? []) {
    const group = byClientSpace.get(integration.client_space_id);
    if (group) group.integrationIds.push(integration.id);
    else byClientSpace.set(integration.client_space_id, { workspaceId: integration.workspace_id, integrationIds: [integration.id] });
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
    const batchId = await seedBatchForClientSpace(service, {
      workspaceId: group.workspaceId,
      clientSpaceId,
      batchDate,
      integrationIds: group.integrationIds,
    });
    batchByClientSpace.set(clientSpaceId, { batchId, batchDate });
    await enqueueJob("/api/jobs/batch-timeout", { batchId }, { delaySeconds: BATCH_TIMEOUT_DELAY_SECONDS }).catch((err) => {
      console.error(`[cron] failed to schedule batch timeout for client space ${clientSpaceId}:`, err);
    });
  }

  const results = await Promise.allSettled(
    (dueIntegrations ?? []).map(async (integration) => {
      try {
        await enqueueJob("/api/jobs/sync", { integrationId: integration.id, trigger: "schedule" });
      } catch (err) {
        const batch = batchByClientSpace.get(integration.client_space_id);
        if (batch) {
          const settled = await markMemberEnqueueFailed(service, {
            clientSpaceId: integration.client_space_id,
            integrationId: integration.id,
            batchDate: batch.batchDate,
          });
          if (settled.inBatch && settled.firedLlmJob) {
            await triggerDailyExtraction(service, integration.client_space_id, batch.batchDate);
          }
        }
        throw err;
      }
    }),
  );

  return NextResponse.json({
    due: dueIntegrations?.length ?? 0,
    dispatched: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  });
}
