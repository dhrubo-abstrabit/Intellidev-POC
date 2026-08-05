import type { Database } from "@/lib/db/database.types";

export type ActionItemStatus = Database["public"]["Enums"]["action_item_status"];
export type ActionItemPriority = Database["public"]["Enums"]["action_item_priority"];
export type ActionItemKind = Database["public"]["Enums"]["action_item_kind"];

// snoozed is excluded from the Kanban board and from the plain status
// picker — it requires a snoozed_until date, which those controls don't
// collect. Reaching "snoozed" only happens via the dedicated snooze dialog.
export type BoardStatus = Exclude<ActionItemStatus, "snoozed">;
export const BOARD_STATUSES: BoardStatus[] = ["pending", "in_progress", "done", "dismissed"];

export type AssigneeSummary = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
};

export type ActionItemRow = Pick<
  Database["public"]["Tables"]["action_items"]["Row"],
  | "id"
  | "title"
  | "description"
  | "kind"
  | "priority"
  | "confidence_score"
  | "status"
  | "for_date"
  | "due_at"
  | "owner_hint"
  | "assignee_id"
  | "snoozed_until"
> & {
  assignee: AssigneeSummary | null;
};

export type WorkspaceMember = {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
};

/** One normalized_events row (a Slack message, etc.) linked to an action
 * item via action_item_source_events — the "why was this created" trail. */
export type SourceEvent = {
  id: string;
  type: string;
  actor: string | null;
  actorDisplay: string | null;
  title: string | null;
  body: string | null;
  occurredAt: string;
};

export const STATUS_LABEL: Record<ActionItemStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  done: "Done",
  dismissed: "Dismissed",
  snoozed: "Snoozed",
};
