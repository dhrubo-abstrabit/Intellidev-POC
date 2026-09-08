import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { llmEnv } from "@/lib/env";
import { ActionItemGenerationSchema, ActionItemConsolidationSchema, TaskEnrichmentSchema } from "./schema";
import {
  EXTRACTION_SYSTEM_PROMPT,
  CONSOLIDATION_SYSTEM_PROMPT,
  ENRICH_TASK_SYSTEM_PROMPT,
  renderProjectProfile,
  renderExtractionUserContent,
  renderConsolidationUserContent,
  renderTaskEnrichmentUserContent,
} from "./prompt";
import type {
  ActionItemContext,
  ActionItemGenerationResult,
  ActionItemConsolidationResult,
  DraftForConsolidation,
  LLMProvider,
  OpenActionItemSummary,
  TaskEnrichmentContext,
  TaskEnrichmentResult,
} from "./types";

export const ANTHROPIC_MODEL = "claude-haiku-4-5";
const MODEL = ANTHROPIC_MODEL;
const MAX_TOKENS = 8000;

// Haiku 4.5 will not cache a prefix shorter than this — silently (no error,
// cache_creation_input_tokens comes back 0), so we can only detect it after
// the fact by checking usage on the response. See buildSystemBlocks: the
// stable system prompt + project profile is what needs to clear this floor.
const CACHE_MIN_TOKENS = 4096;

function buildSystemBlocks(context: ActionItemContext): Anthropic.Messages.TextBlockParam[] {
  return [
    { type: "text", text: EXTRACTION_SYSTEM_PROMPT },
    // Ephemeral breakpoint AFTER the profile — everything up to here is
    // stable across consecutive runs for the same project (until the open
    // items list or summaries change), everything after (RELATED CONTEXT +
    // NEW EVENTS, passed as the user message) is volatile and never cached.
    { type: "text", text: renderProjectProfile(context), cache_control: { type: "ephemeral" } },
  ];
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (client) return client;
  client = new Anthropic({ apiKey: llmEnv().ANTHROPIC_API_KEY });
  return client;
}

export const anthropicProvider: LLMProvider = {
  id: "anthropic",
  model: MODEL,

  async generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult> {
    const anthropic = getClient();
    const system = buildSystemBlocks(context);
    const userContent = renderExtractionUserContent(context);

    const message = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: userContent }],
      // effort is NOT supported on Haiku 4.5 (the API rejects it) — omit
      // entirely rather than pass a value that would 400.
      output_config: { format: zodOutputFormat(ActionItemGenerationSchema) },
    });

    const cachedTokens = (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
    if (cachedTokens === 0 && message.usage.input_tokens < CACHE_MIN_TOKENS) {
      console.warn(
        `[llm] project ${context.project.id}: prompt prefix likely under Haiku 4.5's ${CACHE_MIN_TOKENS}-token cache floor (input_tokens=${message.usage.input_tokens}) — paying full price every run until it grows.`,
      );
    }

    if (!message.parsed_output) {
      throw new Error("Model did not return parseable structured output");
    }

    return {
      items: message.parsed_output.items,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: MODEL,
      prompt: { system, messages: [{ role: "user", content: userContent }] },
      response: message,
    };
  },

  async consolidateActionItems(
    openActionItems: OpenActionItemSummary[],
    drafts: DraftForConsolidation[],
  ): Promise<ActionItemConsolidationResult> {
    const anthropic = getClient();
    const userContent = renderConsolidationUserContent(openActionItems, drafts);

    const message = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: CONSOLIDATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(ActionItemConsolidationSchema) },
    });

    if (!message.parsed_output) {
      throw new Error("Model did not return parseable structured output for consolidation");
    }

    return {
      consolidation: message.parsed_output,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: MODEL,
      prompt: { system: CONSOLIDATION_SYSTEM_PROMPT, messages: [{ role: "user", content: userContent }] },
      response: message,
    };
  },

  async enrichTaskDescription(context: TaskEnrichmentContext): Promise<TaskEnrichmentResult> {
    const anthropic = getClient();
    const userContent = renderTaskEnrichmentUserContent(context);

    const message = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: ENRICH_TASK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: zodOutputFormat(TaskEnrichmentSchema) },
    });

    if (!message.parsed_output) {
      throw new Error("Model did not return parseable structured output for task enrichment");
    }

    return {
      enrichment: message.parsed_output,
      usage: {
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      model: MODEL,
      prompt: { system: ENRICH_TASK_SYSTEM_PROMPT, messages: [{ role: "user", content: userContent }] },
      response: message,
    };
  },
};
