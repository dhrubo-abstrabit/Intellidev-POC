import "server-only";
import OpenAI, { AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError, APIError } from "openai";
import { embeddingEnv } from "@/lib/env";
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
// context_document chunks) might not stay this small.
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

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (client) return client;
  // maxRetries: 0 — this module implements its own bounded retry that
  // distinguishes terminal (input/auth) failures from transient ones (see
  // classifyAndRetry below); the SDK's built-in retry can't make that
  // distinction and would otherwise retry a 400 pointlessly.
  client = new OpenAI({ apiKey: embeddingEnv().OPENAI_API_KEY, maxRetries: 0, timeout: 30_000 });
  return client;
}

/** pgvector's own text input/output format — the generated types have every
 * `vector` column as `string` (see database.types.ts), not `number[]`,
 * because that's genuinely what PostgREST expects over the wire. Exported
 * for retrieve.ts's query-embedding call. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Generous character-level estimate, not a real tokenizer — ceil(bytes/4)
 * with a 20% safety margin. Only used to decide request BATCHING against
 * OpenAI's total-tokens-per-request cap; the actual billed token count
 * always comes from the API response's own usage.prompt_tokens. */
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

function isQuotaRateLimit(err: unknown): boolean {
  if (!(err instanceof RateLimitError)) return false;
  // err.error's shape is provider-defined, not typed precisely by the SDK
  // (APIError<429, Headers> leaves TError as the generic Object default) —
  // read defensively rather than asserting a shape OpenAI hasn't committed to.
  const nestedCode = (err.error as { error?: { code?: string } } | undefined)?.error?.code;
  return err.code === "insufficient_quota" || nestedCode === "insufficient_quota";
}

/** Pure classification — no retry, no I/O. Exported for direct unit
 * testing of the taxonomy without needing to trigger real network errors:
 * "input" -> terminal, per-row, no attempt burn (HTTP 400). "auth" ->
 * terminal, WHOLE-RUN abort, no attempt burn (401/403, or 429 with
 * insufficient_quota — a capacity problem, not a data problem). "transient"
 * -> everything else (plain rate limit, 5xx, network) — eligible for the
 * in-run retry in classifyAndRetry below, then a per-row attempt-count
 * increment if retries are exhausted. */
export function classifyEmbedError(err: unknown): EmbedErrorClass {
  if (err instanceof BadRequestError) return "input";
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return "auth";
  if (isQuotaRateLimit(err)) return "auth";
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
      const retryAfterHeader = err instanceof APIError ? err.headers?.get("retry-after") : null;
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs ? retryAfterMs : Math.min(500 * 2 ** attempt, 4000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs + Math.random() * 200));
    }
  }
  throw lastErr;
}

export interface EmbedResult {
  embeddings: number[][];
  promptTokens: number;
}

/** Embeds a batch of texts via OpenAI's /v1/embeddings, at
 * EMBEDDING_DIMENSIONS. Throws EmbedInputError / EmbedAuthError per the
 * taxonomy above, or the last transient error if retries are exhausted. */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], promptTokens: 0 };
  const openai = getClient();
  const batches = planEmbedRequests(texts);

  const embeddings: number[][] = new Array(texts.length);
  let promptTokens = 0;

  for (const batch of batches) {
    const response = await classifyAndRetry(() =>
      openai.embeddings.create({
        model: OPENAI_EMBEDDING_MODEL_ID,
        dimensions: EMBEDDING_DIMENSIONS,
        input: batch.texts,
        encoding_format: "float",
      }),
    );
    promptTokens += response.usage.prompt_tokens;
    // data[i].index is NOT guaranteed to match array position by the API
    // contract — always re-key explicitly rather than assuming order.
    for (const item of response.data) {
      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`embedding at response index ${item.index} has ${item.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
      embeddings[batch.indices[item.index]] = item.embedding;
    }
  }
  return { embeddings, promptTokens };
}

/** Single-text convenience wrapper — retrieve.ts's query embedding. */
export async function embedOne(text: string): Promise<{ embedding: number[]; promptTokens: number }> {
  const { embeddings, promptTokens } = await embedTexts([text]);
  return { embedding: embeddings[0], promptTokens };
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
 * Logs one llm_runs row per invocation (kind='embed') with REAL cost/usage
 * — unlike a free local embedding model, this is a metered OpenAI call, so
 * prompt_tokens and cost_usd are both genuine.
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
      const { embeddings, promptTokens } = await embedTexts(batch.map((row) => row.content));
      promptTokensTotal += promptTokens;
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
    // An embedding call has no prompt template to version — placeholder,
    // not a real prompt revision like the extract/consolidate constants.
    prompt_version: "embed-v1",
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
