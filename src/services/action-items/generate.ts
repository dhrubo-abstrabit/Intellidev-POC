import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { getLLMProvider } from "@/lib/llm/factory";
import { estimateCostUsd } from "@/lib/llm/pricing";
import { PROMPT_VERSION } from "@/lib/llm/prompt";
import { uuidv7 } from "@/lib/db/uuid";
import { projectDayKey, utcWindowForDay } from "@/lib/date/project-day";
import { fetchRelatedContext } from "@/services/action-items/related-context";
import type { ActionItemContext, DraftForConsolidation, LLMUsage, OpenActionItemSummary, RelatedContextChunk } from "@/lib/llm/types";
import type { ActionItemDraft } from "@/lib/llm/schema";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Per-call cap on how many of the day's events go into a single extraction
// call; a day with more than this across all connectors is split into
// multiple chunks run in parallel (see generateActionItems) rather than
// growing one call unboundedly.
const MAX_EVENTS_PER_CHUNK = 200;
// supabase/config.toml sets [api] max_rows = 1000, which silently truncates
// any single PostgREST read past that size — run-sync.ts's DEDUPE_CHUNK_SIZE
// comment documents the same trap. Page through in chunks of this size
// rather than relying on a single unbounded .select().
const EVENT_FETCH_PAGE_SIZE = 1000;
// Same chunking rationale as above, applied to the event_attachments join's
// .in(normalized_event_id) lookup — well under max_rows and under whatever
// URL-length ceiling Kong (Supabase's gateway) enforces for a large batch.
const ATTACHMENT_FETCH_CHUNK_SIZE = 150;

export interface GenerateActionItemsResult {
  status: "succeeded" | "skipped" | "failed";
  itemsCreated: number;
  itemsMerged: number;
  error?: string;
}

/** dedupe_hash is a hash of the item's own (normalized) title. Once
 * consolidation has run, that title is either an existing open item's real
 * stored title (never the model's echo of it) or a freshly-minted canonical
 * title — either way this hash-check is now a safety net against races and
 * missed groupings, not the primary dedup mechanism. */
function normalizedTitleHash(title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function sumUsage(usages: LLMUsage[]): LLMUsage {
  return usages.reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
    }),
    { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
}

type UnprocessedEventRow = Pick<
  Database["public"]["Tables"]["normalized_events"]["Row"],
  "id" | "type" | "actor_display" | "actor" | "title" | "body" | "occurred_at"
>;

/** Pages through every unprocessed event whose occurred_at falls on `date`
 * in the client space's own timezone. utcWindowForDay bounds the query
 * loosely (a UTC day either side of the nominal date, to guarantee it
 * contains the whole local day at any offset); projectDayKey then buckets
 * precisely — see src/lib/date/project-day.ts's own doc comment for why this
 * two-step shape is necessary (PostgREST can't express the timezone
 * conversion). Events key on client_space_id, not project_id — see
 * supabase/migrations/20260820101000_events.sql. */
async function fetchUnprocessedEventsForDay(
  service: ServiceClient,
  clientSpaceId: string,
  date: string,
  timezone: string,
): Promise<UnprocessedEventRow[]> {
  const { gte, lt } = utcWindowForDay(date);
  const rows: UnprocessedEventRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await service
      .from("normalized_events")
      .select("id, type, actor_display, actor, title, body, occurred_at")
      .eq("client_space_id", clientSpaceId)
      .is("processed_at", null)
      .gte("occurred_at", gte)
      .lt("occurred_at", lt)
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + EVENT_FETCH_PAGE_SIZE - 1);
    if (error) throw new Error(`normalized_events fetch failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < EVENT_FETCH_PAGE_SIZE) break;
    offset += EVENT_FETCH_PAGE_SIZE;
  }
  return rows.filter((row) => row.occurred_at && projectDayKey(row.occurred_at, timezone) === date);
}

type ExtractedAttachmentRow = Pick<
  Database["public"]["Tables"]["event_attachments"]["Row"],
  "id" | "normalized_event_id" | "filename" | "mime_type" | "extracted_text" | "text_truncated"
>;

/** Batch-fetches every EXTRACTED attachment for a set of events, keyed by
 * their owning normalized_event_id. `status='extracted'` only — pending/
 * skipped/failed rows have no text to contribute, and a pending row in
 * particular means extraction just hasn't happened yet by the time this
 * runs (see run-sync.ts's attachments-job handoff for why that should be
 * rare, not why it's impossible: a chain that hit MAX_ATTACHMENT_CHAIN_DEPTH
 * settles anyway with stragglers left pending). */
async function fetchExtractedAttachments(
  service: ServiceClient,
  eventIds: string[],
): Promise<Map<string, ExtractedAttachmentRow[]>> {
  const byEvent = new Map<string, ExtractedAttachmentRow[]>();
  if (eventIds.length === 0) return byEvent;

  for (const idChunk of chunkArray(eventIds, ATTACHMENT_FETCH_CHUNK_SIZE)) {
    const { data, error } = await service
      .from("event_attachments")
      .select("id, normalized_event_id, filename, mime_type, extracted_text, text_truncated")
      .in("normalized_event_id", idChunk)
      .eq("status", "extracted");
    if (error) throw new Error(`event_attachments fetch failed: ${error.message}`);
    for (const row of data ?? []) {
      const list = byEvent.get(row.normalized_event_id) ?? [];
      list.push(row);
      byEvent.set(row.normalized_event_id, list);
    }
  }
  return byEvent;
}

interface LoadedContext {
  base: Omit<ActionItemContext, "newEvents">;
  openActionItems: OpenActionItemSummary[];
  events: ActionItemContext["newEvents"];
  eventIds: string[];
}

interface ClientSpaceProjectContext {
  clientSpaceId: string;
  timezone: string;
  /** The client space's sole project (see generateActionItems' doc comment)
   * — only its name/description feed the prompt, exactly as when `projects`
   * carried its own timezone directly. */
  project: Pick<Database["public"]["Tables"]["projects"]["Row"], "id" | "name" | "description">;
}

async function loadContext(service: ServiceClient, ctx: ClientSpaceProjectContext, date: string): Promise<LoadedContext | null> {
  const { clientSpaceId, timezone, project } = ctx;
  const eventRows = await fetchUnprocessedEventsForDay(service, clientSpaceId, date, timezone);
  if (eventRows.length === 0) return null;

  const attachmentsByEvent = await fetchExtractedAttachments(service, eventRows.map((e) => e.id));

  // Scoped to the client space, not the project: tasks'
  // tasks_open_dedupe_uniq is (client_space_id, dedupe_hash), and
  // events (hence candidate items) are client-space scoped too — an item
  // tagged to no project (project_id null) is just as much "already open for
  // this client" as one tagged to this project.
  const { data: openItems } = await service
    .from("tasks")
    .select("id, title, kind, priority")
    .eq("client_space_id", clientSpaceId)
    .in("status", ["pending", "in_progress"]);

  const { data: recentSummaries } = await service
    .from("daily_summaries")
    .select("summary_date, summary")
    .eq("client_space_id", clientSpaceId)
    .order("summary_date", { ascending: false })
    .limit(3);

  const openActionItems: OpenActionItemSummary[] = (openItems ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    kind: i.kind,
    priority: i.priority,
  }));

  const events: ActionItemContext["newEvents"] = eventRows.map((e) => ({
    id: e.id,
    type: e.type,
    actorDisplay: e.actor_display ?? e.actor,
    title: e.title,
    body: e.body,
    occurredAt: e.occurred_at,
    attachments: attachmentsByEvent.get(e.id)?.map((a) => ({
      filename: a.filename,
      mimeType: a.mime_type,
      text: a.extracted_text ?? "",
      truncated: a.text_truncated,
    })),
  }));

  // Best-effort retrieval — must NEVER be able to fail extraction, same
  // posture this codebase already applies to Google Chat sender resolution
  // ("it must never be able to fail a sync"). A missing/empty result here
  // just means the prompt has no RELATED CONTEXT section this run, not a
  // failed run.
  let relatedContext: RelatedContextChunk[] = [];
  try {
    relatedContext = await fetchRelatedContext(service, {
      clientSpaceId,
      projectId: project.id,
      events,
      excludeSourceIds: eventRows.map((e) => e.id),
      excludeAttachmentIds: [...attachmentsByEvent.values()].flat().map((a) => a.id),
    });
  } catch (err) {
    console.warn(`[llm] related-context retrieval failed for ${clientSpaceId}:`, err);
  }

  return {
    base: {
      project: { id: project.id, name: project.name, description: project.description, timezone },
      openActionItems,
      recentSummaries: (recentSummaries ?? []).map((s) => ({ date: s.summary_date, summary: s.summary })),
      relatedContext,
    },
    openActionItems,
    events,
    eventIds: eventRows.map((e) => e.id),
  };
}

interface ResolvedItem {
  matchesOpenItemId: string | null;
  title: string;
  kind: ActionItemDraft["kind"];
  description?: string;
  priority: ActionItemDraft["priority"];
  confidence: number;
  ownerHint?: string;
  sourceEventIds: string[];
  /** Ephemeral per-run labels (e.g. "R2") cited from RELATED CONTEXT — see
   * chunksByLabel in generateActionItems for how these get resolved into
   * task_sources rows, and prompt.ts's Citations design for why this is a
   * separate, differently-trusted field from sourceEventIds. */
  relatedContextRefs: string[];
}

/** task_sources rows for a citation channel distinct from sourceEventIds —
 * one per RELATED CONTEXT chunk the model actually cited AND that resolves
 * to a real event (citableEventId is null for a context_document chunk,
 * which can't be cited via task_sources — see match_search_chunks' own doc
 * comment). role:'enriched' is what distinguishes these from the
 * sourceEventIds-driven rows below. relevance is a rough proxy from cosine
 * distance, not a calibrated confidence. */
function citationSourceLinks(
  taskId: string,
  clientSpaceId: string,
  citedChunks: RelatedContextChunk[],
): Database["public"]["Tables"]["task_sources"]["Insert"][] {
  return citedChunks.map((chunk) => ({
    task_id: taskId,
    normalized_event_id: chunk.citableEventId!,
    client_space_id: clientSpaceId,
    chunk_id: chunk.chunkId,
    role: "enriched",
    relevance: Math.max(0, Math.min(1, 1 - chunk.distance)),
  }));
}

/**
 * Generates (or refines) action items for one client space from whatever
 * normalized_events, across every connector, occurred on `date` in the
 * client space's own timezone and haven't been through the model yet. Safe
 * to call repeatedly: events are marked processed_at regardless of whether
 * they produced an item, and items merge onto existing open rows rather
 * than duplicating (see normalizedTitleHash and the consolidation pass
 * above it).
 *
 * Runs per CLIENT SPACE, not per project — events, credentials, sync jobs
 * and daily summaries all key on client_space_id now (see
 * supabase/migrations/20260820100600_client_spaces.sql). This app
 * provisions exactly one project per client space (see createProject in
 * src/app/(app)/w/[workspaceId]/actions.ts), so every created/merged item is
 * still tagged with that project's id below — that's what keeps Task
 * Management's per-project `.eq("project_id", ...)` filter working
 * unchanged.
 *
 * `date` is required and must be computed by the caller at enqueue time
 * (src/services/sync/run-sync.ts / batch.ts) — defaulting to "today" here
 * would be wrong for a job enqueued right before local midnight and
 * executed a few seconds into the next day.
 */
export async function generateActionItems(clientSpaceId: string, date: string): Promise<GenerateActionItemsResult> {
  const service = createServiceClient();

  const { data: clientSpace } = await service
    .from("client_spaces")
    .select("id, workspace_id, tenant_id, timezone")
    .eq("id", clientSpaceId)
    .maybeSingle();
  if (!clientSpace) {
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: "Client space not found" };
  }

  const { data: project } = await service
    .from("projects")
    .select("id, name, description")
    .eq("client_space_id", clientSpaceId)
    .maybeSingle();
  if (!project) {
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: "Project not found for this client space" };
  }

  const loaded = await loadContext(service, { clientSpaceId, timezone: clientSpace.timezone, project }, date);
  if (!loaded) {
    return { status: "skipped", itemsCreated: 0, itemsMerged: 0 };
  }
  const { base, openActionItems, events, eventIds } = loaded;

  // Resolved before the llm_runs insert, not inside the try block below —
  // an env-validation failure (e.g. a missing OPENAI_API_KEY) now surfaces
  // before an orphaned status:'running' row is ever created, and the
  // actual model is known up front so it never has to be hardcoded.
  const provider = getLLMProvider();

  const { data: run, error: runError } = await service
    .from("llm_runs")
    .insert({
      // llm_runs is keyed to the TENANT now, not the workspace — usage
      // metering is one GROUP BY over the billing boundary. tasks below still
      // carries workspace_id, for the team_members assignee FK.
      tenant_id: clientSpace.tenant_id,
      client_space_id: clientSpaceId,
      // llm_run_kind renamed this value: the old enum described the OUTPUT
      // ("action_items"), the new one describes the OPERATION ("extract"),
      // which is what distinguishes it from reconcile/daily_summary/embed.
      kind: "extract",
      status: "running",
      // Read from the provider, never hardcoded — llm_runs used to name
      // "claude-haiku-4-5"/"anthropic" unconditionally here regardless of
      // which provider actually ran, which made the audit trail lie the
      // moment a second provider existed.
      model: provider.model,
      provider: provider.id,
      prompt_version: PROMPT_VERSION,
      // llm_runs.input_event_ids is gone. It was an immutable uuid[] audit of
      // which events fed a run; task_sources now records the same linkage
      // per-task with a role and a relevance score, which is strictly more
      // useful and has referential integrity an array cannot have. The one
      // thing lost is the record for a run that produced NO tasks — see the
      // note in the handover if that turns out to matter.
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (runError || !run) {
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: runError?.message };
  }

  try {
    const chunks = chunkArray(events, MAX_EVENTS_PER_CHUNK);

    const extractions = await Promise.all(
      chunks.map((chunk) => provider.generateActionItems({ ...base, newEvents: chunk })),
    );

    // Sanity guard, not a functional check: every call in one run goes
    // through the same provider instance, so a mismatch here would mean the
    // provider itself returned a model string that disagrees with its own
    // declared .model — worth knowing about, not worth failing the run over.
    if (extractions.some((e) => e.model !== provider.model)) {
      console.warn(`[llm] provider ${provider.id} returned a result whose model didn't match its declared model "${provider.model}"`);
    }

    const allDrafts: ActionItemDraft[] = extractions.flatMap((e) => e.items);
    const usages: LLMUsage[] = extractions.map((e) => e.usage);
    const extractionChunksLog = extractions.map((e) => ({ prompt: e.prompt, response: e.response }));

    let resolvedItems: ResolvedItem[];
    let consolidationPromptLog: unknown = null;
    let consolidationResponseLog: unknown = null;

    if (allDrafts.length > 1) {
      const draftsForConsolidation: DraftForConsolidation[] = allDrafts.map((draft, i) => ({
        key: `d${i + 1}`,
        draft,
      }));
      const consolidationResult = await provider.consolidateActionItems(openActionItems, draftsForConsolidation);
      usages.push(consolidationResult.usage);
      consolidationPromptLog = consolidationResult.prompt;
      consolidationResponseLog = consolidationResult.response;

      const draftByKey = new Map(draftsForConsolidation.map((d) => [d.key, d.draft]));
      const openItemById = new Map(openActionItems.map((i) => [i.id, i]));

      resolvedItems = consolidationResult.consolidation.groups.map((group) => {
        const groupDrafts = group.draftKeys.map((k) => draftByKey.get(k)).filter((d): d is ActionItemDraft => Boolean(d));
        const sourceEventIds = [...new Set(groupDrafts.flatMap((d) => d.sourceEventIds))];
        const relatedContextRefs = [...new Set(groupDrafts.flatMap((d) => d.relatedContextRefs))];
        // Never trust the model's echoed id/title pairing blindly — an id
        // it invented or that no longer matches falls back to treating the
        // group as new, same as sourceEventIds is validated below.
        const matchedOpen = group.matchesOpenItemId ? openItemById.get(group.matchesOpenItemId) : undefined;
        return {
          matchesOpenItemId: matchedOpen?.id ?? null,
          title: matchedOpen ? matchedOpen.title : group.canonicalTitle,
          kind: group.kind,
          description: group.mergedDescription,
          priority: group.priority,
          confidence: group.confidence,
          ownerHint: group.ownerHint,
          sourceEventIds,
          relatedContextRefs,
        };
      });
    } else {
      resolvedItems = allDrafts.map((draft) => ({
        matchesOpenItemId: null,
        title: draft.title,
        kind: draft.kind,
        description: draft.description,
        priority: draft.priority,
        confidence: draft.confidence,
        ownerHint: draft.ownerHint,
        sourceEventIds: draft.sourceEventIds,
        relatedContextRefs: draft.relatedContextRefs,
      }));
    }

    const validEventIds = new Set(eventIds);
    const candidateHashes = resolvedItems.map((item) => normalizedTitleHash(item.title));
    // Scoped to the client space: tasks_open_dedupe_uniq is
    // (client_space_id, dedupe_hash), not (project_id, dedupe_hash) — see
    // supabase/migrations/20260820101100_ai.sql.
    const { data: existingOpen } = candidateHashes.length
      ? await service
          .from("tasks")
          .select("id, dedupe_hash")
          .eq("client_space_id", clientSpaceId)
          .in("status", ["pending", "in_progress"])
          .in("dedupe_hash", candidateHashes)
      : { data: [] as { id: string; dedupe_hash: string }[] };
    const existingByHash = new Map((existingOpen ?? []).map((row) => [row.dedupe_hash, row.id]));

    // Built once per run — RELATED CONTEXT and its labels are identical
    // across every extraction chunk (retrieval happens once in
    // loadContext, shared via `base`), so this map is valid for every item
    // below regardless of which chunk produced its underlying draft(s).
    const chunksByLabel = new Map((base.relatedContext ?? []).map((c) => [c.label, c]));

    let itemsCreated = 0;
    let itemsMerged = 0;
    const sourceLinks: Database["public"]["Tables"]["task_sources"]["Insert"][] = [];

    for (const item of resolvedItems) {
      const hash = normalizedTitleHash(item.title);
      // Re-checked on every iteration (not just against the DB snapshot
      // taken above) so two resolved items that land on the same hash
      // within this same run merge onto each other instead of both
      // inserting — the bug the exact-hash-only design used to have.
      const existingId = existingByHash.get(hash);
      const sourceEventIds = item.sourceEventIds.filter((id) => validEventIds.has(id));
      // A hallucinated or stale label simply isn't in the map — dropped
      // silently here, never trusted, same posture as sourceEventIds'
      // validEventIds filter above. citableEventId is checked too: a
      // context_document chunk's citation is never persisted, since
      // task_sources.normalized_event_id is NOT NULL (see match_search_chunks'
      // own doc comment).
      const citedChunks = (item.relatedContextRefs ?? [])
        .map((label) => chunksByLabel.get(label))
        .filter((c): c is RelatedContextChunk => c !== undefined && c.citableEventId !== null);

      if (existingId) {
        await service
          .from("tasks")
          .update({
            description: item.description ?? null,
            priority: item.priority,
            confidence: item.confidence,
            owner_hint: item.ownerHint ?? null,
            llm_run_id: run.id,
            generated_at: new Date().toISOString(),
          })
          .eq("id", existingId);
        itemsMerged += 1;
        sourceLinks.push(
          ...sourceEventIds.map((eventId) => ({
            task_id: existingId,
            normalized_event_id: eventId,
            client_space_id: clientSpaceId,
          })),
          ...citationSourceLinks(existingId, clientSpaceId, citedChunks),
        );
        continue;
      }

      const newId = uuidv7();
      const { error: insertError } = await service.from("tasks").insert({
        id: newId,
        workspace_id: clientSpace.workspace_id,
        client_space_id: clientSpaceId,
        // Always tagged to this client space's sole project (see this
        // function's doc comment) — not left null — so Task Management's
        // per-project filter keeps finding these items unchanged.
        project_id: project.id,
        llm_run_id: run.id,
        kind: item.kind,
        title: item.title,
        description: item.description ?? null,
        priority: item.priority,
        confidence: item.confidence,
        owner_hint: item.ownerHint ?? null,
        dedupe_hash: hash,
        for_date: date,
      });

      if (insertError) {
        // tasks_open_dedupe_uniq (client_space_id, dedupe_hash)
        // rejected this insert — another row with the same hash exists that
        // our existingByHash snapshot didn't know about (a genuine
        // concurrent writer, since same-run duplicates are already caught by
        // the existingByHash check above). Fall through to updating that row
        // instead of silently losing this item.
        if (insertError.code !== "23505") throw new Error(`tasks insert failed: ${insertError.message}`);
        const { data: conflictRow } = await service
          .from("tasks")
          .select("id")
          .eq("client_space_id", clientSpaceId)
          .eq("dedupe_hash", hash)
          .in("status", ["pending", "in_progress"])
          .maybeSingle();
        if (!conflictRow) throw new Error(`tasks insert failed: ${insertError.message}`);
        await service
          .from("tasks")
          .update({
            description: item.description ?? null,
            priority: item.priority,
            confidence: item.confidence,
            owner_hint: item.ownerHint ?? null,
            llm_run_id: run.id,
            generated_at: new Date().toISOString(),
          })
          .eq("id", conflictRow.id);
        existingByHash.set(hash, conflictRow.id);
        itemsMerged += 1;
        sourceLinks.push(
          ...sourceEventIds.map((eventId) => ({
            task_id: conflictRow.id,
            normalized_event_id: eventId,
            client_space_id: clientSpaceId,
          })),
          ...citationSourceLinks(conflictRow.id, clientSpaceId, citedChunks),
        );
        continue;
      }

      existingByHash.set(hash, newId);
      itemsCreated += 1;
      sourceLinks.push(
        ...sourceEventIds.map((eventId) => ({
          task_id: newId,
          normalized_event_id: eventId,
          client_space_id: clientSpaceId,
        })),
        ...citationSourceLinks(newId, clientSpaceId, citedChunks),
      );
    }

    if (sourceLinks.length > 0) {
      // (task_id, normalized_event_id) is the primary key — a
      // redelivered/rerun job citing the same event again is a harmless
      // no-op, not a duplicate-key error, as long as we ignore conflicts.
      await service.from("task_sources").upsert(sourceLinks, {
        onConflict: "task_id,normalized_event_id",
        ignoreDuplicates: true,
      });
    }

    // Mark every event this run looked at as processed, whether or not it
    // produced an item — otherwise the next run re-sends it to the model
    // forever and never converges on "nothing new".
    const nowIso = new Date().toISOString();
    await service.from("normalized_events").update({ processed_at: nowIso }).in("id", eventIds);

    const usage = sumUsage(usages);
    // Priced PER CALL, then summed as dollars — never on the aggregated
    // usage above. gpt-5.6-luna re-rates a WHOLE request once its total
    // input exceeds 272K tokens; summing several ordinary-sized chunks
    // first and pricing the total once would wrongly bill everything at
    // the long-context rate the moment the sum crosses that threshold, even
    // though no single call actually reasoned over that much text. A null
    // from any call (unknown model) propagates rather than being silently
    // treated as $0 — see estimateCostUsd's own doc comment.
    const perCallCosts = usages.map((u) => estimateCostUsd(u, provider.model));
    const costUsd = perCallCosts.some((c) => c === null) ? null : perCallCosts.reduce((sum, c) => sum! + c!, 0);
    await service
      .from("llm_runs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        prompt: {
          extractionChunks: extractionChunksLog.map((c) => c.prompt),
          consolidation: consolidationPromptLog,
        } as Database["public"]["Tables"]["llm_runs"]["Update"]["prompt"],
        response: {
          extractionChunks: extractionChunksLog.map((c) => c.response),
          consolidation: consolidationResponseLog,
        } as Database["public"]["Tables"]["llm_runs"]["Update"]["response"],
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        cache_read_tokens: usage.cacheReadTokens,
        cache_creation_tokens: usage.cacheCreationTokens,
        cost_usd: costUsd,
      })
      .eq("id", run.id);

    return { status: "succeeded", itemsCreated, itemsMerged };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await service
      .from("llm_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message })
      .eq("id", run.id);
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: message };
  }
}
