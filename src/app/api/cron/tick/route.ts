import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cronEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { publishJob } from "@/lib/queue/qstash";
import { projectToday } from "@/lib/date/project-day";
import { seedBatchForProject, markMemberEnqueueFailed, triggerDailyExtraction } from "@/services/sync/batch";

export const runtime = "nodejs";

// How long to wait for every member of a day's batch to report a terminal
// outcome before the batch-timeout job force-fires extraction anyway (see
// src/app/api/jobs/batch-timeout/route.ts) — covers a lost QStash delivery
// or a hard function timeout, neither of which anything else here notices,
// given cron only runs once/day on the Hobby plan.
const BATCH_TIMEOUT_DELAY = "2h";

/**
 * Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` on
 * every invocation as long as a `CRON_SECRET` env var exists on the project
 * — this check is what stops anyone else from hitting this route and
 * fanning out a sync run for every integration on demand.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const service = createServiceClient();
  const { data: dueIntegrations, error } = await service
    .from("integrations")
    .select("id, project_id, workspace_id")
    .lte("next_sync_at", new Date().toISOString())
    .eq("sync_enabled", true)
    .in("status", ["connected", "degraded"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const byProject = new Map<string, { workspaceId: string; integrationIds: string[] }>();
  for (const integration of dueIntegrations ?? []) {
    const group = byProject.get(integration.project_id);
    if (group) group.integrationIds.push(integration.id);
    else byProject.set(integration.project_id, { workspaceId: integration.workspace_id, integrationIds: [integration.id] });
  }

  // Seed one batch per project (needs each project's timezone, since "today"
  // is a project-local calendar day, not a UTC one) before dispatching any
  // sync job — a sync that finishes and tries to settle its membership
  // before the batch row exists would otherwise be treated as "not part of
  // any batch" and fall back to the old immediate-trigger behavior.
  const projectIds = [...byProject.keys()];
  const { data: projects } = projectIds.length
    ? await service.from("projects").select("id, timezone").in("id", projectIds)
    : { data: [] as { id: string; timezone: string }[] };
  const timezoneByProject = new Map((projects ?? []).map((p) => [p.id, p.timezone]));

  const batchByProject = new Map<string, { batchId: string; batchDate: string }>();
  for (const [projectId, group] of byProject) {
    const timezone = timezoneByProject.get(projectId) ?? "UTC";
    const batchDate = projectToday(timezone);
    const batchId = await seedBatchForProject(service, {
      workspaceId: group.workspaceId,
      projectId,
      batchDate,
      integrationIds: group.integrationIds,
    });
    batchByProject.set(projectId, { batchId, batchDate });
    await publishJob("/api/jobs/batch-timeout", { batchId }, { delay: BATCH_TIMEOUT_DELAY }).catch((err) => {
      console.error(`[cron] failed to schedule batch timeout for project ${projectId}:`, err);
    });
  }

  const results = await Promise.allSettled(
    (dueIntegrations ?? []).map(async (integration) => {
      try {
        await publishJob("/api/jobs/sync", { integrationId: integration.id, trigger: "schedule" });
      } catch (err) {
        const batch = batchByProject.get(integration.project_id);
        if (batch) {
          const settled = await markMemberEnqueueFailed(service, {
            projectId: integration.project_id,
            integrationId: integration.id,
            batchDate: batch.batchDate,
          });
          if (settled.inBatch && settled.firedLlmJob) {
            await triggerDailyExtraction(service, integration.project_id, batch.batchDate);
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
