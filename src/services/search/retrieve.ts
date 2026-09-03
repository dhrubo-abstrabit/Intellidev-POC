import "server-only";
import { embedOne, toVectorLiteral, EMBEDDING_MODEL } from "./embed";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface RetrievedChunk {
  chunkId: string;
  sourceKind: Database["public"]["Enums"]["chunk_source"];
  sourceId: string;
  provider: Database["public"]["Enums"]["connector_provider"] | null;
  title: string | null;
  content: string;
  occurredAt: string;
  sourceUrl: string | null;
  /** Resolved server-side by match_search_chunks — see that RPC's own doc
   * comment in the migration for the per-source-kind resolution rule. */
  citableEventId: string | null;
  /** Which page of a paginated source (a PDF) this chunk came from — see
   * search_chunks.page_number's own column comment. Null for every
   * non-paginated source. */
  pageNumber: number | null;
  distance: number;
}

export interface RetrieveOptions {
  clientSpaceId: string;
  projectId?: string | null;
  /** Free text to embed and search with — a digest of some activity, a
   * draft title, whatever the caller decides is the query. Generic on
   * purpose: this module has no opinion on what "the query" should be for
   * any particular consumer — see services/action-items/related-context.ts
   * for the action-items-specific multi-query construction built on top of
   * this single-query primitive. */
  queryText: string;
  limit?: number;
  maxDistance?: number;
  /** search_chunks.source_id values to exclude — e.g. today's own event/
   * attachment ids, so retrieval never hands back text already present
   * verbatim elsewhere in the caller's prompt. */
  excludeSourceIds?: string[];
  onePerSource?: boolean;
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  /** Tokens spent embedding the QUERY (not the corpus) — typically tiny
   * (a few dozen to a few hundred tokens). A js-tiktoken ESTIMATE, not the
   * provider's billed usage (see embed.ts's EmbedResult.estimatedPromptTokens
   * for why). Callers that want exact metering can fold this into their own
   * llm_runs usage; it is not logged anywhere on its own. */
  estimatedPromptTokens: number;
}

/**
 * Embeds `queryText` and calls match_search_chunks once. NEVER throws —
 * retrieval is an ENRICHMENT of whatever prompt the caller is building, not
 * a dependency it can fail on; on any failure (OpenAI down, RPC error) this
 * logs and returns an empty result so the caller proceeds without it. See
 * the call site in services/action-items/generate.ts for why that posture
 * matters here specifically.
 */
export async function retrieveContextChunks(service: ServiceClient, opts: RetrieveOptions): Promise<RetrieveResult> {
  try {
    const { embedding, estimatedPromptTokens } = await embedOne(opts.queryText);

    const { data, error } = await service.rpc("match_search_chunks", {
      p_client_space_id: opts.clientSpaceId,
      p_embedding: toVectorLiteral(embedding),
      p_project_id: opts.projectId ?? undefined,
      p_limit: opts.limit,
      p_max_distance: opts.maxDistance,
      p_embedding_model: EMBEDDING_MODEL,
      p_exclude_source_ids: opts.excludeSourceIds,
      p_one_per_source: opts.onePerSource,
    });
    if (error) {
      console.error(`[search] match_search_chunks failed for client space ${opts.clientSpaceId}:`, error);
      return { chunks: [], estimatedPromptTokens };
    }

    const chunks: RetrievedChunk[] = (data ?? []).map((row) => ({
      chunkId: row.chunk_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      provider: row.provider ?? null,
      title: row.title ?? null,
      content: row.content,
      occurredAt: row.occurred_at,
      sourceUrl: row.source_url ?? null,
      citableEventId: row.citable_event_id ?? null,
      pageNumber: row.page_number ?? null,
      distance: row.distance,
    }));
    return { chunks, estimatedPromptTokens };
  } catch (err) {
    console.error(`[search] retrieveContextChunks failed for client space ${opts.clientSpaceId}:`, err);
    return { chunks: [], estimatedPromptTokens: 0 };
  }
}
