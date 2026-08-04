import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cronEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { publishJob } from "@/lib/queue/qstash";

export const runtime = "nodejs";

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
    .select("id")
    .lte("next_sync_at", new Date().toISOString())
    .eq("sync_enabled", true)
    .in("status", ["connected", "degraded"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = await Promise.allSettled(
    (dueIntegrations ?? []).map((integration) =>
      publishJob("/api/jobs/sync", { integrationId: integration.id, trigger: "schedule" }),
    ),
  );

  return NextResponse.json({
    due: dueIntegrations?.length ?? 0,
    dispatched: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  });
}
