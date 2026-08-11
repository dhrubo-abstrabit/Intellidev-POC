import "server-only";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { cronEnv, jobBackendEnv, queueEnv } from "@/lib/env";
import { ackJob, failJob } from "@/lib/queue/pgmq";

type JobHandler = (request: NextRequest) => Promise<NextResponse>;

/**
 * Wraps a /api/jobs/* route handler with whichever auth + ack/nack protocol
 * matches JOB_BACKEND (src/lib/env.ts). Handler bodies never change between
 * backends — only how the request is authenticated and how its outcome is
 * reported back to the queue does.
 *
 *  - qstash: Upstash's own signature verification. QStash tracks
 *    ack/retry itself from the handler's HTTP status code, so there's
 *    nothing else to do here.
 *  - pgmq: a plain bearer check against CRON_SECRET (the same secret
 *    Vercel Cron already used — reused deliberately as the Vault-stored
 *    job_dispatch_secret, see the pgmq/pg_cron migration), then an explicit
 *    ack_job/fail_job call after the handler returns, since pgmq has no
 *    callback of its own to report status to. The message id and attempt
 *    count travel in the x-job-msg-id/x-job-attempt headers, set by
 *    dispatch_jobs() when it fires the request.
 *
 * Both branches are resolved per-request, not at module scope: with
 * JOB_BACKEND=pgmq, the four QSTASH_* secrets are never set, so calling
 * queueEnv() at import time (as every job route did before this wrapper
 * existed) would fail to even load the route.
 */
export function withJobAuth(handler: JobHandler): (request: NextRequest) => Promise<Response> {
  return async function (request: NextRequest): Promise<Response> {
    if (jobBackendEnv().JOB_BACKEND === "qstash") {
      const keys = queueEnv();
      return verifySignatureAppRouter(handler, {
        currentSigningKey: keys.QSTASH_CURRENT_SIGNING_KEY,
        nextSigningKey: keys.QSTASH_NEXT_SIGNING_KEY,
      })(request);
    }

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
