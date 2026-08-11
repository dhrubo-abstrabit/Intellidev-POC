/**
 * One codec shared by the assignee picker's Select value AND the
 * task-management page's `?assignee=` filter param — both need to tell a
 * real workspace user apart from a Team Members roster contact in a single
 * flat string, since action_items has two mutually-exclusive assignee
 * columns (assignee_id -> users, assignee_team_member_id -> team_members;
 * see supabase/migrations/20260810130000_action_item_team_assignee.sql).
 *
 * UUIDs never contain `:`, so splitting on the first one is unambiguous —
 * no escaping needed.
 */

export type AssigneeKind = "user" | "team_member";

export const UNASSIGNED_VALUE = "__unassigned__";

const PREFIX: Record<AssigneeKind, string> = { user: "user", team_member: "team" };

export function encodeAssigneeValue(kind: AssigneeKind, id: string): string {
  return `${PREFIX[kind]}:${id}`;
}

/**
 * Returns null for UNASSIGNED_VALUE, an unrecognized prefix, or a malformed
 * body — one nullable return, one failure branch for every caller.
 *
 * A bare UUID (no `:`) decodes as `{kind: "user"}` for backward
 * compatibility with links/tests that predate the team_member option —
 * safe to delete this fallback once no such links are in circulation.
 */
export function decodeAssigneeValue(value: string): { kind: AssigneeKind; id: string } | null {
  if (value === UNASSIGNED_VALUE) return null;

  const separatorIndex = value.indexOf(":");
  if (separatorIndex === -1) return { kind: "user", id: value };

  const prefix = value.slice(0, separatorIndex);
  const id = value.slice(separatorIndex + 1);
  if (!id) return null;
  if (prefix === PREFIX.user) return { kind: "user", id };
  if (prefix === PREFIX.team_member) return { kind: "team_member", id };
  return null;
}
