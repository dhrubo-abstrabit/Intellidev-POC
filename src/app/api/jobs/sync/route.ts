import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withJobAuth } from "@/lib/queue/auth";
import { runSync } from "@/services/sync/run-sync";
import type { Database } from "@/lib/db/database.types";

export const runtime = "nodejs";
// A connector fetch across many channels/pages can run past Vercel's
// default function timeout (10s) — 60s is the ceiling on the Hobby plan.
export const maxDuration = 60;

interface SyncJobPayload {
  integrationId: string;
  trigger?: Database["public"]["Enums"]["sync_trigger"];
  /** Set by run-sync.ts itself when a connector reports hasMore:true — see
   * MAX_SYNC_CHAIN_DEPTH there. Absent on every cron/manual-triggered job. */
  chainDepth?: number;
  /** Set by run-sync.ts itself alongside chainDepth, pinning a chained
   * follow-up to the same day's batch it started in (see
   * src/services/sync/batch.ts). Absent on every cron/manual-triggered job
   * — those let run-sync compute "today" fresh. */
  batchDate?: string;
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<SyncJobPayload>;
  if (typeof body.integrationId !== "string") {
    return NextResponse.json({ error: "integrationId is required" }, { status: 400 });
  }

  const result = await runSync(body.integrationId, body.trigger ?? "schedule", body.chainDepth ?? 0, body.batchDate);
  // A non-2xx tells withJobAuth to fail_job (which pg_cron's dispatcher then
  // redelivers with backoff — see the pgmq/pg_cron migration) — only
  // "failed" (an actual error) should trigger that; "skipped" (another sync
  // already in flight) is a legitimate no-op.
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = withJobAuth(handler);
