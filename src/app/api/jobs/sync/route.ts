import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { queueEnv } from "@/lib/env";
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
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<SyncJobPayload>;
  if (typeof body.integrationId !== "string") {
    return NextResponse.json({ error: "integrationId is required" }, { status: 400 });
  }

  const result = await runSync(body.integrationId, body.trigger ?? "schedule", body.chainDepth ?? 0);
  // A non-2xx tells QStash to retry per the message's retry policy — only
  // "failed" (an actual error) should trigger that; "skipped" (another sync
  // already in flight) is a legitimate no-op.
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: queueEnv().QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: queueEnv().QSTASH_NEXT_SIGNING_KEY,
});
