import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withJobAuth } from "@/lib/queue/auth";
import { runEmbedding } from "@/services/search/embed";

export const runtime = "nodejs";
// One OpenAI embeddings round trip per ~128 chunks plus up to 100 single-row
// writebacks fits comfortably inside the Hobby-plan ceiling — same rationale
// as every other job route (see /api/jobs/attachments).
export const maxDuration = 60;

interface EmbedJobPayload {
  clientSpaceId: string;
  /** Set by embed.ts itself when a backlog doesn't drain within one run's
   * budget — see MAX_EMBED_CHAIN_DEPTH there. Absent on the initial enqueue
   * from run-sync.ts / run-extraction.ts. */
  chainDepth?: number;
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<EmbedJobPayload>;
  if (typeof body.clientSpaceId !== "string") {
    return NextResponse.json({ error: "clientSpaceId is required" }, { status: 400 });
  }

  const result = await runEmbedding(body.clientSpaceId, body.chainDepth ?? 0);
  // Non-2xx tells the queue backend to retry — only "failed" (an actual
  // error) should trigger that; "skipped" (nothing pending) is a legitimate
  // no-op, same convention as /api/jobs/sync and /api/jobs/attachments.
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = withJobAuth(handler);
