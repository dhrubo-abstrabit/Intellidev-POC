import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withJobAuth } from "@/lib/queue/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { forceCompleteTimedOutBatch, triggerDailyExtraction } from "@/services/sync/batch";

export const runtime = "nodejs";
// triggerDailyExtraction can scan up to BACKFILL_SCAN_ROW_LIMIT rows and
// enqueue up to BACKFILL_DAY_CAP jobs (src/services/sync/batch.ts) — past
// Vercel's default function timeout (10s), same reasoning as the other two
// job routes (60s is the ceiling on the Hobby plan).
export const maxDuration = 60;

interface BatchTimeoutPayload {
  batchId: string;
}

/**
 * Backstop for src/services/sync/batch.ts's fan-in: scheduled (via a
 * delayed pgmq message) at the same time a batch is seeded in
 * src/app/api/cron/tick/route.ts. Cron only runs once/day on the Hobby
 * plan, so if a member integration's sync never reaches a terminal state
 * (a lost delivery, a hard function timeout) nothing else would ever
 * notice — this guarantees every client space still gets a same-day digest.
 */
async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<BatchTimeoutPayload>;
  if (typeof body.batchId !== "string") {
    return NextResponse.json({ error: "batchId is required" }, { status: 400 });
  }

  const service = createServiceClient();
  const result = await forceCompleteTimedOutBatch(service, body.batchId);
  if (!result) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  if (result.firedLlmJob) {
    await triggerDailyExtraction(service, result.clientSpaceId, result.batchDate);
  }

  return NextResponse.json(result);
}

export const POST = withJobAuth(handler);
