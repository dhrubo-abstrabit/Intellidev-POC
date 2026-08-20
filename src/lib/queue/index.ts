import "server-only";
import { publishJob as publishJobPgmq } from "@/lib/queue/pgmq";

export interface EnqueueOptions {
  /** Delay delivery by this many seconds. Omit or 0 for immediate delivery. */
  delaySeconds?: number;
}

/**
 * Enqueue a job at one of our own /api/jobs/* routes, via Postgres pgmq +
 * pg_cron (src/lib/queue/pgmq.ts) — the only job transport this app uses.
 * pg_cron drains the queue every few seconds and delivers each message to
 * its route as a net.http_post; see the pgmq/pg_cron migration for the full
 * dispatch model. Returns an opaque string message id.
 */
export async function enqueueJob(path: string, body: unknown, options?: EnqueueOptions): Promise<string> {
  return publishJobPgmq(path, body, { delaySeconds: options?.delaySeconds });
}
