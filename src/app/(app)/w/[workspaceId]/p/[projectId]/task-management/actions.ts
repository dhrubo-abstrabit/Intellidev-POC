"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
// These write through the user-scoped client, so tasks_update's RLS policy is
// the real boundary and always has been. requirePermission is here because RLS
// refuses an UPDATE by matching ZERO ROWS, with no error - so without it a
// space viewer clicked "Done", got "Status updated", and nothing changed. The
// zero-row guards below close the same gap from the other side.
import { requirePermission, projectScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { assertProjectScope } from "@/lib/scope";
import { getLLMProvider } from "@/lib/llm/factory";
import { decodeAssigneeValue } from "@/components/items/assignee";
import { findRelatedForTask as findRelatedCandidates, buildTaskQueryText, type RelatedCandidate } from "@/services/tasks/find-related";
import { linkAndEnrichTaskSource, type LinkTaskSourceResult } from "@/services/tasks/enrich";
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
  await requirePermission("task.update", projectScope(projectId));

  // User-scoped client — the tasks_update RLS policy plus the
  // column-scoped grant (status/assignee_id/snoozed_until/resolved_at/
  // priority only) is exactly the right boundary here, same as
  // items/actions.ts's setStatus.
  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("tasks")
    .update({
      status,
      resolved_at: status === "done" || status === "dismissed" ? new Date().toISOString() : null,
      snoozed_until: null,
    })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not update status: ${error.message}`);
  }
  if (!row) {
    throw new Error("Could not update this task. You may not have permission to change it.");
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
  await requirePermission("task.update", projectScope(projectId));

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("tasks")
    .update({ priority })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not update priority: ${error.message}`);
  }
  if (!row) {
    throw new Error("Could not update this task. You may not have permission to change it.");
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
  await requirePermission("task.assign", projectScope(projectId));

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
  const { data: row, error } = await supabase
    .from("tasks")
    .update({
      assignee_id: target?.kind === "user" ? target.id : null,
      assignee_team_member_id: target?.kind === "team_member" ? target.id : null,
    })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not update assignee: ${error.message}`);
  }
  if (!row) {
    throw new Error("Could not assign this task. You may not have permission to change it.");
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
  await requirePermission("task.update", projectScope(projectId));

  const parsed = snoozeSchema.safeParse({ snoozedUntil: snoozedUntilDate });
  if (!parsed.success) {
    throw new Error("Please choose a valid date.");
  }
  // A plain <input type="date"> gives "YYYY-MM-DD" with no time component;
  // anchoring to end-of-day is a POC-level approximation — exact per-project
  // timezone handling (like for_date already does) isn't in scope here.
  const snoozedUntilIso = new Date(`${parsed.data.snoozedUntil}T23:59:59`).toISOString();

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("tasks")
    .update({ status: "snoozed", snoozed_until: snoozedUntilIso, resolved_at: null })
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not snooze: ${error.message}`);
  }
  if (!row) {
    throw new Error("Could not snooze this task. You may not have permission to change it.");
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: `Snoozed until ${parsed.data.snoozedUntil}` };
}

/**
 * Live retrieval for the "Find related" action — the human-in-the-loop
 * replacement for the model's old auto-citation channel (see
 * PROMPT_VERSION's "v5" note in lib/llm/prompt.ts). Read-only: this never
 * writes anything, so it needs no service-role escalation, unlike
 * linkTaskSource/unlinkTaskSource below.
 */
export async function findRelatedForTask(workspaceId: string, projectId: string, itemId: string): Promise<{ candidates: RelatedCandidate[] }> {
  await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);
  const supabase = await createClient();

  const { data: task } = await supabase
    .from("tasks")
    .select("id, title, description")
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!task) {
    throw new Error("Task not found.");
  }

  // Every existing source, any role — a candidate must never duplicate a
  // row already shown in the Source panel, whether the model created it or
  // a PM linked it earlier.
  const { data: existingSources } = await supabase.from("task_sources").select("normalized_event_id").eq("task_id", itemId);
  const excludeNormalizedEventIds = (existingSources ?? []).map((row) => row.normalized_event_id);

  const candidates = await findRelatedCandidates(createServiceClient(), {
    clientSpaceId: scope.clientSpaceId,
    projectId,
    queryText: buildTaskQueryText(task),
    excludeNormalizedEventIds,
  });

  return { candidates };
}

/**
 * The "Link" action. task_sources insert/update, tasks.description update,
 * and llm_runs are all privileges `authenticated` deliberately does not
 * have (see task_sources'/tasks' own migration comments) — so, mirroring
 * components/items/attachment-actions.ts's getAttachmentPreviewUrl exactly,
 * every value below is resolved and validated through the USER-scoped
 * client first (RLS IS the authorization check), and only THEN handed to
 * the service-role orchestration in services/tasks/enrich.ts. A candidate's
 * chunkId/normalizedEventId come from the client — see the chunk-resolves-
 * to-event check below for why that's safe: a forged pair simply fails to
 * resolve and throws, never silently linking the wrong thing.
 */
export async function linkTaskSource(
  workspaceId: string,
  projectId: string,
  itemId: string,
  candidate: Pick<RelatedCandidate, "chunkId" | "normalizedEventId">,
): Promise<LinkTaskSourceResult> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);
  const supabase = await createClient();

  const { data: task } = await supabase
    .from("tasks")
    .select("id, title, kind, description")
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!task) {
    throw new Error("Task not found.");
  }

  const { data: event } = await supabase
    .from("normalized_events")
    .select("id")
    .eq("id", candidate.normalizedEventId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!event) {
    throw new Error("That item is no longer available — try searching again.");
  }

  // Re-fetched here rather than trusted from the client's own copy of the
  // candidate: the content that reaches the LLM prompt and the row written
  // to task_sources.chunk_id must be what THIS client space's data actually
  // says, not whatever the client echoed back.
  const { data: chunk } = await supabase
    .from("search_chunks")
    .select("id, source_kind, source_id, content, title, occurred_at")
    .eq("id", candidate.chunkId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!chunk) {
    throw new Error("That item is no longer available — try searching again.");
  }

  // The chunk must actually resolve to the claimed event — mirrors
  // match_search_chunks' own citable_event_id resolution rule (a
  // normalized_event chunk's source_id IS its event id; an event_attachment
  // chunk's source_id is the attachment's own id, resolved one hop further).
  // A context_document chunk (neither arm) can never resolve, matching
  // task_sources.normalized_event_id's NOT NULL constraint.
  let resolvesToEvent = false;
  if (chunk.source_kind === "normalized_event") {
    resolvesToEvent = chunk.source_id === candidate.normalizedEventId;
  } else if (chunk.source_kind === "event_attachment") {
    const { data: attachment } = await supabase
      .from("event_attachments")
      .select("normalized_event_id")
      .eq("id", chunk.source_id)
      .eq("client_space_id", scope.clientSpaceId)
      .maybeSingle();
    resolvesToEvent = attachment?.normalized_event_id === candidate.normalizedEventId;
  }
  if (!resolvesToEvent) {
    throw new Error("That item doesn't match this task's activity — try refreshing and searching again.");
  }

  const { data: project } = await supabase.from("projects").select("name, description").eq("id", projectId).maybeSingle();
  if (!project) {
    throw new Error("Project not found.");
  }

  const result = await linkAndEnrichTaskSource(createServiceClient(), getLLMProvider(), {
    tenantId: scope.tenantId,
    clientSpaceId: scope.clientSpaceId,
    taskId: itemId,
    normalizedEventId: candidate.normalizedEventId,
    chunkId: candidate.chunkId,
    linkedBy: user.id,
    task: { title: task.title, kind: task.kind, description: task.description },
    project: { id: projectId, name: project.name, description: project.description, timezone: scope.timezone },
    newContext: {
      sourceKind: chunk.source_kind,
      title: chunk.title,
      content: chunk.content,
      occurredAt: chunk.occurred_at,
    },
  });

  revalidateTaskManagement(workspaceId, projectId);
  return result;
}

/**
 * Only a PM-added link may be removed — a model-written created_from/
 * mentioned row is read-only provenance (see task_sources.linked_by's own
 * migration comment). The `linked_by is not null` check happens twice: once
 * through the user client below (so a row that isn't unlinkable never even
 * reaches the delete), and again as a belt-and-braces filter on the delete
 * itself, matching this codebase's existing re-assertion style (see
 * 20260901001400_service_role_grants.sql's own "Belt-and-braces" section).
 */
export async function unlinkTaskSource(workspaceId: string, projectId: string, itemId: string, normalizedEventId: string): Promise<{ message: string }> {
  await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);
  const supabase = await createClient();

  const { data: task } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", itemId)
    .eq("project_id", projectId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!task) {
    throw new Error("Task not found.");
  }

  const { data: source } = await supabase
    .from("task_sources")
    .select("linked_by")
    .eq("task_id", itemId)
    .eq("normalized_event_id", normalizedEventId)
    .maybeSingle();
  if (!source?.linked_by) {
    throw new Error("This source can't be unlinked.");
  }

  const { error } = await createServiceClient()
    .from("task_sources")
    .delete()
    .eq("task_id", itemId)
    .eq("normalized_event_id", normalizedEventId)
    .not("linked_by", "is", null);
  if (error) {
    throw new Error(`Could not unlink: ${error.message}`);
  }

  revalidateTaskManagement(workspaceId, projectId);
  return { message: "Unlinked" };
}
