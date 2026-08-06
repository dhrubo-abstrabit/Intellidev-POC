"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function updateProjectContext(
  workspaceId: string,
  projectId: string,
  description: string,
): Promise<{ message: string }> {
  await requireUser();

  // projects grants full update to any workspace member (no column
  // restriction, unlike action_items) — user-scoped client is sufficient.
  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .update({ description: description.trim() || null })
    .eq("id", projectId)
    .eq("workspace_id", workspaceId);
  if (error) {
    throw new Error(`Could not save project context: ${error.message}`);
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/project-context`);
  return { message: "Project context saved" };
}
