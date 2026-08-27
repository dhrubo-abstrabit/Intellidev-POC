import type { Database } from "@/lib/db/database.types";

export type ActionItemStatus = Database["public"]["Enums"]["task_status"];
export type ActionItemPriority = Database["public"]["Enums"]["task_priority"];
export type ActionItemKind = Database["public"]["Enums"]["task_kind"];

// snoozed is excluded from the Kanban board and from the plain status
// picker — it requires a snoozed_until date, which those controls don't
// collect. Reaching "snoozed" only happens via the dedicated snooze dialog.
export type BoardStatus = Exclude<ActionItemStatus, "snoozed">;
export const BOARD_STATUSES: BoardStatus[] = ["pending", "in_progress", "done", "dismissed"];

export type AssigneeKind = "user" | "team_member";

/** A task's resolved assignee — either a real workspace user (assignee_id)
 * or a Team Members roster contact (assignee_team_member_id); the two
 * columns are mutually exclusive (tasks_single_assignee_chk). `value`
 * is the encoded picker/filter value (see ./assignee.ts) so a component can
 * seed a Select or a link straight from a row without re-encoding. */
export type AssigneeSummary = {
  kind: AssigneeKind;
  id: string;
  value: string;
  name: string | null;
  avatar_url: string | null;
};

export type ActionItemRow = Pick<
  Database["public"]["Tables"]["tasks"]["Row"],
  | "id"
  | "title"
  | "description"
  | "kind"
  | "priority"
  | "confidence"
  | "status"
  | "for_date"
  | "due_at"
  | "owner_hint"
  | "assignee_id"
  | "assignee_team_member_id"
  | "snoozed_until"
> & {
  assignee: AssigneeSummary | null;
};

/** One selectable entry in the assignee dropdown/filter — either a real
 * workspace user or a Team Members roster contact. `name`/`value` are
 * pre-resolved server-side (full_name ?? email for users; name for roster
 * contacts) so every consumer stops duplicating that fallback. `role` is
 * only ever set for roster contacts (team_members.role is free text; real
 * users have no such field). Replaces the old user-only `WorkspaceMember`
 * type — its use was entirely contained to this file and task-management/,
 * and keeping that name once it can also hold a non-member roster contact
 * would recreate exactly the confusion team_members' own migration comment
 * warns against. */
export type AssigneeOption = {
  kind: AssigneeKind;
  id: string;
  value: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: string | null;
};

/** One event_attachments row for a SourceEvent/DayEvent, camelCased at the
 * boundary. Deliberately omits storage_path/download_ref — the client only
 * ever needs enough to render a status and, once extracted, ask
 * getAttachmentPreviewUrl (./attachment-actions) for a fresh signed URL by
 * id. Shared between task-management's TaskDetailSheet and the Project Data
 * tab's DayLinkage — both show the same normalized_events rows, just via a
 * different route in. */
export type AttachmentSummary = {
  id: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: "pending" | "extracted" | "skipped" | "failed";
  skipReason: string | null;
};

/** One normalized_events row (a Slack message, etc.) linked to an action
 * item via task_sources — the "why was this created" trail. */
export type SourceEvent = {
  id: string;
  type: string;
  actor: string | null;
  actorDisplay: string | null;
  title: string | null;
  body: string | null;
  occurredAt: string;
  attachments: AttachmentSummary[];
};

export const STATUS_LABEL: Record<ActionItemStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  done: "Done",
  dismissed: "Dismissed",
  snoozed: "Snoozed",
};

export const PRIORITY_LABEL: Record<ActionItemPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const KIND_LABEL: Record<ActionItemKind, string> = {
  action: "Action",
  risk: "Risk",
  blocker: "Blocker",
  update: "Update",
  follow_up: "Follow Up",
};
