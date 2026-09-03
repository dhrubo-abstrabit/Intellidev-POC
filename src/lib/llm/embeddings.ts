import "server-only";
import { OpenAIEmbeddings } from "@langchain/openai";
import { embeddingEnv } from "@/lib/env";

// Not folded into the LLMProvider abstraction in ./types.ts: that interface
// dispatches on the LLM_PROVIDER chat env var, and embeddings must stay
// pinned to OpenAI regardless of which chat provider is selected (see
// embeddingEnv's own doc comment in lib/env.ts) — routing embeddings through
// the chat factory would make a chat-provider swap silently swap the
// embedding model too, invalidating every existing search_chunks.embedding
// row's comparability.
let client: OpenAIEmbeddings | undefined;

/**
 * Cached OpenAIEmbeddings client. Every option here is a deliberate override
 * of a LangChain default, verified against the installed @langchain/openai
 * source rather than assumed:
 *
 * - stripNewLines: false — the default is TRUE (LangChain replaces "\n"
 *   with " " before embedding). Leaving it on would embed different text
 *   than embed.ts used to send directly to the SDK, under the same
 *   embedding_model label existing rows carry.
 * - batchSize: 128 — matches embed.ts's own MAX_INPUTS_PER_REQUEST, so
 *   LangChain's internal chunking of embedDocuments() becomes a no-op
 *   inside each of runEmbedding's already-planned outer batches. The
 *   default (512) would let one embedDocuments() call fan out into several
 *   HTTP requests whose partial failure embed.ts has no way to attribute
 *   back to specific rows.
 * - maxConcurrency: 1 — the default is unbounded (Infinity); embed.ts's own
 *   batching is what controls request pacing.
 * - maxRetries: 0 + onFailedAttempt throwing immediately — bypasses
 *   @langchain/core's AsyncCaller default retry handler entirely (its
 *   constructor is `onFailedAttempt: params.onFailedAttempt ??
 *   defaultFailedAttemptHandler`, so supplying our own replaces it, not
 *   supplements it). embed.ts's classifyAndRetry must remain the sole
 *   authority on what gets retried and how — LangChain's own retry/backoff
 *   has no concept of embed.ts's input/auth/transient taxonomy.
 */
export function getEmbeddingsClient(model: string, dimensions: number): OpenAIEmbeddings {
  if (client) return client;
  client = new OpenAIEmbeddings({
    apiKey: embeddingEnv().OPENAI_API_KEY,
    model,
    dimensions,
    batchSize: 128,
    stripNewLines: false,
    encodingFormat: "float",
    timeout: 30_000,
    maxConcurrency: 1,
    maxRetries: 0,
    onFailedAttempt: (err) => {
      throw err;
    },
  });
  return client;
}

let tokenizer: import("js-tiktoken/lite").Tiktoken | undefined;

/**
 * Estimates token count for embedding-request batching and cost-estimate
 * logging — NOT a substitute for the provider's own billed usage.prompt_tokens,
 * which OpenAIEmbeddings' embedDocuments()/embedQuery() never surface (see
 * embed.ts's own doc comment on estimatedPromptTokens for the tradeoff this
 * accepts).
 *
 * text-embedding-3-small tokenizes with cl100k_base (verified against
 * tiktoken's own model.py — o200k_base is gpt-4o/gpt-5 family only). The
 * rank table (~1.6-1.8MB) is loaded lazily behind a module-level singleton
 * so a request path that never embeds (e.g. a plain retrieval query in
 * retrieve.ts that only calls embedOne once) doesn't pay the parse/BPE-map
 * construction cost until it actually needs to.
 */
export async function countEmbeddingTokens(text: string): Promise<number> {
  if (!tokenizer) {
    const [{ Tiktoken }, { default: cl100kBase }] = await Promise.all([
      import("js-tiktoken/lite"),
      import("js-tiktoken/ranks/cl100k_base"),
    ]);
    tokenizer = new Tiktoken(cl100kBase);
  }
  return tokenizer.encode(text).length;
}
