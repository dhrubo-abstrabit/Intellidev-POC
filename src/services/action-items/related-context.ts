import "server-only";
import { retrieveContextChunks, type RetrievedChunk } from "@/services/search/retrieve";
import type { createServiceClient } from "@/lib/supabase/service";
import type { NewEventSummary, RelatedContextChunk } from "@/lib/llm/types";

type ServiceClient = ReturnType<typeof createServiceClient>;

// Groups the day's events into at most this many query texts (by event
// type, overflow merged into one group) — NOT one query per event (too many
// round trips within the route's budget) and NOT one query over everything
// (a mean-pooled vector over 200 heterogeneous items is a centroid of
// everything, semantically mushy — structurally the same failure shape as
// the gte-small incident this project already had once, just arriving via
// averaging instead of a weak model).
const RETRIEVAL_MAX_QUERIES = 6;
// Per-group query text budget — newest-first, so the most recent activity
// in a group anchors its query text.
const MAX_QUERY_CHARS = 4_000;
// A group whose assembled text is under this has nothing to search on.
const MIN_QUERY_CHARS = 40;
// Over-fetched per query; final selection is capped by RETRIEVAL_MAX_CHUNKS
// below after merging every group's results.
const RETRIEVAL_PER_QUERY_LIMIT = 16;
const RETRIEVAL_MAX_CHUNKS = 12;
const RETRIEVAL_MAX_CONTENT_CHARS = 12_000;
// UNVALIDATED — a starting hypothesis, not a tuned constant (no real
// production distances exist yet). Ships loose deliberately: every
// retrieved chunk's distance is carried through to llm_runs.prompt (see
// generate.ts), and after ~1-2 weeks of real data this should be
// recalibrated from the actual distribution rather than left as a guess in
// either direction. Blast radius of being wrong is bounded — see the
// Citations section in the design notes: a bad match only ever costs
// prompt tokens, it cannot corrupt a task, since retrieved chunks carry no
// ids the model could cite as a NEW EVENT source.
const RETRIEVAL_MAX_DISTANCE = 0.65;

export interface FetchRelatedContextArgs {
  clientSpaceId: string;
  projectId: string;
  events: NewEventSummary[];
  /** Today's own normalized_event ids — excluded so retrieval never hands
   * back an event that's already in NEW EVENTS verbatim. */
  excludeSourceIds: string[];
  /** Today's own event_attachment ids — a SEPARATE id space from
   * excludeSourceIds (search_chunks.source_id for an event_attachment-kind
   * chunk is the attachment's own id, not its parent event's), so both
   * lists are required to fully exclude today's own activity. */
  excludeAttachmentIds: string[];
}

/** Pure — no I/O. Groups events by type into up to RETRIEVAL_MAX_QUERIES
 * query texts, newest-first within each group. Attachment text is
 * deliberately EXCLUDED from query construction: a single 40K-char PDF
 * would dominate a mean-pooled query vector and swamp the conversational
 * signal the query is supposed to represent alongside it. Exported for
 * unit testing. */
export function buildQueryTexts(events: NewEventSummary[]): string[] {
  if (events.length === 0) return [];

  const byType = new Map<string, NewEventSummary[]>();
  for (const event of events) {
    const list = byType.get(event.type) ?? [];
    list.push(event);
    byType.set(event.type, list);
  }

  let groups = [...byType.values()];
  if (groups.length > RETRIEVAL_MAX_QUERIES) {
    // Merge the smallest groups into one "other" group until we're at the
    // cap — keeps the largest (most represented) event types as their own,
    // more homogeneous query.
    groups.sort((a, b) => a.length - b.length);
    const keepCount = RETRIEVAL_MAX_QUERIES - 1;
    const overflow = groups.slice(0, groups.length - keepCount).flat();
    const kept = groups.slice(groups.length - keepCount);
    groups = [...kept, overflow];
  }

  const texts: string[] = [];
  for (const group of groups) {
    const newestFirst = [...group].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    let text = "";
    for (const event of newestFirst) {
      const piece = [event.title, event.body?.slice(0, 400)].filter(Boolean).join(" — ");
      if (!piece) continue;
      const candidate = text ? `${text}\n${piece}` : piece;
      if (candidate.length > MAX_QUERY_CHARS) break;
      text = candidate;
    }
    if (text.trim().length >= MIN_QUERY_CHARS) texts.push(text);
  }
  return texts;
}

/**
 * Groups the day's new events into a handful of query texts, retrieves
 * semantically related historical chunks for each in parallel, merges and
 * trims the results, and assigns each surviving chunk a stable per-run
 * citation label ("R1", "R2", ...). NEVER throws — retrieveContextChunks
 * itself never throws, and this function adds no I/O that could; the
 * caller (generate.ts's loadContext) still wraps the call in try/catch as
 * the one visible boundary where "retrieval must never fail extraction" is
 * enforced, per this codebase's existing convention for enrichment steps
 * that must not be load-bearing.
 */
export async function fetchRelatedContext(service: ServiceClient, args: FetchRelatedContextArgs): Promise<RelatedContextChunk[]> {
  const queryTexts = buildQueryTexts(args.events);
  if (queryTexts.length === 0) return [];

  const excludeSourceIds = [...args.excludeSourceIds, ...args.excludeAttachmentIds];
  const results = await Promise.all(
    queryTexts.map((queryText) =>
      retrieveContextChunks(service, {
        clientSpaceId: args.clientSpaceId,
        projectId: args.projectId,
        queryText,
        limit: RETRIEVAL_PER_QUERY_LIMIT,
        maxDistance: RETRIEVAL_MAX_DISTANCE,
        excludeSourceIds,
        onePerSource: true,
      }),
    ),
  );

  // A chunk can appear in more than one group's results (its content might
  // be similar to several event types); dedupe by chunkId keeping the
  // closest match across all queries.
  const byChunkId = new Map<string, RetrievedChunk>();
  for (const result of results) {
    for (const chunk of result.chunks) {
      const existing = byChunkId.get(chunk.chunkId);
      if (!existing || chunk.distance < existing.distance) byChunkId.set(chunk.chunkId, chunk);
    }
  }
  const merged = [...byChunkId.values()].sort((a, b) => a.distance - b.distance);

  // Best-effort packing, not a hard cutoff at the first chunk that doesn't
  // fit: a smaller, slightly-less-relevant chunk further down the list can
  // still fit the remaining budget even after a larger one didn't. Matches
  // renderNewEvents' existing "no silent caps" convention — drop whole
  // chunks over budget, never truncate one mid-content.
  const trimmed: RetrievedChunk[] = [];
  let cumulativeChars = 0;
  for (const chunk of merged) {
    if (trimmed.length >= RETRIEVAL_MAX_CHUNKS) break;
    if (cumulativeChars + chunk.content.length > RETRIEVAL_MAX_CONTENT_CHARS) continue;
    trimmed.push(chunk);
    cumulativeChars += chunk.content.length;
  }

  return trimmed.map((chunk, index) => ({
    label: `R${index + 1}`,
    chunkId: chunk.chunkId,
    sourceKind: chunk.sourceKind,
    title: chunk.title,
    content: chunk.content,
    occurredAt: chunk.occurredAt,
    citableEventId: chunk.citableEventId,
    distance: chunk.distance,
  }));
}
