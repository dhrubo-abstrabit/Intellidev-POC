import "server-only";
import { jobBackendEnv } from "@/lib/env";
import { publishJob as publishJobQstash } from "@/lib/queue/qstash";
import { publishJob as publishJobPgmq } from "@/lib/queue/pgmq";

export interface EnqueueOptions {
  /** Delay delivery by this many seconds. Omit or 0 for immediate delivery. */
  delaySeconds?: number;
  /** QStash-only: max delivery retries before it gives up on a message.
   * pgmq's dead-letter bound (see dispatch_jobs() in the pgmq/pg_cron
   * migration) is fixed at 3 attempts and ignores this option. */
  retries?: number;
}

/**
 * Enqueue a job at one of our own /api/jobs/* routes. Backend is chosen by
 * JOB_BACKEND (src/lib/env.ts):
 *  - "qstash" — Upstash QStash (src/lib/queue/qstash.ts). Production default
 *    until the pgmq cutover ships.
 *  - "pgmq" — Postgres pgmq + pg_cron (src/lib/queue/pgmq.ts). Required for
 *    local dev: QStash's callback can never reach localhost, so a
 *    QStash-backed job is unrunnable outside a real deployment.
 *
 * Both branches return the same shape (an opaque string message id) and
 * accept the same delay unit (seconds) — QStash's `delay` option takes a
 * plain number of seconds just as readily as a Duration string like "2h",
 * so no format conversion is needed between backends.
 */
export async function enqueueJob(path: string, body: unknown, options?: EnqueueOptions): Promise<string> {
  const { JOB_BACKEND } = jobBackendEnv();
  if (JOB_BACKEND === "pgmq") {
    return publishJobPgmq(path, body, { delaySeconds: options?.delaySeconds });
  }
  return publishJobQstash(path, body, { retries: options?.retries, delay: options?.delaySeconds });
}
