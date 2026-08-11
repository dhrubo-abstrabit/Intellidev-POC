"use server";

import { revalidatePath } from "next/cache";
import { requireUser, assertProjectMembership } from "@/lib/auth";
import { generateActionItems } from "@/services/action-items/generate";

/**
 * Manual override for a specific day: runs extraction synchronously (not via
 * the QStash /api/jobs/llm queue that the daily batch fan-in uses) so it
 * works against a bare `localhost` dev server too — see syncNow's doc
 * comment in ../integrations/actions.ts for why the queued path can't. A
 * single day's volume for one project is small enough that this stays well
 * under this route's maxDuration.
 */
export async function extractActionItemsForDay(
  workspaceId: string,
  projectId: string,
  date: string,
): Promise<{ message: string }> {
  await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  const result = await generateActionItems(projectId, date);
  if (result.status === "failed") {
    throw new Error(result.error ?? "Extraction failed.");
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/data`);

  if (result.status === "skipped") {
    return { message: `No new messages to extract for ${date}.` };
  }
  return { message: `${date}: ${result.itemsCreated} new, ${result.itemsMerged} updated.` };
}
