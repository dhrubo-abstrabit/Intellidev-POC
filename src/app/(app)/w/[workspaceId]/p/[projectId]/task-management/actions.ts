"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { decodeAssigneeValue } from "@/components/items/assignee";
import type { Database } from "@/lib/db/database.types";

type ActionItemPriority = Database["public"]["Enums"]["task_priority"];
// snoozed is excluded here — it needs a snoozed_until date, which this
// generic status setter doesn't collect. See snoozeActionItem below.
type BoardStatus = Exclude<Database["public"]["Enums"]["task_status"], "snoozed">;

function revalidateTaskManagement(workspaceId: string, projectId: string) {
  revalidatePath(`/w/${workspaceId}/p/${projectId}/task-management`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
}

export async function updateActionItemStatus(
  workspaceId: string,
  projectId: string,
  itemId: string,
  status: BoardStatus,
): Promise<{ message: string }> {
  await requireUser();

  // User-scoped client — the tasks_update RLS policy plus the
  // column-scoped grant (status/assignee_id/snoozed_until/resolved_at/
  // priority only) is exactly the right boundary here, same as
  // items/actions.ts's setStatus.
  const supabase = await createClient();
  const { error } = await supabase
    .from("tasks")
    .update({
      status,
      resolved_at: status === "done" || status === "dismissed" ? new Date().toISOString() : null,
      snoozed_until: null,
    })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not update status: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: "Status updated" };
}

export async function updateActionItemPriority(
  workspaceId: string,
  projectId: string,
  itemId: string,
  priority: ActionItemPriority,
): Promise<{ message: string }> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase
    .from("tasks")
    .update({ priority })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not update priority: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: "Priority updated" };
}

export async function updateActionItemAssignee(
  workspaceId: string,
  projectId: string,
  itemId: string,
  assigneeValue: string | null,
): Promise<{ message: string }> {
  await requireUser();

  const supabase = await createClient();

  const target = assigneeValue ? decodeAssigneeValue(assigneeValue) : null;
  if (assigneeValue && !target) {
    throw new Error("Unrecognized assignee.");
  }

  if (target?.kind === "user") {
    // This lookup IS the security boundary here (unlike the roster branch
    // below): assignee_id's FK is to bare users(id), with no workspace
    // scoping, so a bogus-but-real user id from another workspace would
    // otherwise pass straight through to the write.
    const { data: member } = await supabase
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", target.id)
      .maybeSingle();
    if (!member) {
      throw new Error("That person is not a member of this workspace.");
    }
  } else if (target?.kind === "team_member") {
    // Cosmetic here, unlike the user branch above — assignee_team_member_id
    // has a composite FK to team_members(id, workspace_id), so a
    // cross-workspace or nonexistent id would fail the FK regardless. This
    // just turns that into a friendlier message.
    const { data: contact } = await supabase
      .from("team_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("id", target.id)
      .maybeSingle();
    if (!contact) {
      throw new Error("That person is not on this workspace's team roster.");
    }
  }

  // Both columns, every time — tasks_single_assignee_chk rejects a
  // write that leaves the previous assignee's column populated when
  // switching between a user and a roster contact.
  const { error } = await supabase
    .from("tasks")
    .update({
      assignee_id: target?.kind === "user" ? target.id : null,
      assignee_team_member_id: target?.kind === "team_member" ? target.id : null,
    })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not update assignee: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: target ? "Assigned" : "Unassigned" };
}

const snoozeSchema = z.object({
  snoozedUntil: z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), "Invalid date"),
});

export async function snoozeActionItem(
  workspaceId: string,
  projectId: string,
  itemId: string,
  snoozedUntilDate: string,
): Promise<{ message: string }> {
  await requireUser();

  const parsed = snoozeSchema.safeParse({ snoozedUntil: snoozedUntilDate });
  if (!parsed.success) {
    throw new Error("Please choose a valid date.");
  }
  // A plain <input type="date"> gives "YYYY-MM-DD" with no time component;
  // anchoring to end-of-day is a POC-level approximation — exact per-project
  // timezone handling (like for_date already does) isn't in scope here.
  const snoozedUntilIso = new Date(`${parsed.data.snoozedUntil}T23:59:59`).toISOString();

  const supabase = await createClient();
  const { error } = await supabase
    .from("tasks")
    .update({ status: "snoozed", snoozed_until: snoozedUntilIso, resolved_at: null })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not snooze: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: `Snoozed until ${parsed.data.snoozedUntil}` };
}
