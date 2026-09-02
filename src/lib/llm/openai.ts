import "server-only";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { llmEnv } from "@/lib/env";
import {
  EXTRACTION_SYSTEM_PROMPT,
  CONSOLIDATION_SYSTEM_PROMPT,
  PROMPT_VERSION,
  renderProjectProfile,
  renderExtractionUserContent,
  renderConsolidationUserContent,
} from "./prompt";
import { OpenAIGenerationWireSchema, OpenAIConsolidationWireSchema, toActionItemGeneration, toActionItemConsolidation } from "./openai-schema";
import type {
  ActionItemContext,
  ActionItemGenerationResult,
  ActionItemConsolidationResult,
  DraftForConsolidation,
  LLMProvider,
  LLMUsage,
  OpenActionItemSummary,
} from "./types";

export const OPENAI_MODEL = "gpt-5.6-luna";
const MODEL = OPENAI_MODEL;

// Reasoning tokens count against this cap (billed as output, at 6x the
// input rate) — a reasoning-heavy call can otherwise exhaust the budget
// before emitting any JSON and return status:"incomplete" with no items, a
// silent zero-items day if unhandled. Generous relative to Anthropic's 8000
// specifically because of that risk; only tokens actually generated are
// billed, so a larger cap costs nothing on its own.
const MAX_OUTPUT_TOKENS = 16_000;

// Extraction fans out via Promise.all across up to several chunks in one
// 60s route (see generate.ts's MAX_EVENTS_PER_CHUNK) — wall-clock is the
// SLOWEST chunk, so low latency risk matters more here than reasoning
// depth. `low` is OpenAI's own recommendation for high-volume workloads;
// `none` is unsafe specifically because reusing an open item's title
// character-for-character (the rule that prevents duplicate tasks) is
// exactly the kind of constraint-checking that degrades first with no
// reasoning budget.
const EXTRACTION_EFFORT = "low" as const;
// Consolidation's prompt is tiny (a handful of one-line drafts, so extra
// reasoning tokens cost little) but its decisions have the highest blast
// radius in the system — which drafts merge into which existing task is
// exactly the operation category that failed catastrophically once already
// on a different design (see the migration's own note on the reverted
// find_similar_open_tasks). Buying quality here is nearly free.
const CONSOLIDATION_EFFORT = "medium" as const;

let client: OpenAI | undefined;
function getClient(): OpenAI {
  if (client) return client;
  // maxRetries: 0 — the job route's pgmq redelivery is already the retry
  // mechanism for this job (60s * attempt backoff, see lib/queue/pgmq.ts);
  // in-process SDK retries would only steal from the route's 60s Vercel
  // budget and can turn a recoverable error into a hard function timeout
  // with no llm_runs row ever updated to 'failed'.
  client = new OpenAI({ apiKey: llmEnv().OPENAI_API_KEY, maxRetries: 0, timeout: 50_000 });
  return client;
}

/** True when a Responses API output item is an assistant message carrying
 * at least one refusal content part. */
function findRefusalText(output: OpenAI.Responses.Response["output"]): string | null {
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "refusal") return part.refusal;
    }
  }
  return null;
}

/**
 * Injectable so unit tests can construct createOpenAIProvider(fakeClient)
 * directly — no module mocking needed. `openaiProvider` below is the lazy
 * real-client default most callers want.
 */
export function createOpenAIProvider(openai: OpenAI): LLMProvider {
  return {
    id: "openai",
    model: MODEL,

    async generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult> {
      const instructions = `${EXTRACTION_SYSTEM_PROMPT}\n\n${renderProjectProfile(context)}`;
      const userContent = renderExtractionUserContent(context);

      const response = await openai.responses.parse({
        model: MODEL,
        instructions,
        input: [{ role: "user", content: userContent }],
        text: { format: zodTextFormat(OpenAIGenerationWireSchema, "action_items") },
        reasoning: { effort: EXTRACTION_EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        // Stable prefix per project — OpenAI's own automatic caching is
        // keyed by exact prefix match with no explicit breakpoint call
        // needed; this key just helps its cache bucketing. See the
        // caching-reality-check note below: the truly stable prefix here
        // (EXTRACTION_SYSTEM_PROMPT alone, ~400 tokens) sits under
        // GPT-5.6's ~1,024-token cache floor, so this will rarely engage —
        // OPEN ITEMS in the project profile changes on nearly every run,
        // which is the whole point of the pipeline. Not worth engineering
        // around for v1; the identical issue already exists on the
        // Anthropic path (see CACHE_MIN_TOKENS there).
        prompt_cache_key: `${PROMPT_VERSION}:extract:${context.project.id}`,
      });

      if (response.status === "incomplete") {
        throw new Error(`gpt-5.6-luna response incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}`);
      }
      const refusal = findRefusalText(response.output);
      if (refusal) {
        throw new Error(`gpt-5.6-luna refused: ${refusal}`);
      }
      if (!response.output_parsed) {
        throw new Error("Model did not return parseable structured output");
      }

      return {
        items: toActionItemGeneration(response.output_parsed).items,
        usage: mapUsage(response.usage),
        model: MODEL,
        prompt: { instructions, input: [{ role: "user", content: userContent }], reasoning: { effort: EXTRACTION_EFFORT }, model: MODEL },
        response,
      };
    },

    async consolidateActionItems(
      openActionItems: OpenActionItemSummary[],
      drafts: DraftForConsolidation[],
    ): Promise<ActionItemConsolidationResult> {
      const userContent = renderConsolidationUserContent(openActionItems, drafts);

      const response = await openai.responses.parse({
        model: MODEL,
        instructions: CONSOLIDATION_SYSTEM_PROMPT,
        input: [{ role: "user", content: userContent }],
        text: { format: zodTextFormat(OpenAIConsolidationWireSchema, "consolidation") },
        reasoning: { effort: CONSOLIDATION_EFFORT },
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
        prompt_cache_key: `${PROMPT_VERSION}:consolidate`,
      });

      if (response.status === "incomplete") {
        throw new Error(`gpt-5.6-luna consolidation response incomplete: ${response.incomplete_details?.reason ?? "unknown reason"}`);
      }
      const refusal = findRefusalText(response.output);
      if (refusal) {
        throw new Error(`gpt-5.6-luna consolidation refused: ${refusal}`);
      }
      if (!response.output_parsed) {
        throw new Error("Model did not return parseable structured output for consolidation");
      }

      return {
        consolidation: toActionItemConsolidation(response.output_parsed),
        usage: mapUsage(response.usage),
        model: MODEL,
        prompt: { instructions: CONSOLIDATION_SYSTEM_PROMPT, input: [{ role: "user", content: userContent }], reasoning: { effort: CONSOLIDATION_EFFORT }, model: MODEL },
        response,
      };
    },
  };
}

/**
 * OpenAI's usage.input_tokens is the TOTAL input, INCLUDING cached and
 * cache-write tokens. Anthropic's input_tokens (and this codebase's
 * LLMUsage.promptTokens contract — see the doc comment on LLMUsage in
 * types.ts) EXCLUDES them. A naive field-for-field copy here would
 * overstate promptTokens, and therefore cost, by up to ~2x. Math.max(0,...)
 * is defensive: if this inclusion semantic ever changes, a negative
 * promptTokens would violate llm_runs' integer column's intent and quietly
 * produce a negative cost rather than an obviously-wrong one.
 */
function mapUsage(usage: OpenAI.Responses.Response["usage"]): LLMUsage {
  const cacheReadTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
  const cacheCreationTokens = usage?.input_tokens_details?.cache_write_tokens ?? 0;
  const promptTokens = Math.max(0, (usage?.input_tokens ?? 0) - cacheReadTokens - cacheCreationTokens);
  return {
    promptTokens,
    completionTokens: usage?.output_tokens ?? 0,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

let lazyProvider: LLMProvider | undefined;
export const openaiProvider: LLMProvider = {
  get id() {
    return "openai";
  },
  get model() {
    return MODEL;
  },
  generateActionItems(context) {
    lazyProvider ??= createOpenAIProvider(getClient());
    return lazyProvider.generateActionItems(context);
  },
  consolidateActionItems(openActionItems, drafts) {
    lazyProvider ??= createOpenAIProvider(getClient());
    return lazyProvider.consolidateActionItems(openActionItems, drafts);
  },
};
