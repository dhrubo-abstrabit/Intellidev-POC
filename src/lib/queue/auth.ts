import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cronEnv } from "@/lib/env";
import { ackJob, failJob } from "@/lib/queue/pgmq";

type JobHandler = (request: NextRequest) => Promise<NextResponse>;

/**
 * Wraps a /api/jobs/* route handler with the pgmq/pg_cron auth + ack/nack
 * protocol: a plain bearer check against CRON_SECRET (the same secret
 * Vercel Cron used to use — reused deliberately as the Vault-stored
 * job_dispatch_secret, see the pgmq/pg_cron migration), then an explicit
 * ack_job/fail_job call after the handler returns, since pgmq has no
 * callback of its own to report status to. The message id and attempt count
 * travel in the x-job-msg-id/x-job-attempt headers, set by dispatch_jobs()
 * when it fires the request.
 */
export function withJobAuth(handler: JobHandler): (request: NextRequest) => Promise<Response> {
  return async function (request: NextRequest): Promise<Response> {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronEnv().CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const msgId = request.headers.get("x-job-msg-id");
    const attempt = Number(request.headers.get("x-job-attempt") ?? "0");
    if (!msgId) {
      return NextResponse.json({ error: "Missing x-job-msg-id header" }, { status: 400 });
    }

    let response: NextResponse;
    try {
      response = await handler(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(msgId, attempt, message).catch((failErr) => {
        console.error(`[queue] failed to nack job ${msgId}:`, failErr);
      });
      throw err;
    }

    if (response.status >= 200 && response.status < 300) {
      await ackJob(msgId).catch((err) => {
        console.error(`[queue] failed to ack job ${msgId}:`, err);
      });
    } else {
      const errorText = await response
        .clone()
        .text()
        .catch(() => `HTTP ${response.status}`);
      await failJob(msgId, attempt, errorText || `HTTP ${response.status}`).catch((err) => {
        console.error(`[queue] failed to nack job ${msgId}:`, err);
      });
    }

    return response;
  };
}
