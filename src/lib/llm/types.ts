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

export interface ActionItemContext {
  project: { id: string; name: string; description?: string | null; timezone: string };
  openActionItems: OpenActionItemSummary[];
  recentSummaries: Array<{ date: string; summary: string }>;
  newEvents: NewEventSummary[];
}

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
  generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult>;
  /** Reconciles this run's draft items against each other and against
   * openActionItems semantically. Callers should skip calling this when
   * there's only 0-1 drafts — nothing to consolidate. */
  consolidateActionItems(
    openActionItems: OpenActionItemSummary[],
    drafts: DraftForConsolidation[],
  ): Promise<ActionItemConsolidationResult>;
}
