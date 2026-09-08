import "server-only";
import { retrieveContextChunks, type RetrievedChunk } from "@/services/search/retrieve";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

// A handful of candidates is plenty for a human to scan in a dialog — this
// is a review surface, not a prompt budget, so there's no reason to over-
// fetch the way related-context.ts's RETRIEVAL_PER_QUERY_LIMIT does.
const FIND_RELATED_LIMIT = 8;
// Same starting hypothesis as related-context.ts's RETRIEVAL_MAX_DISTANCE —
// see that constant's own comment. Kept as a separate constant (not
// imported) because a PM reviewing candidates by eye and a token-budgeted
// prompt are different consumers that may need to diverge in calibration.
const FIND_RELATED_MAX_DISTANCE = 0.55;
// Same rationale as related-context.ts's MAX_QUERY_CHARS — task.description
// is already bounded to 2000 chars by schema.ts's ActionItemDraftSchema, so
// this is a safety net, not an expected truncation.
const MAX_QUERY_CHARS = 4_000;

export interface RelatedCandidate {
  chunkId: string;
  /** Always non-null — see the citableEventId filter in findRelatedForTask
   * below. This is what a PM's "Link" action writes to
   * task_sources.normalized_event_id. */
  normalizedEventId: string;
  sourceKind: Database["public"]["Enums"]["chunk_source"];
  title: string | null;
  snippet: string;
  occurredAt: string;
  distance: number;
  pageNumber: number | null;
}

export interface FindRelatedForTaskArgs {
  clientSpaceId: string;
  projectId: string;
  queryText: string;
  /** normalized_event ids already linked to this task via task_sources
   * (every role, not just PM-added ones) — a candidate must never duplicate
   * an existing Source row. */
  excludeNormalizedEventIds: string[];
}

/** Pure — no I/O. Mirrors related-context.ts's buildQueryTexts in spirit,
 * but for a single task rather than a day's events: there's no query-
 * splitting to do (one task, one query), just a title+description
 * concatenation capped to a sane budget. */
export function buildTaskQueryText(task: { title: string; description: string | null }): string {
  const body = task.description?.slice(0, MAX_QUERY_CHARS) ?? "";
  return body ? `${task.title}\n${body}` : task.title;
}

/**
 * Pure — no I/O. Filters out two categories the PM must never be shown,
 * both needed because they cover DIFFERENT id spaces (see
 * excludeSourceIds' own doc comment on RetrieveOptions in
 * services/search/retrieve.ts):
 *   - already-linked events: retrieveContextChunks' own excludeSourceIds
 *     kills normalized_event-kind chunks (whose source_id IS the event id)
 *     before this function ever sees them, but NOT event_attachment-kind
 *     chunks (whose source_id is the attachment's own id, not its parent
 *     event's) — this is what catches those.
 *   - uncitable chunks (citableEventId === null, i.e. context_document
 *     chunks): task_sources.normalized_event_id is NOT NULL, so these can
 *     never be linked — showing a "Link" button that can't work would be a
 *     dead end.
 * Both counts are logged, not silently dropped, per this codebase's "no
 * silent caps" convention. Exported for unit testing, mirroring
 * related-context.ts's buildQueryTexts.
 */
export function filterAndMapCandidates(chunks: RetrievedChunk[], excludeNormalizedEventIds: string[]): RelatedCandidate[] {
  const alreadyLinked = new Set(excludeNormalizedEventIds);
  let droppedAlreadyLinked = 0;
  let droppedUncitable = 0;

  const candidates = chunks.filter((chunk) => {
    if (chunk.citableEventId === null) {
      droppedUncitable += 1;
      return false;
    }
    if (alreadyLinked.has(chunk.citableEventId)) {
      droppedAlreadyLinked += 1;
      return false;
    }
    return true;
  });

  if (droppedAlreadyLinked > 0 || droppedUncitable > 0) {
    console.warn(
      `[tasks] findRelatedForTask: dropped ${droppedAlreadyLinked} already-linked and ${droppedUncitable} uncitable candidate(s)`,
    );
  }

  return candidates.map((chunk) => ({
    chunkId: chunk.chunkId,
    normalizedEventId: chunk.citableEventId!,
    sourceKind: chunk.sourceKind,
    title: chunk.title,
    snippet: chunk.content,
    occurredAt: chunk.occurredAt,
    distance: chunk.distance,
    pageNumber: chunk.pageNumber,
  }));
}

/**
 * Live, on-demand retrieval for the Task Tracking "Find related" action —
 * the human-in-the-loop replacement for the model's old auto-citation
 * channel (see PROMPT_VERSION's "v5" note in lib/llm/prompt.ts). NEVER
 * throws — retrieveContextChunks itself never throws; this function adds no
 * I/O that could.
 */
export async function findRelatedForTask(service: ServiceClient, args: FindRelatedForTaskArgs): Promise<RelatedCandidate[]> {
  const { chunks } = await retrieveContextChunks(service, {
    clientSpaceId: args.clientSpaceId,
    projectId: args.projectId,
    queryText: args.queryText,
    limit: FIND_RELATED_LIMIT,
    maxDistance: FIND_RELATED_MAX_DISTANCE,
    excludeSourceIds: args.excludeNormalizedEventIds,
    onePerSource: true,
  });

  return filterAndMapCandidates(chunks, args.excludeNormalizedEventIds);
}
