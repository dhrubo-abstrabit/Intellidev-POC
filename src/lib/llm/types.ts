import type { ActionItemDraft } from "./schema";

export interface OpenActionItemSummary {
  title: string;
  kind: string;
  priority: string;
}

export interface NewEventSummary {
  id: string;
  type: string;
  actorDisplay?: string | null;
  title?: string | null;
  body?: string | null;
  occurredAt: string;
  resourceType?: string | null;
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

/**
 * Every LLM backend implements just this one method — adding a second
 * provider (e.g. for a cheaper bulk-summarization pass) means one new file
 * plus one line in factory.ts, never a change to services/action-items.
 */
export interface LLMProvider {
  readonly id: string;
  generateActionItems(context: ActionItemContext): Promise<ActionItemGenerationResult>;
}
