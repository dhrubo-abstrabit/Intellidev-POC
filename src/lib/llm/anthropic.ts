import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { llmEnv } from "@/lib/env";
import { ActionItemGenerationSchema } from "./schema";
import type { ActionItemContext, ActionItemGenerationResult, LLMProvider } from "./types";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 8000;

// Haiku 4.5 will not cache a prefix shorter than this — silently (no error,
// cache_creation_input_tokens comes back 0), so we can only detect it after
// the fact by checking usage on the response. See buildSystemBlocks: the
// stable system prompt + project profile is what needs to clear this floor.
const CACHE_MIN_TOKENS = 4096;

const SYSTEM_PROMPT = `You monitor software team activity (chat messages, task updates, file changes) for a single project and extract actionable signal for a daily digest: new action items, risks, blockers, status updates, and follow-ups a human should know about.

Rules:
- Only surface items with real signal. Do not invent action items from routine chatter (greetings, acknowledgements, off-topic banter).
- Check the OPEN ITEMS list before creating anything new. If a new event is about something already tracked there, reuse that item's EXACT title text, character-for-character, so your output merges into it instead of creating a duplicate.
- If an item is genuinely new, write a title that is stable and specific enough to match verbatim next time you see the same underlying issue (e.g. "Fix flaky checkout test" is good; "Fix the test that broke today" is not — it will not match tomorrow).
- confidence is your calibrated probability (0-1) that this is a real, correctly-scoped item, not enthusiasm.
- sourceEventIds must only contain ids from the NEW EVENTS list you are given below, and must genuinely support the item.
- If there is nothing worth surfacing, return an empty items array. Do not pad output to seem useful.`;

function renderProjectProfile(context: ActionItemContext): string {
  const openItems = context.openActionItems.length
    ? context.openActionItems.map((item) => `- [${item.kind}/${item.priority}] ${item.title}`).join("\n")
    : "(none)";

  const summaries = context.recentSummaries.length
    ? context.recentSummaries.map((s) => `- ${s.date}: ${s.summary}`).join("\n")
    : "(none yet)";

  return `Project: ${context.project.name}
${context.project.description ?? ""}
Timezone: ${context.project.timezone}

OPEN ITEMS (do not duplicate — reuse the exact title if a new event maps to one of these):
${openItems}

RECENT DAILY SUMMARIES:
${summaries}`;
}

function renderNewEvents(context: ActionItemContext): string {
  if (context.newEvents.length === 0) {
    return "NEW EVENTS: (none)";
  }
  const rendered = context.newEvents
    .map((event) => {
      const who = event.actorDisplay ?? "unknown";
      const text = [event.title, event.body].filter(Boolean).join(" — ");
      return `- id=${event.id} type=${event.type} actor=${who} occurred_at=${event.occurredAt}\n  ${text}`;
    })
    .join("\n");
  return `NEW EVENTS (${context.newEvents.length}):\n${rendered}`;
}

function buildSystemBlocks(context: ActionItemContext): Anthropic.Messages.TextBlockParam[] {
  return [
    { type: "text", text: SYSTEM_PROMPT },
    // Ephemeral breakpoint AFTER the profile — everything up to here is
    // stable across consecutive runs for the same project (until the open
    // items list or summaries change), everything after (the new events
    // block, passed as the user message) is volatile and never cached.
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

  async generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult> {
    const anthropic = getClient();
    const system = buildSystemBlocks(context);
    const userContent = renderNewEvents(context);

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
};
