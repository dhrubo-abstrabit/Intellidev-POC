import type { ActionItemKind, ActionItemPriority, ActionItemStatus } from "@/components/items/types";

export type TaskManagementView = "list" | "kanban";
export type TaskManagementSort = "for_date" | "priority";

export interface TaskManagementFilters {
  view: TaskManagementView;
  q: string;
  priority: ActionItemPriority[];
  /** A user id, "unassigned", or null (no filter). */
  assignee: string | null;
  kind: ActionItemKind[];
  sort: TaskManagementSort;
  /** List-view only — Kanban's columns already partition by status. */
  status: ActionItemStatus[];
}

export const ALL_PRIORITIES: ActionItemPriority[] = ["low", "medium", "high", "urgent"];
export const ALL_KINDS: ActionItemKind[] = ["action", "risk", "blocker", "update", "follow_up"];
const ALL_STATUSES: ActionItemStatus[] = ["pending", "in_progress", "done", "dismissed", "snoozed"];
const DEFAULT_LIST_STATUSES: ActionItemStatus[] = ["pending", "in_progress"];

function parseCsvEnum<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const allowedSet = new Set<string>(allowed);
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is T => allowedSet.has(value));
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pure parsing of the raw searchParams object into normalized filters — kept
 * separate from the Supabase query building in page.tsx so it's unit
 * testable without a database.
 */
export function parseTaskManagementSearchParams(
  raw: Record<string, string | string[] | undefined>,
): TaskManagementFilters {
  // Board is the default view — an explicit ?view=list is what opts into
  // the list view, everything else (including no param at all) is board.
  const view: TaskManagementView = first(raw.view) === "list" ? "list" : "kanban";
  const sort: TaskManagementSort = first(raw.sort) === "priority" ? "priority" : "for_date";
  const statusRaw = first(raw.status);

  return {
    view,
    q: (first(raw.q) ?? "").trim(),
    priority: parseCsvEnum(first(raw.priority), ALL_PRIORITIES),
    assignee: first(raw.assignee) || null,
    kind: parseCsvEnum(first(raw.kind), ALL_KINDS),
    sort,
    // Kanban's columns are the status filter — a status param present while
    // view=kanban is ignored rather than erroring, so a stale/shared URL
    // degrades gracefully.
    status: view === "kanban" ? [] : statusRaw ? parseCsvEnum(statusRaw, ALL_STATUSES) : DEFAULT_LIST_STATUSES,
  };
}
