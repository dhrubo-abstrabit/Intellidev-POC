import type { ConnectorProvider } from "@/components/items/provider-badge";
import type { ActionItemKind, ActionItemPriority, ActionItemStatus } from "@/components/items/types";

/** One entry in the left-hand day rail — a day (in the project's timezone)
 * that has at least one normalized_events row in the lookback window. */
export type DayIndexEntry = {
  dayKey: string;
  total: number;
  byProvider: Partial<Record<ConnectorProvider, number>>;
};

export type IntegrationSummary = {
  id: string;
  provider: ConnectorProvider;
  status: string;
  displayName: string | null;
};

/** A normalized_events row for the selected day, camelCased at the boundary
 * (same convention as components/items/types.ts's SourceEvent). */
export type DayEvent = {
  id: string;
  provider: ConnectorProvider;
  type: string;
  actor: string | null;
  actorDisplay: string | null;
  title: string | null;
  body: string | null;
  occurredAt: string;
  resourceUrl: string | null;
  /** processed_at !== null — an llm_run has already consumed this event. */
  processed: boolean;
};

/** An action_items row extracted from (some of) the selected day's events,
 * with the ids of the events that produced it — the message <-> action
 * point linkage the day-linkage panel highlights on click. */
export type DayActionPoint = {
  id: string;
  title: string;
  description: string | null;
  kind: ActionItemKind;
  priority: ActionItemPriority;
  confidenceScore: number;
  status: ActionItemStatus;
  forDate: string;
  dueAt: string | null;
  ownerHint: string | null;
  sourceEventIds: string[];
};
