import "server-only";
import { chunkPages, chunkText, contentHash } from "./chunk";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;
type SearchChunkInsert = Database["public"]["Tables"]["search_chunks"]["Insert"];

// PostgREST body-size / Kong URL-length ceiling, same rationale as
// run-sync.ts's own RAW_INSERT_CHUNK_SIZE — well under config.toml's
// [api] max_rows = 1000.
const CHUNK_INSERT_BATCH_SIZE = 100;

export interface ChunkSourceInput {
  clientSpaceId: string;
  projectId: string | null;
  sourceKind: Database["public"]["Enums"]["chunk_source"];
  sourceId: string;
  provider: Database["public"]["Enums"]["connector_provider"] | null;
  occurredAt: string;
  title?: string | null;
  /** The click-through target, when the source has one — normalized_events'
   * own resource_url, or the parent event's for an attachment chunk. Feeds
   * search_chunks.source_url, otherwise unused. */
  sourceUrl?: string | null;
  text: string;
  /** Present only for a paginated source (a parsed PDF attachment) — see
   * parseAttachmentText's own `pages` field. When set, chunking goes through
   * chunkPages instead of chunkText so a chunk never straddles a page and
   * page_number is exact. `text` should still be the pages' joined content
   * (kept for source_kind/callers that don't care about pagination), but
   * chunking itself is driven entirely by `pages` when present. */
  pages?: { pageNumber: number; text: string }[];
}

/** Splits one source's text into chunk rows, ready for upsert. Exported
 * separately from insertChunksForSource(s) so chunk_index density,
 * content_hash uniqueness, and field pass-through can be unit-tested
 * without a database. Async because chunking now goes through LangChain's
 * RecursiveCharacterTextSplitter. */
export async function buildChunkRows(input: ChunkSourceInput): Promise<SearchChunkInsert[]> {
  const pieces = input.pages
    ? await chunkPages(input.pages)
    : (await chunkText(input.text)).map((content) => ({ content, pageNumber: null as number | null }));

  return pieces.map(({ content, pageNumber }, index) => ({
    client_space_id: input.clientSpaceId,
    project_id: input.projectId,
    source_kind: input.sourceKind,
    source_id: input.sourceId,
    chunk_index: index,
    provider: input.provider,
    occurred_at: input.occurredAt,
    title: input.title ?? null,
    source_url: input.sourceUrl ?? null,
    content,
    content_hash: contentHash(content),
    page_number: pageNumber,
  }));
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Chunks and inserts search_chunks rows for MANY sources in one call,
 * batching the writes rather than issuing one upsert per source — a sync
 * run can land 100+ events at once, and this is what keeps that from
 * costing 100+ sequential PostgREST round trips inside the route's write
 * budget (see run-sync.ts's own FETCH_BUDGET_MS comment).
 *
 * Every source kind in this schema produces a brand-new row on change
 * rather than updating one in place (an edited Slack message is a new
 * normalized_event, a re-uploaded context document is a new context_documents
 * row — see their own migration comments), so `source_id` is never reused
 * for genuinely different content; this is a plain insert, not an
 * update-if-changed.
 *
 * Does NOT enqueue the embed job itself — callers batch several sources per
 * sync/extraction run and enqueue once at the end, not once per source.
 * Returns the total number of chunks inserted across every input (0 for a
 * source whose text is empty/whitespace-only).
 */
export async function insertChunksForSources(service: ServiceClient, inputs: ChunkSourceInput[]): Promise<number> {
  const rowsPerInput = await Promise.all(inputs.map(buildChunkRows));
  const rows = rowsPerInput.flat();
  if (rows.length === 0) return 0;

  let inserted = 0;
  for (const batch of chunkArray(rows, CHUNK_INSERT_BATCH_SIZE)) {
    // ignoreDuplicates, not an update: at-least-once job delivery could
    // re-process the same source, but since a genuinely changed source
    // always gets a new id (see doc comment above), a conflict here can
    // only mean "already chunked this exact source" — silently skip rather
    // than overwrite (which would also wrongly reset an already-embedded
    // row back to a state it never fell out of).
    const { error } = await service
      .from("search_chunks")
      .upsert(batch, { onConflict: "source_kind,source_id,chunk_index", ignoreDuplicates: true });
    if (error) {
      console.error(`[search] failed to insert a batch of ${batch.length} chunk row(s):`, error);
      continue;
    }
    inserted += batch.length;
  }
  return inserted;
}

/** Single-source convenience wrapper, for call sites (run-extraction.ts's
 * per-attachment loop) that only ever have one source at a time. */
export async function insertChunksForSource(service: ServiceClient, input: ChunkSourceInput): Promise<number> {
  return insertChunksForSources(service, [input]);
}
