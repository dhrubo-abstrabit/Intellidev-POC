import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withJobAuth } from "@/lib/queue/auth";
import { runAttachmentExtraction } from "@/services/attachments/run-extraction";

export const runtime = "nodejs";
// Downloading + parsing several attachments (a PDF, a .docx) can run well
// past Vercel's default function timeout (10s) — 60s is the ceiling on the
// Hobby plan, same as every other job route.
export const maxDuration = 60;

interface AttachmentsJobPayload {
  integrationId: string;
  /** Project-local calendar day this run's attachments belong to — set by
   * run-sync.ts (or this route's own chaining) at enqueue time, exactly like
   * SyncJobPayload.batchDate. Never recomputed here: this job's whole reason
   * to exist is to run AFTER a sync already decided which batch/day these
   * attachments belong to. */
  batchDate: string;
  /** Set by run-extraction.ts itself when a backlog doesn't drain within one
   * run's budget — see MAX_ATTACHMENT_CHAIN_DEPTH there. Absent on the
   * initial enqueue from run-sync.ts. */
  chainDepth?: number;
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<AttachmentsJobPayload>;
  if (typeof body.integrationId !== "string") {
    return NextResponse.json({ error: "integrationId is required" }, { status: 400 });
  }
  if (typeof body.batchDate !== "string") {
    return NextResponse.json({ error: "batchDate is required" }, { status: 400 });
  }

  const result = await runAttachmentExtraction(body.integrationId, body.batchDate, body.chainDepth ?? 0);
  // Non-2xx tells the queue backend to retry — only "failed" (an actual
  // error) should trigger that; "skipped" (attachments disabled, or this
  // connector has no downloader) is a legitimate no-op, same convention as
  // /api/jobs/sync.
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = withJobAuth(handler);
