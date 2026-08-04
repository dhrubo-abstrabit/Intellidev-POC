"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/database.types";

type ActionItemStatus = Database["public"]["Enums"]["action_item_status"];

async function setStatus(
  workspaceId: string,
  projectId: string,
  formData: FormData,
  status: ActionItemStatus,
): Promise<void> {
  await requireUser();

  const itemId = formData.get("itemId");
  if (typeof itemId !== "string" || !itemId) {
    throw new Error("Missing action item id.");
  }

  // User-scoped client, not service — action_items_update's RLS policy plus
  // the column-scoped grant (status/assignee_id/snoozed_until/resolved_at/
  // priority only) is exactly the right boundary here: no service client
  // needed, and the client physically cannot touch title/confidence/etc.
  const supabase = await createClient();
  const { error } = await supabase
    .from("action_items")
    .update({ status, resolved_at: status === "done" || status === "dismissed" ? new Date().toISOString() : null })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not update action item: ${error.message}`);
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/items`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
}

export async function completeActionItem(workspaceId: string, projectId: string, formData: FormData): Promise<void> {
  await setStatus(workspaceId, projectId, formData, "done");
}

export async function dismissActionItem(workspaceId: string, projectId: string, formData: FormData): Promise<void> {
  await setStatus(workspaceId, projectId, formData, "dismissed");
}
