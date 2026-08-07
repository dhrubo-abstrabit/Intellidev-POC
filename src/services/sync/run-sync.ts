import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { getConnector } from "@/connectors/registry";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorAuthError } from "@/connectors/errors";
import { loadCredentials } from "@/services/sync/credentials";
import { toBytea } from "@/lib/crypto/tokens";
import { uuidv7 } from "@/lib/db/uuid";
import { publishJob } from "@/lib/queue/qstash";
import type { Database, Json } from "@/lib/db/database.types";

export type IntegrationRow = Pick<
  Database["public"]["Tables"]["integrations"]["Row"],
  | "id"
  | "workspace_id"
  | "project_id"
  | "provider"
  | "credential_id"
  | "sync_interval_seconds"
  | "consecutive_failures"
  | "config"
>;

/** One cursor row per integration (scope_key='default') holding whatever
 * opaque cursor shape the connector returned last time — see connectors/
 * types.ts's `FetchResult.nextCursor`. Not exploded into per-resource rows:
 * every connector we have (mock, slack) already treats its cursor as a
 * single composite object internally, so there is nothing finer-grained to
 * store yet — see integration_cursors' schema comment for when that would
 * change. */
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
 * pipeline for one integration, exactly once, then advances its cursor.
 * Safe to call repeatedly (raw/normalized inserts are dedupe-on-conflict);
 * NOT safe to call concurrently for the same integration — the
 * `sync_jobs_one_active_per_integration` partial unique index enforces that
 * by making the initial insert fail, which this function treats as a
 * deliberate no-op ("skipped"), not an error.
 */
export async function runSync(
  integrationId: string,
  trigger: Database["public"]["Enums"]["sync_trigger"] = "manual",
  chainDepth = 0,
): Promise<RunSyncResult> {
  const service = createServiceClient();

  const { data: integration } = await service
    .from("integrations")
    .select("id, workspace_id, project_id, provider, credential_id, sync_interval_seconds, consecutive_failures, config")
    .eq("id", integrationId)
    .maybeSingle();
  if (!integration) {
    return { status: "failed", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: "Integration not found" };
  }

  const { data: job, error: jobError } = await service
    .from("sync_jobs")
    .insert({
      workspace_id: integration.workspace_id,
      project_id: integration.project_id,
      integration_id: integration.id,
      status: "running",
      trigger,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    // Most likely cause: sync_jobs_one_active_per_integration already has a
    // queued/running row for this integration — a legitimate race, not a bug.
    return { status: "skipped", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: jobError?.message };
  }

  try {
    const connector = getConnector(integration.provider);
    const credentials = await loadCredentials(service, integration, connector);

    const { data: cursorRow } = await service
      .from("integration_cursors")
      .select("cursor")
      .eq("integration_id", integration.id)
      .eq("scope_key", CURSOR_SCOPE_KEY)
      .maybeSingle();

    const fetchResult = await connector.fetchSince(credentials, cursorRow?.cursor ?? null, {
      config: (integration.config ?? {}) as Record<string, unknown>,
      deadline: createDeadline(FETCH_BUDGET_MS),
    });

    const rawRows = fetchResult.rawPayloads.map((raw) => ({
      id: uuidv7(),
      workspace_id: integration.workspace_id,
      project_id: integration.project_id,
      integration_id: integration.id,
      sync_job_id: job.id,
      provider: integration.provider,
      provider_event_id: raw.providerEventId ?? null,
      payload: raw.payload as Json,
      payload_hash: raw.providerEventId
        ? null
        : toBytea(createHash("sha256").update(JSON.stringify(raw.payload)).digest()),
      occurred_at: raw.occurredAt?.toISOString() ?? null,
    }));

    let eventsWritten = 0;
    if (rawRows.length > 0) {
      // raw_events' dedupe indexes are PARTIAL (`where provider_event_id is
      // not null` / `where provider_event_id is null and payload_hash is not
      // null`) — Postgres requires an ON CONFLICT target's predicate to
      // match a partial index exactly, which PostgREST's upsert has no way
      // to express, so it fails with "no unique or exclusion constraint
      // matching the ON CONFLICT specification". Pre-filter against what's
      // already stored instead of relying on ON CONFLICT. This is race-safe
      // because sync_jobs_one_active_per_integration guarantees no other
      // sync for this same integration is running concurrently.
      //
      // Chunked at DEDUPE_CHUNK_SIZE: a single .in() over more than
      // max_rows (supabase/config.toml, currently 1000) is silently
      // truncated by PostgREST, which under-reports what's already stored
      // and makes the dedupe index reject the whole insert batch below —
      // and a single huge .in() also risks a 414 from the gateway. Each
      // chunk is a real request, so a chunk failure throws rather than
      // silently dropping rows.
      const candidateProviderEventIds = rawRows.map((r) => r.provider_event_id).filter((id): id is string => id !== null);
      const alreadySeen = new Set<string>();
      for (const idChunk of chunk(candidateProviderEventIds, DEDUPE_CHUNK_SIZE)) {
        const { data: existingRaw, error: existingError } = await service
          .from("raw_events")
          .select("provider_event_id")
          .eq("integration_id", integration.id)
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

      const normalizedRows = fetchResult.rawPayloads
        .filter((raw) => raw.providerEventId && rawIdByProviderEventId.has(raw.providerEventId))
        .flatMap((raw) =>
          connector.normalize(raw).map((draft) => ({
            id: uuidv7(),
            workspace_id: integration.workspace_id,
            project_id: integration.project_id,
            integration_id: integration.id,
            raw_event_id: rawIdByProviderEventId.get(raw.providerEventId!) ?? null,
            provider: integration.provider,
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
          })),
        );

      if (normalizedRows.length > 0) {
        const { data: insertedNormalized, error: normalizedError } = await service
          .from("normalized_events")
          .upsert(normalizedRows, { onConflict: "integration_id,dedupe_key", ignoreDuplicates: true })
          .select("id");
        if (normalizedError) throw new Error(`normalized_events insert failed: ${normalizedError.message}`);
        eventsWritten = insertedNormalized?.length ?? 0;
      }
    }

    await service.from("integration_cursors").upsert(
      {
        integration_id: integration.id,
        scope_key: CURSOR_SCOPE_KEY,
        cursor: fetchResult.nextCursor as Database["public"]["Tables"]["integration_cursors"]["Insert"]["cursor"],
        last_advanced_at: new Date().toISOString(),
      },
      { onConflict: "integration_id,scope_key" },
    );

    const nowIso = new Date().toISOString();
    await service
      .from("integrations")
      .update({
        status: "connected",
        last_sync_started_at: nowIso,
        last_sync_succeeded_at: nowIso,
        next_sync_at: new Date(Date.now() + integration.sync_interval_seconds * 1000).toISOString(),
        consecutive_failures: 0,
        last_error: null,
      })
      .eq("id", integration.id);

    await service
      .from("sync_jobs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        events_fetched: fetchResult.rawPayloads.length,
        events_written: eventsWritten,
      })
      .eq("id", job.id);

    if (eventsWritten > 0) {
      // Best-effort: a failure to enqueue shouldn't fail an otherwise
      // successful sync. Cron's next tick isn't a real backstop for THIS
      // (it only re-syncs the integration, it never re-triggers the LLM
      // job for events already marked ingested) — acceptable for now since
      // publishJob failing here is rare and the schema note in
      // normalized_events_unprocessed_idx means a future manual/cron sweep
      // over unprocessed events would still catch it.
      await publishJob("/api/jobs/llm", { projectId: integration.project_id }).catch((err) => {
        console.error(`[sync] failed to enqueue LLM job for project ${integration.project_id}:`, err);
      });
    }

    if (fetchResult.hasMore && chainDepth < MAX_SYNC_CHAIN_DEPTH) {
      // The connector couldn't drain everything within its time budget (a
      // large Drive backlog, a busy Gmail mailbox). With a once-a-day cron
      // and a 60s function cap, waiting for the next scheduled tick means an
      // integration that produces more than it can process in one run NEVER
      // catches up — so chain one bounded follow-up job immediately instead.
      // This runs AFTER the sync_jobs row above is marked "succeeded" (not
      // "running") specifically because sync_jobs_one_active_per_integration
      // would otherwise reject the follow-up job's own insert.
      await publishJob("/api/jobs/sync", { integrationId: integration.id, trigger, chainDepth: chainDepth + 1 }).catch(
        (err) => {
          console.error(`[sync] failed to enqueue follow-up sync for integration ${integration.id}:`, err);
        },
      );
    } else if (fetchResult.hasMore) {
      console.warn(
        `[sync] integration ${integration.id} still has more to fetch after ${MAX_SYNC_CHAIN_DEPTH} chained runs — deferring to the next scheduled sync`,
      );
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
    const consecutiveFailures = integration.consecutive_failures + 1;
    const backoffSeconds = Math.min(integration.sync_interval_seconds * 2 ** consecutiveFailures, MAX_BACKOFF_SECONDS);

    await service
      .from("sync_jobs")
      .update({ status: "failed", finished_at: nowIso, error_message: message })
      .eq("id", job.id);

    if (err instanceof ConnectorAuthError && integration.credential_id) {
      // The provider rejected our current access token. Clear its expiry so
      // services/sync/credentials.ts's needsRefresh() treats it as "unknown,
      // must refresh" on the next run — a single 401 isn't proof the grant
      // itself is gone, so revoked_at is deliberately left untouched.
      await service
        .from("connector_credentials")
        .update({ access_token_expires_at: null })
        .eq("id", integration.credential_id)
        .eq("workspace_id", integration.workspace_id);
    }

    await service
      .from("integrations")
      .update({
        status: consecutiveFailures >= 3 ? "error" : "degraded",
        consecutive_failures: consecutiveFailures,
        last_error: message,
        next_sync_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      })
      .eq("id", integration.id);

    return { status: "failed", eventsFetched: 0, eventsWritten: 0, hasMore: false, error: message };
  }
}
