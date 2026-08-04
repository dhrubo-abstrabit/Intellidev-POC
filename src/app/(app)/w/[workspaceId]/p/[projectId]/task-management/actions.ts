"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/database.types";

type ActionItemPriority = Database["public"]["Enums"]["action_item_priority"];
// snoozed is excluded here — it needs a snoozed_until date, which this
// generic status setter doesn't collect. See snoozeActionItem below.
type BoardStatus = Exclude<Database["public"]["Enums"]["action_item_status"], "snoozed">;

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

  // User-scoped client — the action_items_update RLS policy plus the
  // column-scoped grant (status/assignee_id/snoozed_until/resolved_at/
  // priority only) is exactly the right boundary here, same as
  // items/actions.ts's setStatus.
  const supabase = await createClient();
  const { error } = await supabase
    .from("action_items")
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
    .from("action_items")
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
  assigneeId: string | null,
): Promise<{ message: string }> {
  await requireUser();

  const supabase = await createClient();

  // Not a security boundary (RLS already scopes the write to this
  // workspace, and a bogus id would fail the FK constraint regardless) —
  // this just turns a raw Postgres FK-violation error into a clean message.
  if (assigneeId) {
    const { data: member } = await supabase
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", assigneeId)
      .maybeSingle();
    if (!member) {
      throw new Error("That person is not a member of this workspace.");
    }
  }

  const { error } = await supabase
    .from("action_items")
    .update({ assignee_id: assigneeId })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not update assignee: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: assigneeId ? "Assigned" : "Unassigned" };
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
    .from("action_items")
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
