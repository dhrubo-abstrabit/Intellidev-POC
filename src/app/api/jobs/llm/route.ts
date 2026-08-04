import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { queueEnv } from "@/lib/env";
import { generateActionItems } from "@/services/action-items/generate";

export const runtime = "nodejs";

interface LlmJobPayload {
  projectId: string;
}

async function handler(request: NextRequest) {
  const body = (await request.json()) as Partial<LlmJobPayload>;
  if (typeof body.projectId !== "string") {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const result = await generateActionItems(body.projectId);
  return NextResponse.json(result, { status: result.status === "failed" ? 500 : 200 });
}

export const POST = verifySignatureAppRouter(handler, {
  currentSigningKey: queueEnv().QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: queueEnv().QSTASH_NEXT_SIGNING_KEY,
});
