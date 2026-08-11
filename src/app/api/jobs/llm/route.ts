import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { withJobAuth } from "@/lib/queue/auth";
import { generateActionItems } from "@/services/action-items/generate";

export const runtime = "nodejs";
// A Haiku call with max_tokens: 8000 can take well past Vercel's default
// function timeout (10s) — 60s is the ceiling on the Hobby plan.
export const maxDuration = 60;

interface LlmJobPayload {
  projectId: string;
  /** Project-local calendar day ("2026-08-10") to extract action items for.
   * Computed by the caller (run-sync.ts / batch.ts) at enqueue time, not
   * defaulted here — QStash delivery isn't instant, so a job enqueued right
   * before local midnight must still process the day it was enqueued for,
   * not whatever "today" resolves to when it happens to execute. */
  date: string;
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<LlmJobPayload>;
  if (typeof body.projectId !== "string") {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  if (typeof body.date !== "string") {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  const result = await generateActionItems(body.projectId, body.date);
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = withJobAuth(handler);
