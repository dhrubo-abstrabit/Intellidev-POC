import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { queueEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { forceCompleteTimedOutBatch, triggerDailyExtraction } from "@/services/sync/batch";

export const runtime = "nodejs";

interface BatchTimeoutPayload {
  batchId: string;
}

/**
 * Backstop for src/services/sync/batch.ts's fan-in: scheduled (via a
 * delayed QStash message) at the same time a batch is seeded in
 * src/app/api/cron/tick/route.ts. Cron only runs once/day on the Hobby
 * plan, so if a member integration's sync never reaches a terminal state
 * (a lost QStash delivery, a hard function timeout) nothing else would ever
 * notice — this guarantees every project still gets a same-day digest.
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
    await triggerDailyExtraction(service, result.projectId, result.batchDate);
  }

  return NextResponse.json(result);
}

export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: queueEnv().QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: queueEnv().QSTASH_NEXT_SIGNING_KEY,
});
