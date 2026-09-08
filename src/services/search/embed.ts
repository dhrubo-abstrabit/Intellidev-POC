import "server-only";
import { AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError } from "openai";
import { getEmbeddingsClient, countEmbeddingTokens } from "@/lib/llm/embeddings";
import { enqueueJob } from "@/lib/queue";
import { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/database.types";

// Composite value — encodes the DIMENSION as well as the model name.
// search_chunks.embedding_model exists so a model swap doesn't silently
// make old vectors incomparable to new ones (see that column's own
// comment); a dimension change is exactly as incomparable as a model
// change, and "text-embedding-3-small" alone wouldn't distinguish a
// hypothetical future re-embed at a different dimension from this one.
export const EMBEDDING_MODEL = "text-embedding-3-small@1024";
const OPENAI_EMBEDDING_MODEL_ID = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1024;
const EMBEDDING_COST_PER_MTOK = 0.02; // verified 2026-09-01

// Rows drained per job invocation.
const CHUNKS_PER_RUN = 100;
// OpenAI's real per-request caps are 2048 inputs / 300,000 total tokens /
// 8192 tokens per single input — our chunks are ~1000 chars (~250 tokens
// est.), so the input-COUNT cap binds first at any sane batch size; both
// are still enforced defensively since a future caller (e.g. larger
// context_document chunks) might not stay this small. Also matches
// lib/llm/embeddings.ts's OpenAIEmbeddings batchSize, so LangChain's own
// internal batching never subdivides one of these batches into several
// HTTP requests we couldn't attribute a failure back to.
const MAX_INPUTS_PER_REQUEST = 128;
const MAX_EST_TOKENS_PER_REQUEST = 100_000;
const MAX_INPUT_BYTES = 24_000; // ~6k tokens; provider's real cap is 8192 tokens
// A chunk stops being retried once its embed_attempts reaches this — mirrors
// sync_jobs' max_attempts shape without exponential backoff between runs;
// the next opportunistic trigger (a later sync/extraction) is the retry.
const MAX_EMBED_ATTEMPTS = 5;
// Mirrors run-sync.ts's MAX_SYNC_CHAIN_DEPTH / run-extraction.ts's
// MAX_ATTACHMENT_CHAIN_DEPTH: a backlog that never drains must not fan out
// indefinitely within one trigger's chain.
const MAX_EMBED_CHAIN_DEPTH = 5;
// In-run retries for TRANSIENT failures only (rate limit without a quota
// error, 5xx, network) — bounded so total in-run retry sleep (worst case
// MAX_PROVIDER_RETRIES * 4s ≈ 12s per batch) stays well inside the job
// route's 60s budget. Input and auth/quota errors never reach this path —
// see the taxonomy below.
const MAX_PROVIDER_RETRIES = 3;

/** Data problem: a malformed/oversize input, or the provider rejected the
 * request shape (400). Terminal — no retry, no embed_attempts burn. */
export class EmbedInputError extends Error {}

/** Config/capacity problem, not a data problem: bad or unauthorized API
 * key, or the account is out of quota. Must abort the WHOLE run rather
 * than burn through embed_attempts on every pending row — a bad key must
 * not permanently mark thousands of unrelated rows 'failed'. */
export class EmbedAuthError extends Error {}

/** pgvector's own text input/output format — the generated types have every
 * `vector` column as `string` (see database.types.ts), not `number[]`,
 * because that's genuinely what PostgREST expects over the wire. Exported
 * for retrieve.ts's query-embedding call. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Generous character-level estimate, not a real tokenizer — ceil(bytes/4)
 * with a 20% safety margin. Only used to decide request BATCHING against
 * OpenAI's total-tokens-per-request cap; deliberately NOT the tiktoken-based
 * countEmbeddingTokens (lib/llm/embeddings.ts) used for the reported/logged
 * count below — this stays a cheap synchronous heuristic so the unit suite
 * doesn't pay tokenizer construction cost just to test batching. */
function estimateTokens(text: string): number {
  return Math.ceil((Buffer.byteLength(text, "utf8") / 4) * 1.2);
}

interface EmbedBatch {
  texts: string[];
  /** Original index into the input array passed to embedTexts, so results
   * can be re-keyed correctly regardless of provider response ordering. */
  indices: number[];
}

/** Pure — no I/O. Groups texts into request-sized batches against OpenAI's
 * real per-request limits, using conservative internal ceilings well under
 * all of them. A single text over MAX_INPUT_BYTES is a caller bug, not a
 * batching decision — throws EmbedInputError rather than silently
 * splitting or dropping it. Exported for unit testing. */
export function planEmbedRequests(texts: string[]): EmbedBatch[] {
  const batches: EmbedBatch[] = [];
  let current: EmbedBatch = { texts: [], indices: [] };
  let currentTokens = 0;

  texts.forEach((text, index) => {
    if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) {
      throw new EmbedInputError(`text at index ${index} exceeds the ${MAX_INPUT_BYTES}-byte per-input limit`);
    }
    const tokens = estimateTokens(text);
    const wouldOverflow = current.texts.length >= MAX_INPUTS_PER_REQUEST || currentTokens + tokens > MAX_EST_TOKENS_PER_REQUEST;
    if (wouldOverflow && current.texts.length > 0) {
      batches.push(current);
      current = { texts: [], indices: [] };
      currentTokens = 0;
    }
    current.texts.push(text);
    current.indices.push(index);
    currentTokens += tokens;
  });
  if (current.texts.length > 0) batches.push(current);
  return batches;
}

export type EmbedErrorClass = "input" | "auth" | "transient";

/**
 * Detects an insufficient-quota rate limit both through the real OpenAI SDK
 * error shape AND structurally (duck-typed), because @langchain/openai's
 * error wrapping only MUTATES a RateLimitError in place (verified against
 * its source: coerceError returns the same object when it's already an
 * Error, then sets .name = "InsufficientQuotaError") — so the instanceof
 * check below still works on its own in practice, but the structural
 * fallback protects against a future LangChain version constructing a new
 * plain object instead, the way it already does for context-overflow (see
 * classifyEmbedError below).
 */
function isQuotaRateLimit(err: unknown): boolean {
  if (err instanceof RateLimitError) {
    // err.error's shape is provider-defined, not typed precisely by the SDK
    // (APIError<429, Headers> leaves TError as the generic Object default) —
    // read defensively rather than asserting a shape OpenAI hasn't committed to.
    const nestedCode = (err.error as { error?: { code?: string } } | undefined)?.error?.code;
    return err.code === "insufficient_quota" || nestedCode === "insufficient_quota";
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; status?: unknown; code?: unknown; error?: { code?: unknown; error?: { code?: unknown } } };
    if (e.name === "InsufficientQuotaError") return true;
    if (e.status === 429 && (e.code === "insufficient_quota" || e.error?.code === "insufficient_quota" || e.error?.error?.code === "insufficient_quota")) {
      return true;
    }
  }
  return false;
}

/**
 * Pure classification — no retry, no I/O. Exported for direct unit testing
 * of the taxonomy without needing to trigger real network errors.
 *
 * Structural (duck-typed) checks sit alongside the `instanceof` ones because
 * @langchain/openai's embedDocuments() runs every call through
 * wrapOpenAIClientError, which for 400/401/403/404/429 MUTATES the original
 * SDK error object in place (instanceof survives) but for a context-length-
 * exceeded 400 constructs a brand-new ContextOverflowError with no SDK
 * class at all (verified against the installed @langchain/openai source) —
 * without the structural check, that case would silently fall through to
 * "transient" (3 retries, then 5 embed_attempts burned) instead of "input"
 * (terminal, no attempt burn) — plausible in practice since our own
 * MAX_INPUT_BYTES guard in planEmbedRequests is a byte estimate, not an
 * exact token count, and can under-catch a genuinely oversize input.
 *
 * "input" -> terminal, per-row, no attempt burn (HTTP 400, or the wrapped
 * ContextOverflowError equivalent). "auth" -> terminal, WHOLE-RUN abort, no
 * attempt burn (401/403, or 429 with insufficient_quota — a capacity
 * problem, not a data problem). "transient" -> everything else (plain rate
 * limit, 5xx, network, LangChain's TimeoutError/AbortError wrappers) —
 * eligible for the in-run retry in classifyAndRetry below, then a per-row
 * attempt-count increment if retries are exhausted.
 */
export function classifyEmbedError(err: unknown): EmbedErrorClass {
  if (err instanceof BadRequestError) return "input";
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return "auth";
  if (isQuotaRateLimit(err)) return "auth";

  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; status?: unknown };
    if (e.name === "ContextOverflowError") return "input";
    if (e.status === 401 || e.status === 403) return "auth";
  }

  return "transient";
}

/** Runs classifyEmbedError on every failure and, for genuinely transient
 * ones only, retries in-run with backoff (honoring Retry-After when the
 * provider sends one). Input and auth/quota errors are re-thrown as their
 * typed equivalents immediately — never retried, since retrying a 400 or
 * an invalid key wastes the route's time budget without ever succeeding. */
async function classifyAndRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const errorClass = classifyEmbedError(err);
      if (errorClass === "input") throw new EmbedInputError(err instanceof Error ? err.message : String(err));
      if (errorClass === "auth") throw new EmbedAuthError(err instanceof Error ? err.message : String(err));

      lastErr = err;
      if (attempt >= MAX_PROVIDER_RETRIES) break;
      // Duck-typed rather than `err instanceof APIError`: a genuine SDK
      // error mutated in place by @langchain/openai still has its original
      // `.headers`, but a wrapped TimeoutError/AbortError/ContextOverflowError
      // is a plain object with none — this reads whichever shape is present
      // instead of assuming the SDK class survived.
      const retryAfterHeader = (err as { headers?: { get?: (name: string) => string | null } } | null | undefined)?.headers?.get?.(
        "retry-after",
      );
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs ? retryAfterMs : Math.min(500 * 2 ** attempt, 4000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs + Math.random() * 200));
    }
  }
  throw lastErr;
}

export interface EmbedResult {
  embeddings: number[][];
  /** A js-tiktoken estimate, NOT the provider's billed usage.prompt_tokens
   * — @langchain/openai's embedDocuments()/embedQuery() never surface real
   * usage data (see lib/llm/embeddings.ts's countEmbeddingTokens doc
   * comment). Named accordingly so this can't be mistaken for a metered
   * figure at any call site. */
  estimatedPromptTokens: number;
}

/** Embeds a batch of texts via LangChain's OpenAIEmbeddings, at
 * EMBEDDING_DIMENSIONS. Throws EmbedInputError / EmbedAuthError per the
 * taxonomy above, or the last transient error if retries are exhausted. */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], estimatedPromptTokens: 0 };
  const client = getEmbeddingsClient(OPENAI_EMBEDDING_MODEL_ID, EMBEDDING_DIMENSIONS);
  const batches = planEmbedRequests(texts);

  const embeddings: number[][] = new Array(texts.length);
  let estimatedPromptTokens = 0;

  for (const batch of batches) {
    // embedDocuments() reads results BY ARRAY POSITION — unlike the raw
    // OpenAI SDK's response.data[i].index, LangChain discards any
    // response-order info the provider might return. This re-keys from
    // request position to the original embedTexts() input position
    // (batch.indices), which is the only re-keying still available; if the
    // provider ever returned embeddings out of request order, they would
    // now attach to the wrong text silently. Capping every call at
    // MAX_INPUTS_PER_REQUEST narrows that window; it does not close it.
    const batchEmbeddings = await classifyAndRetry(() => client.embedDocuments(batch.texts));
    batchEmbeddings.forEach((embedding, i) => {
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`embedding at batch position ${i} has ${embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
      embeddings[batch.indices[i]] = embedding;
    });
    for (const text of batch.texts) {
      estimatedPromptTokens += await countEmbeddingTokens(text);
    }
  }
  return { embeddings, estimatedPromptTokens };
}

/** Single-text convenience wrapper — retrieve.ts's query embedding. Routed
 * through embedTexts rather than OpenAIEmbeddings' own embedQuery(), which
 * would be a second, unvalidated code path with none of the dimension
 * checking or error taxonomy above. */
export async function embedOne(text: string): Promise<{ embedding: number[]; estimatedPromptTokens: number }> {
  const { embeddings, estimatedPromptTokens } = await embedTexts([text]);
  return { embedding: embeddings[0], estimatedPromptTokens };
}

function estimateCostUsd(promptTokens: number): number {
  return Math.round((promptTokens / 1_000_000) * EMBEDDING_COST_PER_MTOK * 1_000_000) / 1_000_000;
}

export interface RunEmbeddingResult {
  status: "succeeded" | "failed" | "skipped";
  embedded: number;
  skipped: number;
  hasMore: boolean;
  error?: string;
}

type PendingChunkRow = Pick<Database["public"]["Tables"]["search_chunks"]["Row"], "id" | "content" | "embed_attempts">;

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Drains up to CHUNKS_PER_RUN pending search_chunks rows for one client
 * space, embeds them via embedTexts, and writes the vectors back. Chains
 * itself (mirroring run-sync.ts/run-extraction.ts) when the backlog
 * doesn't drain in one run.
 *
 * Logs one llm_runs row per invocation (kind='embed') with an ESTIMATED
 * prompt_tokens/cost_usd — unlike the raw OpenAI SDK this used to call
 * directly, LangChain's OpenAIEmbeddings never surfaces the provider's own
 * usage figures, so both are now a js-tiktoken count rather than a metered
 * one (see EmbedResult.estimatedPromptTokens and prompt_version below).
 */
export async function runEmbedding(clientSpaceId: string, chainDepth = 0): Promise<RunEmbeddingResult> {
  const service = createServiceClient();
  const startedAt = Date.now();

  const { data: clientSpace } = await service.from("client_spaces").select("tenant_id").eq("id", clientSpaceId).maybeSingle();
  if (!clientSpace) {
    return { status: "failed", embedded: 0, skipped: 0, hasMore: false, error: "Client space not found" };
  }

  const { data: pending, error: pendingError } = await service
    .from("search_chunks")
    .select("id, content, embed_attempts")
    .eq("client_space_id", clientSpaceId)
    .eq("embed_status", "pending")
    .lt("embed_attempts", MAX_EMBED_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(CHUNKS_PER_RUN);
  if (pendingError) {
    return { status: "failed", embedded: 0, skipped: 0, hasMore: false, error: pendingError.message };
  }
  if (!pending || pending.length === 0) {
    // Empty run is noise, not audit — return before writing an llm_runs row.
    return { status: "skipped", embedded: 0, skipped: 0, hasMore: false };
  }

  // Partition out rows too large for a single embeddings input BEFORE
  // calling the provider at all — terminal, not a retry candidate. Gives
  // embed_status's unused 'skipped' value an actual purpose.
  const oversize: PendingChunkRow[] = [];
  const embeddable: PendingChunkRow[] = [];
  for (const row of pending as PendingChunkRow[]) {
    if (Buffer.byteLength(row.content, "utf8") > MAX_INPUT_BYTES) oversize.push(row);
    else embeddable.push(row);
  }
  if (oversize.length > 0) {
    await service
      .from("search_chunks")
      .update({ embed_status: "skipped", embed_error: `content exceeds ${MAX_INPUT_BYTES}-byte per-input limit` })
      .in(
        "id",
        oversize.map((r) => r.id),
      )
      .eq("embed_status", "pending");
  }

  let embedded = 0;
  let promptTokensTotal = 0;
  let lastError: string | undefined;
  let aborted = false;

  for (const batch of chunkArray(embeddable, MAX_INPUTS_PER_REQUEST)) {
    if (aborted) break;
    try {
      const { embeddings, estimatedPromptTokens } = await embedTexts(batch.map((row) => row.content));
      promptTokensTotal += estimatedPromptTokens;
      const nowIso = new Date().toISOString();
      for (let i = 0; i < batch.length; i++) {
        // Compare-and-swap on embed_status: at-least-once job delivery means
        // this chunk could be mid-processing in a retried delivery
        // elsewhere — whichever write lands first wins.
        const { error } = await service
          .from("search_chunks")
          .update({
            embedding: toVectorLiteral(embeddings[i]),
            embedding_model: EMBEDDING_MODEL,
            embedded_at: nowIso,
            embed_status: "embedded",
            embed_error: null,
          })
          .eq("id", batch[i].id)
          .eq("embed_status", "pending");
        if (!error) embedded++;
      }
    } catch (err) {
      if (err instanceof EmbedAuthError) {
        // Config/capacity problem, not a data problem — abort the whole run
        // WITHOUT touching embed_attempts on any row. A bad key must not
        // walk the entire backlog to the attempt cap and permanently mark
        // thousands of rows failed.
        lastError = err.message;
        aborted = true;
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      const attemptCapReached = (row: PendingChunkRow) => row.embed_attempts + 1 >= MAX_EMBED_ATTEMPTS;
      for (const row of batch) {
        const attempts = row.embed_attempts + 1;
        await service
          .from("search_chunks")
          .update({
            // EmbedInputError is terminal too, but per-row (unlike
            // EmbedAuthError, which is whole-run) — no attempt cap needed,
            // it's marked failed on first occurrence.
            embed_status: err instanceof EmbedInputError || attemptCapReached(row) ? "failed" : "pending",
            embed_attempts: attempts,
            embed_error: message,
          })
          .eq("id", row.id)
          .eq("embed_status", "pending");
      }
    }
  }

  const { count: remainingCount } = await service
    .from("search_chunks")
    .select("id", { count: "exact", head: true })
    .eq("client_space_id", clientSpaceId)
    .eq("embed_status", "pending")
    .lt("embed_attempts", MAX_EMBED_ATTEMPTS);
  const hasMore = (remainingCount ?? 0) > 0;

  const runStatus: RunEmbeddingResult["status"] = aborted ? "failed" : embedded > 0 || !lastError ? "succeeded" : "failed";
  await service.from("llm_runs").insert({
    tenant_id: clientSpace.tenant_id,
    client_space_id: clientSpaceId,
    kind: "embed",
    status: runStatus,
    model: EMBEDDING_MODEL,
    provider: "openai",
    // Bumped from "embed-v1": prompt_tokens/cost_usd below are now a
    // js-tiktoken ESTIMATE, not the provider's billed usage — this value is
    // the only signal in the row itself that the figures changed meaning,
    // since the column names didn't.
    prompt_version: "embed-v2-tiktoken-est",
    prompt_tokens: promptTokensTotal,
    // completion/cache columns intentionally left null, not 0: an
    // embedding call has none of these, and 0 would misrepresent them as
    // measured rather than not-applicable.
    cost_usd: estimateCostUsd(promptTokensTotal),
    latency_ms: Date.now() - startedAt,
    error_message: lastError,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
  });

  if (!aborted && hasMore && chainDepth < MAX_EMBED_CHAIN_DEPTH) {
    await enqueueJob("/api/jobs/embed", { clientSpaceId, chainDepth: chainDepth + 1 }).catch((err) => {
      console.error(`[embed] failed to enqueue follow-up for client space ${clientSpaceId}:`, err);
    });
  } else if (!aborted && hasMore) {
    console.warn(
      `[embed] client space ${clientSpaceId} still has pending chunks after ${MAX_EMBED_CHAIN_DEPTH} chained runs — deferring to the next opportunistic trigger`,
    );
  }

  return { status: runStatus, embedded, skipped: oversize.length, hasMore, error: lastError };
}
