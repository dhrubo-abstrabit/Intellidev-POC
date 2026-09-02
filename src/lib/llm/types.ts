import type { ActionItemDraft, ActionItemConsolidation } from "./schema";

export interface OpenActionItemSummary {
  id: string;
  title: string;
  kind: string;
  priority: string;
}

export interface NewEventAttachmentSummary {
  filename?: string | null;
  mimeType?: string | null;
  text: string;
  truncated: boolean;
}

export interface NewEventSummary {
  id: string;
  type: string;
  actorDisplay?: string | null;
  title?: string | null;
  body?: string | null;
  occurredAt: string;
  resourceType?: string | null;
  /** Extracted text from this event's attachments (status='extracted' rows
   * in event_attachments), joined in by services/action-items/generate.ts.
   * Absent, not empty, when there are none — see anthropic.ts's
   * renderNewEvents for how these are budgeted into the prompt. */
  attachments?: NewEventAttachmentSummary[];
}

/** One chunk retrieved from search_chunks via semantic similarity to the
 * day's new events — historical context, not part of today's activity. See
 * services/action-items/related-context.ts for how these are gathered and
 * lib/llm/prompt.ts's renderRelatedContext for how they're rendered. */
export interface RelatedContextChunk {
  /** Stable within one generateActionItems() run — "R1", "R2", ... in
   * chronological order. This, not chunkId, is what the model is ever shown
   * or allowed to cite in ActionItemDraft.relatedContextRefs. */
  label: string;
  chunkId: string;
  sourceKind: "normalized_event" | "event_attachment" | "context_document";
  title?: string | null;
  content: string;
  occurredAt: string;
  /** Resolved server-side by the match_search_chunks RPC — the
   * normalized_events row this chunk traces back to, or null for a
   * context_document chunk (task_sources.normalized_event_id is NOT NULL,
   * so those can't be recorded as a citation yet). */
  citableEventId: string | null;
  /** Cosine distance from the query vector. Deliberately NOT rendered into
   * the prompt (models reason poorly over bare floats); carried for the
   * threshold-calibration pass (via llm_runs.prompt) and as the source for
   * task_sources.relevance when a chunk is cited. */
  distance: number;
}

export interface ActionItemContext {
  project: { id: string; name: string; description?: string | null; timezone: string };
  openActionItems: OpenActionItemSummary[];
  recentSummaries: Array<{ date: string; summary: string }>;
  newEvents: NewEventSummary[];
  /** Optional so every existing call site and both providers work unchanged
   * when retrieval is absent or failed — see generate.ts's loadContext,
   * which wraps the fetch in try/catch specifically so this can never fail
   * extraction itself. */
  relatedContext?: RelatedContextChunk[];
}

/**
 * promptTokens is ORDINARY (non-cached, non-cache-write) input tokens only
 * — every provider must normalize to this before returning usage, even
 * though providers report the total differently. Anthropic's own
 * `usage.input_tokens` already excludes cached/cache-write tokens (they're
 * separate additive fields). OpenAI's `usage.input_tokens` is the total
 * input INCLUDING cached and cache-write tokens — a provider built on it
 * must subtract both before assigning promptTokens, or cost and token
 * counts are overstated by up to ~2x. This is what keeps the three terms in
 * pricing.ts's estimateCostUsd from double-counting regardless of provider.
 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ActionItemGenerationResult {
  items: ActionItemDraft[];
  usage: LLMUsage;
  model: string;
  /** Full request/response, stored verbatim into llm_runs for replay/debugging. */
  prompt: unknown;
  response: unknown;
}

export interface DraftForConsolidation {
  /** Local key ("d1", "d2", ...) this draft is referenced by in the
   * consolidation output — not a database id, drafts aren't persisted yet. */
  key: string;
  draft: ActionItemDraft;
}

export interface ActionItemConsolidationResult {
  consolidation: ActionItemConsolidation;
  usage: LLMUsage;
  model: string;
  prompt: unknown;
  response: unknown;
}

/**
 * Every LLM backend implements these two methods — adding a second provider
 * (e.g. for a cheaper bulk-summarization pass) means one new file plus one
 * line in factory.ts, never a change to services/action-items.
 */
export interface LLMProvider {
  readonly id: string;
  /** The exact model string this provider calls — known up front (not just
   * after a response comes back) so generate.ts can write it into the
   * llm_runs row at insert time, before any call has run. Every provider's
   * ActionItemGenerationResult.model/ActionItemConsolidationResult.model
   * must echo this same value. */
  readonly model: string;
  generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult>;
  /** Reconciles this run's draft items against each other and against
   * openActionItems semantically. Callers should skip calling this when
   * there's only 0-1 drafts — nothing to consolidate. */
  consolidateActionItems(
    openActionItems: OpenActionItemSummary[],
    drafts: DraftForConsolidation[],
  ): Promise<ActionItemConsolidationResult>;
}
