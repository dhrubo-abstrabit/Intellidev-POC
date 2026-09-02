import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { getConnector } from "@/connectors/registry";
import { createDeadline } from "@/connectors/deadline";
import { loadCredentials } from "@/services/sync/credentials";
import { enqueueJob } from "@/lib/queue";
import { settleBatchMembership, triggerDailyExtraction } from "@/services/sync/batch";
import { insertChunksForSource } from "@/services/search/ingest";
import { planAttachmentExtraction } from "./extract";
import { parseAttachmentText } from "./parse";
import { attachmentStoragePath, uploadAttachmentBytes } from "./storage";
import type { Connector, ConnectorCredentials } from "@/connectors/types";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Leaves headroom under the route's 60s maxDuration for the final
// status-update writes, same rationale as run-sync.ts's own FETCH_BUDGET_MS.
const FETCH_BUDGET_MS = 40_000;
// Reserve enough that an attachment already mid-download can finish and get
// persisted, rather than getting cut off mid-request — mirrors every other
// connector's RESERVE_MS pattern.
const PER_ATTACHMENT_RESERVE_MS = 3_000;

const DEFAULT_MAX_ATTACHMENTS_PER_RUN = 15;
// Matches connectors/google/config.ts's MAX_ATTACHMENTS_PER_RUN_CEILING —
// re-asserted here (not imported) because this job reads integrations.config
// directly rather than through either connector's Zod schema, and
// integrations.config is client-writable: a value from PostgREST must never
// be trusted as unbounded even if a connector's own schema would also clamp it.
const MAX_ATTACHMENTS_PER_RUN_CEILING = 25;
// Same 10MB ceiling as project-context/actions.ts's MAX_EXTRACT_FILE_BYTES —
// generous for a text document, not a media file.
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
// Higher than a message body's clamp (Gmail/Drive use 2000) — an attachment
// IS the payload here, not a preview of it.
const MAX_EXTRACTED_TEXT_CHARS = 8000;
// Mirrors run-sync.ts's MAX_SYNC_CHAIN_DEPTH: a backlog that never drains
// must not fan out indefinitely.
const MAX_ATTACHMENT_CHAIN_DEPTH = 5;

type ConnectorRow = Pick<
  Database["public"]["Tables"]["project_connectors"]["Row"],
  "id" | "client_space_id" | "project_id" | "provider" | "connection_id" | "config"
>;

type PendingAttachmentRow = Pick<
  Database["public"]["Tables"]["event_attachments"]["Row"],
  "id" | "normalized_event_id" | "provider_attachment_id" | "filename" | "mime_type" | "size_bytes" | "download_ref"
> & {
  // Embedded via the FK to normalized_events — this attachment's PARENT
  // event's own occurred_at/resource_url, used to stamp its search_chunks
  // rows with when the file was actually SHARED, not when it happened to
  // get parsed (see insertChunksForSource's call site in processOne).
  normalized_events: Pick<Database["public"]["Tables"]["normalized_events"]["Row"], "occurred_at" | "resource_url"> | null;
};

export interface RunAttachmentExtractionResult {
  status: "succeeded" | "failed" | "skipped";
  processed: number;
  hasMore: boolean;
  error?: string;
}

/** Settles this integration's batch membership (if any) and fires the day's
 * LLM job — the same handoff run-sync.ts used to do itself before attachment
 * processing existed, now owned by this job so extraction never fires before
 * this run's attachments have had a chance to be downloaded/parsed. */
async function settleAndTrigger(service: ServiceClient, integration: Pick<ConnectorRow, "id" | "client_space_id">, batchDate: string): Promise<void> {
  const settled = await settleBatchMembership(service, {
    clientSpaceId: integration.client_space_id,
    projectConnectorId: integration.id,
    batchDate,
    outcome: "succeeded",
  });
  if (settled.inBatch) {
    if (settled.firedLlmJob || settled.alreadySettled) {
      // firedLlmJob: this call was the one that completed every member —
      // fire normally. alreadySettled: this integration already reported in
      // for today's batch earlier (its one-shot trigger already fired), and
      // is reporting in AGAIN now with attachment text that showed up after
      // that — without this, those events (and their attachment text) would
      // sit unprocessed until tomorrow's batch or its backlog sweep. No
      // eventsWritten-style gate needed in either branch: run-sync only
      // hands off to this job at all when it decided this run had something
      // worth extracting, and triggerDailyExtraction is idempotent
      // (processed_at-gated), so an extra call here is harmless.
      await triggerDailyExtraction(service, integration.client_space_id, batchDate);
    }
  } else {
    // Not part of any active batch (e.g. a manual "Sync Now" outside a batch
    // window) — same "no gate needed" reasoning as above.
    await triggerDailyExtraction(service, integration.client_space_id, batchDate);
  }
}

/**
 * Drains up to `maxAttachmentsPerRun` pending event_attachments rows for one
 * integration: download bytes via the connector, upload them to the private
 * 'attachments' Storage bucket, parse text out of them, and write the
 * result back. Chains itself (like run-sync.ts chains /api/jobs/sync) when
 * a backlog doesn't drain in one run, and only settles the batch / fires
 * the LLM job once its own queue for this integration is empty (or the
 * chain depth cap is hit) — see run-sync.ts's handoff at its settle fork for
 * why this job, not run-sync, now owns that responsibility.
 */
export async function runAttachmentExtraction(
  projectConnectorId: string,
  batchDate: string,
  chainDepth = 0,
): Promise<RunAttachmentExtractionResult> {
  const service = createServiceClient();

  const { data: integration } = await service
    .from("project_connectors")
    .select("id, client_space_id, project_id, provider, connection_id, config")
    .eq("id", projectConnectorId)
    .maybeSingle();
  if (!integration) {
    return { status: "failed", processed: 0, hasMore: false, error: "Project connector not found" };
  }

  try {
    const configObj = (integration.config as Record<string, unknown> | null) ?? {};

    // Defensive re-check: run-sync.ts already gates on this before creating
    // pending rows or enqueuing this job at all, but config is client-
    // writable via PostgREST at any time, including the gap between that
    // enqueue and this job actually running.
    if (configObj.processAttachments === false) {
      await settleAndTrigger(service, integration, batchDate);
      return { status: "skipped", processed: 0, hasMore: false };
    }

    const connector = getConnector(integration.provider);
    if (!connector.downloadAttachment) {
      // No connector currently registered without attachment support would
      // ever create pending rows in the first place, but a provider swap or
      // a stale row from before a downgrade shouldn't wedge the batch.
      await settleAndTrigger(service, integration, batchDate);
      return { status: "skipped", processed: 0, hasMore: false };
    }

    const maxAttachmentsPerRunRaw = configObj.maxAttachmentsPerRun;
    const maxAttachmentsPerRun =
      typeof maxAttachmentsPerRunRaw === "number" && maxAttachmentsPerRunRaw > 0
        ? Math.min(Math.floor(maxAttachmentsPerRunRaw), MAX_ATTACHMENTS_PER_RUN_CEILING)
        : DEFAULT_MAX_ATTACHMENTS_PER_RUN;

    const credentials = await loadCredentials(service, integration);

    const { data: pending, error: pendingError } = await service
      .from("event_attachments")
      .select("id, normalized_event_id, provider_attachment_id, filename, mime_type, size_bytes, download_ref, normalized_events(occurred_at, resource_url)")
      .eq("project_connector_id", integration.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(maxAttachmentsPerRun);
    if (pendingError) throw new Error(`event_attachments fetch failed: ${pendingError.message}`);

    const deadline = createDeadline(FETCH_BUDGET_MS);
    let processed = 0;
    let chunksPending = 0;

    for (const attachment of (pending ?? []) as PendingAttachmentRow[]) {
      if (deadline.remainingMs() < PER_ATTACHMENT_RESERVE_MS) break;
      chunksPending += await processOne(service, connector, credentials, integration, attachment, {
        deadline,
        maxAttachmentsPerRun,
        extractionsSoFar: processed,
      });
      processed++;
    }

    // Independent of the chained-vs-terminal branching below, same
    // reasoning as run-sync.ts's own embed enqueue: nothing downstream of
    // this job waits on embeddings, so this fires as soon as there's
    // anything to embed rather than only once the whole attachment backlog
    // drains.
    if (chunksPending > 0) {
      await enqueueJob("/api/jobs/embed", { clientSpaceId: integration.client_space_id }).catch((err) => {
        console.error(`[attachments] failed to enqueue embed job for client space ${integration.client_space_id}:`, err);
      });
    }

    const { count: remainingCount } = await service
      .from("event_attachments")
      .select("id", { count: "exact", head: true })
      .eq("project_connector_id", integration.id)
      .eq("status", "pending");
    const hasMore = (remainingCount ?? 0) > 0;

    if (hasMore && chainDepth < MAX_ATTACHMENT_CHAIN_DEPTH) {
      // Not terminal yet — a follow-up run will drain more. Do NOT settle:
      // the batch (and the LLM trigger) must wait for that follow-up, same
      // as run-sync.ts's own hasMore chaining branch.
      await enqueueJob("/api/jobs/attachments", {
        projectConnectorId: integration.id,
        batchDate,
        chainDepth: chainDepth + 1,
      }).catch((err) => {
        console.error(`[attachments] failed to enqueue follow-up for integration ${integration.id}:`, err);
      });
      return { status: "succeeded", processed, hasMore: true };
    }

    if (hasMore) {
      console.warn(
        `[attachments] integration ${integration.id} still has pending attachments after ${MAX_ATTACHMENT_CHAIN_DEPTH} chained runs — settling anyway; stragglers stay 'pending' for a future run`,
      );
    }

    await settleAndTrigger(service, integration, batchDate);
    return { status: "succeeded", processed, hasMore };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[attachments] run failed for connector ${projectConnectorId}:`, err);
    // A broken run must not hang the rest of the project's batch forever —
    // settle now so the day's extraction still fires (without this run's
    // attachment text, but with everything else already written), mirroring
    // run-sync.ts's own catch block settling on failure.
    await settleAndTrigger(service, integration, batchDate).catch((settleErr) => {
      console.error(`[attachments] settle-on-failure also failed for connector ${projectConnectorId}:`, settleErr);
    });
    return { status: "failed", processed: 0, hasMore: false, error: message };
  }
}

async function processOne(
  service: ServiceClient,
  connector: Connector,
  credentials: ConnectorCredentials,
  integration: ConnectorRow,
  attachment: PendingAttachmentRow,
  budget: { deadline: ReturnType<typeof createDeadline>; maxAttachmentsPerRun: number; extractionsSoFar: number },
): Promise<number> {
  const plan = planAttachmentExtraction(
    {
      mimeType: attachment.mime_type ?? undefined,
      filename: attachment.filename ?? undefined,
      sizeBytes: attachment.size_bytes ?? undefined,
    },
    { maxBytes: MAX_DOWNLOAD_BYTES, extractionsSoFar: budget.extractionsSoFar, maxPerRun: budget.maxAttachmentsPerRun },
  );

  // Every update below is a compare-and-swap (`.eq("status", "pending")`):
  // at-least-once job delivery means this attachment could be mid-processing
  // in a retried delivery elsewhere — whichever write lands first wins, and
  // the other becomes a harmless no-op (0 rows affected) rather than a
  // double-write or an error.
  if (plan.kind === "skip") {
    await service
      .from("event_attachments")
      .update({ status: "skipped", skip_reason: plan.reason })
      .eq("id", attachment.id)
      .eq("status", "pending");
    return 0;
  }

  // downloadAttachment is guaranteed to exist by the caller (getConnector's
  // result was checked before this loop started).
  const downloaded = await connector.downloadAttachment!(credentials, (attachment.download_ref as Record<string, unknown>) ?? {}, budget.deadline);
  if (!downloaded) {
    await service
      .from("event_attachments")
      .update({ status: "failed", error: "download failed or returned no data" })
      .eq("id", attachment.id)
      .eq("status", "pending");
    return 0;
  }

  const storagePath = attachmentStoragePath({
    clientSpaceId: integration.client_space_id,
    normalizedEventId: attachment.normalized_event_id,
    attachmentId: attachment.id,
  });
  // attachment.mime_type first, not downloaded.mimeType: it's the type the
  // provider declared at discovery time (Slack's file.mimetype, Gmail's MIME
  // part, Chat's contentType field), which is more specific than whatever a
  // binary-serving download endpoint's Content-Type header reports. Google
  // Chat's media.download endpoint in particular answers every attachment
  // with a generic application/octet-stream regardless of the real file
  // type — trusting that over the already-known type stored a real PDF
  // under a Content-Type that made browsers refuse to preview it inline.
  const uploadResult = await uploadAttachmentBytes(storagePath, downloaded.bytes, attachment.mime_type ?? downloaded.mimeType ?? undefined);
  if (!uploadResult.ok) {
    // Continue anyway: extracting text doesn't depend on the bytes being
    // durably stored, and losing the ability to re-view the raw file later
    // is a lesser failure than dropping its text out of the LLM context.
    console.warn(`[attachments] storage upload failed for ${attachment.id}: ${uploadResult.error}`);
  }

  const parsed = await parseAttachmentText(plan, downloaded.bytes, MAX_EXTRACTED_TEXT_CHARS);
  if (!parsed.ok) {
    await service
      .from("event_attachments")
      .update({
        status: "failed",
        error: parsed.error,
        storage_path: uploadResult.ok ? storagePath : null,
      })
      .eq("id", attachment.id)
      .eq("status", "pending");
    return 0;
  }

  await service
    .from("event_attachments")
    .update({
      status: "extracted",
      extracted_text: parsed.text,
      extracted_chars: parsed.text.length,
      text_truncated: parsed.truncated,
      storage_path: uploadResult.ok ? storagePath : null,
    })
    .eq("id", attachment.id)
    .eq("status", "pending");

  // Stamped with the PARENT EVENT's occurred_at/resource_url, not extraction
  // time — this is when the file was actually shared, which is what keeps
  // search_chunks_space_time_idx meaningful for attachment-sourced chunks.
  return insertChunksForSource(service, {
    clientSpaceId: integration.client_space_id,
    projectId: integration.project_id,
    sourceKind: "event_attachment",
    sourceId: attachment.id,
    provider: integration.provider,
    occurredAt: attachment.normalized_events?.occurred_at ?? new Date().toISOString(),
    title: attachment.filename,
    sourceUrl: attachment.normalized_events?.resource_url,
    text: parsed.text,
  });
}
