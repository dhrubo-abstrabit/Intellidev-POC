"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { assertProjectScope } from "@/lib/scope";
import { generateActionItems } from "@/services/action-items/generate";

/**
 * Manual override for a specific day: runs extraction synchronously (not via
 * the pgmq/pg_cron /api/jobs/llm queue that the daily batch fan-in uses) so
 * it works against a bare `localhost` dev server too. A single day's volume
 * for one client space is small enough that this stays well under this
 * route's maxDuration.
 */
export async function extractActionItemsForDay(
  workspaceId: string,
  projectId: string,
  date: string,
): Promise<{ message: string }> {
  await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const result = await generateActionItems(scope.clientSpaceId, date);
  if (result.status === "failed") {
    throw new Error(result.error ?? "Extraction failed.");
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/data`);

  if (result.status === "skipped") {
    return { message: `No new messages to extract for ${date}.` };
  }
  return { message: `${date}: ${result.itemsCreated} new, ${result.itemsMerged} updated.` };
}
