import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { getConnector } from "@/connectors/registry";
import { createDeadline } from "@/connectors/deadline";
import { loadCredentials } from "@/services/sync/credentials";
import { ConnectorAuthError } from "@/connectors/errors";
import { toBytea } from "@/lib/db/bytea";
import { uuidv7 } from "@/lib/db/uuid";
import { enqueueJob } from "@/lib/queue";
import { projectToday } from "@/lib/date/project-day";
import { settleBatchMembership, triggerDailyExtraction } from "@/services/sync/batch";
import type { Database, Json } from "@/lib/db/database.types";

/** One cursor row per project connector (scope_key='default') holding
 * whatever opaque cursor shape the connector returned last time — see
 * connectors/types.ts's `FetchResult.nextCursor`. Not exploded into
 * per-resource rows: every connector we have already treats its cursor as a
 * single composite object internally, so there is nothing finer-grained to
 * store yet — see project_connector_cursors' schema comment for when that
 * would change. */
const CURSOR_SCOPE_KEY = "default";

const MAX_BACKOFF_SECONDS = 24 * 60 * 60;

// Leaves ~15s of headroom under the route's 60s maxDuration for the
// raw_events/normalized_events writes and cursor upsert that happen after
// fetchSince returns, plus whatever Vercel's own cold-start overhead is.
const FETCH_BUDGET_MS = 45_000;

// A follow-up sync job is chained (via hasMore) at most this many times
// before we give up for this cron cycle — a runaway connector that always
// reports hasMore:true must not fan out indefinitely.
const MAX_SYNC_CHAIN_DEPTH = 5;

// supabase/config.toml sets [api] max_rows = 1000, which silently truncates
// any single .in() read past that size — under-reporting what's already
// stored, which then makes the partial dedupe index reject the ENTIRE insert
// batch. Chunking well under that ceiling turns a silent truncation into a
// correct (if slower) multi-request read. Also caps the request URL size,
// which Kong (Supabase's gateway) will otherwise 414 on for a large batch.
const DEDUPE_CHUNK_SIZE = 150;

// raw_events payloads range from a few hundred bytes (Slack messages) to
// tens of KB (Gmail bodies, Drive text excerpts) — chunking the insert keeps
// any single PostgREST request well under its body-size ceiling.
const RAW_INSERT_CHUNK_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export interface RunSyncResult {
  status: "succeeded" | "failed" | "skipped";
  eventsFetched: number;
  eventsWritten: number;
  hasMore: boolean;
  error?: string;
}

/**
 * Runs the full fetch -> raw_events -> normalize -> normalized_events
 * pipeline for one project connector, exactly once, then advances its
 * cursor. Safe to call repeatedly (raw/normalized inserts are
 * dedupe-on-conflict); NOT safe to call concurrently for the same connector
 * — the `sync_jobs_one_active_per_connector` partial unique index enforces
 * that by making the initial insert fail, which this function treats as a
 * deliberate no-op ("skipped"), not an error.
 */
export async function runSync(
  projectConnectorId: string,
  trigger: Database["public"]["Enums"]["sync_trigger"] = "manual",
  chainDepth = 0,
  // Only ever passed on a self-chained follow-up (see the hasMore branch
  // below) — pins the batch this connector reports to across hops so a chain
  // spanning local midnight doesn't attribute to the wrong day. Every other
  // caller (cron, manual "Sync Now") omits it and we compute "today" fresh,
  // matching how src/app/api/cron/tick/route.ts seeded the batch.
  batchDate?: string,
): Promise<RunSyncResult> {
  const service = createServiceClient();

  // The unit of sync is now the PROJECT CONNECTOR, not a client-space-wide
  // integration: config and schedule live here, while the provider grant it
  // authenticates with lives one level up on space_connections. Two projects
  // scoping the same channel therefore each run their own sync and keep their
  // own cursor — deliberate, and the reason every write below carries
  // project_id.
  const { data: connector_ } = await service
    .from("project_connectors")
    .select("id, client_space_id, project_id, provider, connection_id, sync_interval_seconds, consecutive_failures, config")
    .eq("id", projectConnectorId)
    .maybeSingle();
  if (!connector_) {
    return { status: "failed", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: "Project connector not found" };
  }
  const pc = connector_;

  const { data: clientSpaceRow } = await service
    .from("client_spaces")
    .select("timezone")
    .eq("id", pc.client_space_id)
    .maybeSingle();
  const effectiveBatchDate = batchDate ?? projectToday(clientSpaceRow?.timezone ?? "UTC");

  const { data: job, error: jobError } = await service
    .from("sync_jobs")
    .insert({
      client_space_id: pc.client_space_id,
      project_connector_id: pc.id,
      status: "running",
      trigger,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    // Most likely cause: sync_jobs_one_active_per_connector already has a
    // queued/running row for this connector — a legitimate race, not a bug.
    return { status: "skipped", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: jobError?.message };
  }

  try {
    const connector = getConnector(pc.provider);
    const credentials = await loadCredentials(service, pc);

    const { data: cursorRow } = await service
      .from("project_connector_cursors")
      .select("cursor")
      .eq("project_connector_id", pc.id)
      .eq("scope_key", CURSOR_SCOPE_KEY)
      .maybeSingle();

    const fetchResult = await connector.fetchSince(credentials, cursorRow?.cursor ?? null, {
      config: (pc.config ?? {}) as Record<string, unknown>,
      deadline: createDeadline(FETCH_BUDGET_MS),
    });

    const rawRows = fetchResult.rawPayloads.map((raw) => ({
      id: uuidv7(),
      client_space_id: pc.client_space_id,
      project_id: pc.project_id,
      project_connector_id: pc.id,
      sync_job_id: job.id,
      provider: pc.provider,
      provider_event_id: raw.providerEventId ?? null,
      payload: raw.payload as Json,
      payload_hash: raw.providerEventId
        ? null
        : toBytea(createHash("sha256").update(JSON.stringify(raw.payload)).digest()),
      occurred_at: raw.occurredAt?.toISOString() ?? null,
    }));

    let eventsWritten = 0;
    let attachmentsPending = 0;
    if (rawRows.length > 0) {
      // raw_events' dedupe indexes are PARTIAL (`where provider_event_id is
      // not null` / `where provider_event_id is null and payload_hash is not
      // null`) — Postgres requires an ON CONFLICT target's predicate to
      // match a partial index exactly, which PostgREST's upsert has no way
      // to express, so it fails with "no unique or exclusion constraint
      // matching the ON CONFLICT specification". Pre-filter against what's
      // already stored instead of relying on ON CONFLICT.
      //
      // Chunked at DEDUPE_CHUNK_SIZE: a single .in() over more than
      // max_rows (supabase/config.toml, currently 1000) is silently
      // truncated by PostgREST, which under-reports what's already stored
      // and makes the dedupe index reject the whole insert batch below —
      // and a single huge .in() also risks a 414 from the gateway. Each
      // chunk is a real request, so a chunk failure throws rather than
      // silently dropping rows. Race-safe because
      // sync_jobs_one_active_per_connector guarantees no other sync for this
      // same connector is running concurrently.
      const candidateProviderEventIds = rawRows.map((r) => r.provider_event_id).filter((id): id is string => id !== null);
      const alreadySeen = new Set<string>();
      for (const idChunk of chunk(candidateProviderEventIds, DEDUPE_CHUNK_SIZE)) {
        const { data: existingRaw, error: existingError } = await service
          .from("raw_events")
          .select("provider_event_id")
          .eq("project_connector_id", pc.id)
          .in("provider_event_id", idChunk);
        if (existingError) throw new Error(`raw_events dedupe lookup failed: ${existingError.message}`);
        for (const row of existingRaw ?? []) {
          if (row.provider_event_id) alreadySeen.add(row.provider_event_id);
        }
      }
      const newRawRows = rawRows.filter((r) => r.provider_event_id === null || !alreadySeen.has(r.provider_event_id));

      const insertedRaw: { id: string; provider_event_id: string | null }[] = [];
      for (const rowChunk of chunk(newRawRows, RAW_INSERT_CHUNK_SIZE)) {
        const { data, error: rawError } = await service.from("raw_events").insert(rowChunk).select("id, provider_event_id");
        if (rawError) throw new Error(`raw_events insert failed: ${rawError.message}`);
        insertedRaw.push(...(data ?? []));
      }

      const rawIdByProviderEventId = new Map(insertedRaw.map((r) => [r.provider_event_id, r.id]));

      // Kept alongside its NormalizedEventDraft (not just the DB row) so the
      // attachment-persistence step below can read draft.attachments without
      // calling connector.normalize() a second time on the same raw payload
      // — normalize() is pure, but there's no reason to pay for it twice.
      const normalizedDrafts = fetchResult.rawPayloads
        .filter((raw) => raw.providerEventId && rawIdByProviderEventId.has(raw.providerEventId))
        .flatMap((raw) =>
          connector.normalize(raw).map((draft) => ({
            draft,
            row: {
              id: uuidv7(),
              client_space_id: pc.client_space_id,
              project_id: pc.project_id,
              project_connector_id: pc.id,
              raw_event_id: rawIdByProviderEventId.get(raw.providerEventId!) ?? null,
              provider: pc.provider,
              type: draft.type,
              actor: draft.actor ?? null,
              actor_display: draft.actorDisplay ?? null,
              actor_email: draft.actorEmail ?? null,
              resource: draft.resource ?? null,
              resource_type: draft.resourceType ?? null,
              resource_url: draft.resourceUrl ?? null,
              title: draft.title ?? null,
              body: draft.body ?? null,
              occurred_at: draft.occurredAt.toISOString(),
              metadata: (draft.metadata ?? {}) as Json,
              dedupe_key: draft.dedupeKey,
            },
          })),
        );
      const normalizedRows = normalizedDrafts.map((d) => d.row);

      if (normalizedRows.length > 0) {
        const { data: insertedNormalized, error: normalizedError } = await service
          .from("normalized_events")
          .upsert(normalizedRows, { onConflict: "project_connector_id,dedupe_key", ignoreDuplicates: true })
          .select("id");
        if (normalizedError) throw new Error(`normalized_events insert failed: ${normalizedError.message}`);
        eventsWritten = insertedNormalized?.length ?? 0;
      }

      // Persist any attachments the connector's normalize() described (pure,
      // no download here — see connectors/types.ts's AttachmentDraft doc
      // comment for why that's a separate async job). Config-gated the same
      // way every other client-writable numeric/boolean config field is:
      // untyped read, default true, never trust the shape
      // (project_connectors.config is jsonb any project manager can PATCH
      // directly).
      const processAttachmentsConfig = (pc.config as Record<string, unknown> | null)?.processAttachments;
      const draftsWithAttachments =
        processAttachmentsConfig === false
          ? []
          : normalizedDrafts.filter((d) => d.draft.attachments && d.draft.attachments.length > 0);

      if (draftsWithAttachments.length > 0) {
        // The normalized_events upsert above only RETURNS newly-inserted
        // rows (ignoreDuplicates: true) — a draft with attachments may
        // belong to a row that already existed from an earlier partial run
        // of this same sync (chained via hasMore), so resolve every such
        // row's id by dedupe_key rather than trusting insertedNormalized.
        const dedupeKeys = draftsWithAttachments.map((d) => d.draft.dedupeKey);
        const eventIdByDedupeKey = new Map<string, string>();
        for (const keyChunk of chunk(dedupeKeys, DEDUPE_CHUNK_SIZE)) {
          const { data: existingEvents, error: existingEventsError } = await service
            .from("normalized_events")
            .select("id, dedupe_key")
            .eq("project_connector_id", pc.id)
            .in("dedupe_key", keyChunk);
          if (existingEventsError) {
            throw new Error(`normalized_events lookup for attachments failed: ${existingEventsError.message}`);
          }
          for (const row of existingEvents ?? []) eventIdByDedupeKey.set(row.dedupe_key, row.id);
        }

        const attachmentRows = draftsWithAttachments.flatMap(({ draft }) => {
          const normalizedEventId = eventIdByDedupeKey.get(draft.dedupeKey);
          if (!normalizedEventId) return []; // shouldn't happen — the upsert above just wrote or already had this row
          // project_connector_id is load-bearing, not redundant: the
          // attachments job downloads bytes with the credentials of the
          // connector that saw the file, and a project may scope several
          // connectors. See 20260901001800_event_attachments_connector.sql.
          return (draft.attachments ?? []).map((a) => ({
            id: uuidv7(),
            client_space_id: pc.client_space_id,
            project_id: pc.project_id,
            project_connector_id: pc.id,
            normalized_event_id: normalizedEventId,
            provider: pc.provider,
            provider_attachment_id: a.providerAttachmentId,
            filename: a.filename ?? null,
            mime_type: a.mimeType ?? null,
            size_bytes: a.sizeBytes ?? null,
            download_ref: a.downloadRef as Json,
          }));
        });

        for (const rowChunk of chunk(attachmentRows, RAW_INSERT_CHUNK_SIZE)) {
          const { data: insertedAttachments, error: attachmentsError } = await service
            .from("event_attachments")
            .upsert(rowChunk, { onConflict: "normalized_event_id,provider_attachment_id", ignoreDuplicates: true })
            .select("id");
          if (attachmentsError) throw new Error(`event_attachments insert failed: ${attachmentsError.message}`);
          attachmentsPending += insertedAttachments?.length ?? 0;
        }
      }
    }

    await service.from("project_connector_cursors").upsert(
      {
        project_connector_id: pc.id,
        scope_key: CURSOR_SCOPE_KEY,
        cursor: fetchResult.nextCursor as Database["public"]["Tables"]["project_connector_cursors"]["Insert"]["cursor"],
        last_advanced_at: new Date().toISOString(),
      },
      { onConflict: "project_connector_id,scope_key" },
    );

    // Health bookkeeping is per-CONNECTOR, not per-connection. There is no
    // `status` column on project_connectors by design: a connection is
    // shared by every project in the space, so one project's bad channel id
    // must not mark the whole grant broken. Only auth failures touch
    // space_connections.status — see the catch block below.
    const nowIso = new Date().toISOString();
    await service
      .from("project_connectors")
      .update({
        last_sync_started_at: nowIso,
        last_sync_succeeded_at: nowIso,
        next_sync_at: new Date(Date.now() + pc.sync_interval_seconds * 1000).toISOString(),
        consecutive_failures: 0,
        last_error: null,
      })
      .eq("id", pc.id);

    // A successful fetch proves the grant works. Clear a previously degraded
    // connection so the UI stops nagging once the underlying problem is gone.
    await service
      .from("space_connections")
      .update({ status: "connected", last_validated_at: nowIso })
      .eq("id", pc.connection_id)
      .neq("status", "revoked");

    await service
      .from("sync_jobs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        events_fetched: fetchResult.rawPayloads.length,
        events_written: eventsWritten,
      })
      .eq("id", job.id);

    if (fetchResult.hasMore && chainDepth < MAX_SYNC_CHAIN_DEPTH) {
      // The connector couldn't drain everything within its time budget (a
      // large Drive backlog, a busy Gmail mailbox). With a once-a-day cron
      // and a 60s function cap, waiting for the next scheduled tick means an
      // integration that produces more than it can process in one run NEVER
      // catches up — so chain one bounded follow-up job immediately instead.
      // This runs AFTER the sync_jobs row above is marked "succeeded" (not
      // "running") specifically because sync_jobs_one_active_per_integration
      // would otherwise reject the follow-up job's own insert. Not terminal
      // for today's batch yet — pin effectiveBatchDate through so the chain
      // still reports to the same batch even if a hop crosses local midnight.
      await enqueueJob("/api/jobs/sync", {
        projectConnectorId: pc.id,
        trigger,
        chainDepth: chainDepth + 1,
        batchDate: effectiveBatchDate,
      }).catch((err) => {
        console.error(`[sync] failed to enqueue follow-up sync for connector ${pc.id}:`, err);
      });
    } else {
      if (fetchResult.hasMore) {
        console.warn(
          `[sync] connector ${pc.id} still has more to fetch after ${MAX_SYNC_CHAIN_DEPTH} chained runs — deferring to the next scheduled sync`,
        );
      }

      // Terminal for today, one way or another. If this integration belongs
      // to a coordinated daily batch (src/services/sync/batch.ts), report in
      // and let the batch fire extraction once every member has; otherwise
      // fall back to the old immediate-trigger-on-write behavior (e.g. a
      // manual "Sync Now" outside of any active batch). EXCEPT: if this run
      // discovered attachments that still need downloading/parsing, hand
      // settle-and-trigger responsibility to /api/jobs/attachments instead —
      // normalized_events.body is already fixed above, so extracted text can
      // only reach the LLM if extraction happens BEFORE triggerDailyExtraction
      // fires. If the handoff enqueue itself fails, fall through to settling
      // immediately below rather than leaving the batch (or this project's
      // extraction) waiting on a job that was never actually queued.
      let handedOffToAttachmentsJob = false;
      if (attachmentsPending > 0) {
        try {
          await enqueueJob("/api/jobs/attachments", {
            projectConnectorId: pc.id,
            batchDate: effectiveBatchDate,
            chainDepth: 0,
          });
          handedOffToAttachmentsJob = true;
        } catch (err) {
          console.error(
            `[sync] failed to enqueue attachments job for connector ${pc.id} — settling batch immediately; this run's attachment text will be missing from today's extraction:`,
            err,
          );
        }
      }

      if (!handedOffToAttachmentsJob) {
        const settled = await settleBatchMembership(service, {
          clientSpaceId: pc.client_space_id,
          projectConnectorId: pc.id,
          batchDate: effectiveBatchDate,
          outcome: "succeeded",
        });
        if (settled.inBatch) {
          if (settled.firedLlmJob) {
            await triggerDailyExtraction(service, pc.client_space_id, effectiveBatchDate);
          } else if (settled.alreadySettled && eventsWritten > 0) {
            // This integration already reported in for today's batch
            // earlier (its one-shot trigger already fired) — a LATER sync
            // with new events must fire its own extraction, or those events
            // would sit unprocessed until tomorrow's batch or its backlog
            // sweep. Safe to call more than once a day: triggerDailyExtraction
            // only ever picks up events with processed_at still null.
            //
            // Debounced (unlike every other triggerDailyExtraction call in
            // this file): with the tick now running every minute instead of
            // once a day, THIS is the branch a sub-daily-interval connector
            // hits on nearly every sync once it's caught up for the day —
            // ungated, that's up to ~1440 extraction rounds/day per client
            // space, each sweeping up to 30 days of backlog. See
            // triggerDailyExtraction's own doc comment for why debouncing
            // here can't lose events, only delay them.
            await triggerDailyExtraction(service, pc.client_space_id, effectiveBatchDate, { debounce: true });
          }
        } else if (eventsWritten > 0) {
          await triggerDailyExtraction(service, pc.client_space_id, effectiveBatchDate);
        }
      }
    }

    return {
      status: "succeeded",
      eventsFetched: fetchResult.rawPayloads.length,
      eventsWritten,
      hasMore: fetchResult.hasMore,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const nowIso = new Date().toISOString();
    const consecutiveFailures = pc.consecutive_failures + 1;
    const backoffSeconds = Math.min(pc.sync_interval_seconds * 2 ** consecutiveFailures, MAX_BACKOFF_SECONDS);

    await service
      .from("sync_jobs")
      .update({ status: "failed", finished_at: nowIso, error_message: message })
      .eq("id", job.id);

    await service
      .from("project_connectors")
      .update({
        consecutive_failures: consecutiveFailures,
        last_error: message,
        next_sync_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      })
      .eq("id", pc.id);

    // Only an AUTH failure is evidence about the GRANT rather than about this
    // one project's config. A bad channel id in one project's config must not
    // mark a connection broken for every other project in the space — which
    // is exactly what the old single-table design did, because status and
    // config lived on the same row. Nango owns refresh and revocation state
    // (see connectors/errors.ts), so this is a local health flag for the UI,
    // not an attempt to manage the token.
    if (err instanceof ConnectorAuthError) {
      await service
        .from("space_connections")
        .update({ status: "error" })
        .eq("id", pc.connection_id);
    }

    // A broken connector must not hang the rest of the client space's
    // batch — settle its membership (idempotent: an at-least-once-redelivered
    // failure just finds itself already settled and no-ops) but never
    // trigger extraction on a failure path, batch or not — no new data.
    const settled = await settleBatchMembership(service, {
      clientSpaceId: pc.client_space_id,
      projectConnectorId: pc.id,
      batchDate: effectiveBatchDate,
      outcome: "failed",
    });
    if (settled.inBatch && settled.firedLlmJob) {
      await triggerDailyExtraction(service, pc.client_space_id, effectiveBatchDate);
    }

    return { status: "failed", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: message };
  }
}
