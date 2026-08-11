import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/database.types";

/**
 * pgmq-backed counterpart to src/lib/queue/qstash.ts's publishJob — same job
 * semantics (at-least-once delivery, retries with backoff, a bounded number
 * of attempts before dead-lettering), different transport. See
 * supabase/migrations/20260811100000_pgmq_pg_cron.sql for the Postgres side
 * (the `jobs` queue, and pg_cron's dispatch_jobs() which reads it and calls
 * the job routes over HTTP).
 *
 * All three functions below go through public.* SECURITY DEFINER wrappers
 * rather than pgmq's own tables/functions directly — pgmq lives in its own
 * schema, which PostgREST (and therefore the Supabase client) never exposes.
 */

export async function publishJob(path: string, body: unknown, options?: { delaySeconds?: number }): Promise<string> {
  const service = createServiceClient();
  const { data, error } = await service.rpc("enqueue_job", {
    p_route: path,
    p_payload: body as Json,
    p_delay_seconds: options?.delaySeconds ?? 0,
  });
  if (error) {
    throw new Error(`enqueue_job failed for ${path}: ${error.message}`);
  }
  return String(data);
}

/** Deletes a message from the queue. Call once its job route returns 2xx —
 * see src/lib/queue/auth.ts, the only caller. */
export async function ackJob(msgId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.rpc("ack_job", { p_msg_id: Number(msgId) });
  if (error) {
    throw new Error(`ack_job failed for msg ${msgId}: ${error.message}`);
  }
}

/**
 * Records the failure and extends the message's visibility timeout (backoff
 * = 60s * attempt) so pg_cron's dispatcher redelivers it later rather than
 * immediately. `attempt` is the read_ct the dispatcher observed when it
 * handed the message to the route (carried over via the x-job-attempt
 * header) — this never reads pgmq's internal tables itself.
 */
export async function failJob(msgId: string, attempt: number, errorMessage: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.rpc("fail_job", {
    p_msg_id: Number(msgId),
    p_attempt: attempt,
    p_error: errorMessage,
  });
  if (error) {
    throw new Error(`fail_job failed for msg ${msgId}: ${error.message}`);
  }
}
