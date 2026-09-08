"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
// See task-management/actions.ts: RLS refuses an UPDATE with zero rows and no
// error, so the gate and the zero-row guard together are what turn a refusal
// into a message instead of a false success.
import { requirePermission, projectScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/database.types";

type ActionItemStatus = Database["public"]["Enums"]["task_status"];

async function setStatus(
  workspaceId: string,
  projectId: string,
  itemId: string,
  status: ActionItemStatus,
): Promise<{ message: string }> {
  await requireUser();

  // User-scoped client, not service — tasks_update's RLS policy plus
  // the column-scoped grant (status/assignee_id/snoozed_until/resolved_at/
  // priority only) is exactly the right boundary here: no service client
  // needed, and the client physically cannot touch title/confidence/etc.
  await requirePermission("task.update", projectScope(projectId));

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("tasks")
    .update({ status, resolved_at: status === "done" || status === "dismissed" ? new Date().toISOString() : null })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not update action item: ${error.message}`);
  }
  if (!row) {
    throw new Error("Could not update this item. You may not have permission to change it.");
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/items`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
  return { message: status === "done" ? "Marked as done" : "Dismissed" };
}

export async function completeActionItem(workspaceId: string, projectId: string, itemId: string): Promise<{ message: string }> {
  return setStatus(workspaceId, projectId, itemId, "done");
}

export async function dismissActionItem(workspaceId: string, projectId: string, itemId: string): Promise<{ message: string }> {
  return setStatus(workspaceId, projectId, itemId, "dismissed");
}
