import "server-only";
import { estimateCostUsd } from "@/lib/llm/pricing";
import { ENRICH_PROMPT_VERSION } from "@/lib/llm/prompt";
import type { LLMProvider, TaskEnrichmentContext } from "@/lib/llm/types";
import type { createServiceClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface LinkTaskSourceArgs {
  tenantId: string;
  clientSpaceId: string;
  taskId: string;
  normalizedEventId: string;
  chunkId: string;
  /** The user who clicked "Link" — written to task_sources.linked_by,
   * which is what distinguishes this row from a model-written one (see
   * that column's own comment in the migration) and what gates the unlink
   * action in Task Tracking's UI. */
  linkedBy: string;
  task: TaskEnrichmentContext["task"];
  project: TaskEnrichmentContext["project"];
  newContext: TaskEnrichmentContext["newContext"];
}

export type LinkTaskSourceResult =
  | { status: "linked"; message: string }
  | { status: "linked_no_change"; message: string }
  | { status: "linked_no_rewrite"; message: string }
  | { status: "already_linked"; message: string };

/**
 * The service-role orchestration behind Task Tracking's "Link" action — see
 * the plan this implements for the full failure-mode reasoning. Every value
 * written here is assumed ALREADY VALIDATED by the caller (a Server Action
 * that resolved `task`/`project`/`normalizedEventId`/`chunkId` through the
 * user-scoped client, so RLS was the authorization check — mirroring
 * components/items/attachment-actions.ts's getAttachmentPreviewUrl). This
 * function never re-derives authorization; it only performs privileged
 * writes task_sources/tasks/llm_runs grant no other way to make.
 *
 * THE LINK PERSISTS even when everything after it fails. It is the PM's
 * explicit assertion of provenance; the description rewrite below is
 * enrichment layered on top, not a precondition for the link to be real.
 * Rolling the link back on an LLM failure would destroy that intent to
 * preserve a cosmetic invariant, and isn't atomic anyway.
 */
export async function linkAndEnrichTaskSource(
  service: ServiceClient,
  provider: LLMProvider,
  args: LinkTaskSourceArgs,
): Promise<LinkTaskSourceResult> {
  // A plain INSERT, not an upsert: (task_id, normalized_event_id) is the
  // primary key, so this doubles as the double-click guard — a loser hits
  // 23505 here, before either an llm_runs row or a provider call exists.
  // Never upgrade an existing row's role to 'enriched' on conflict — that
  // would rewrite model provenance and make linked_by lie about who
  // created the link.
  const { error: insertError } = await service.from("task_sources").insert({
    task_id: args.taskId,
    normalized_event_id: args.normalizedEventId,
    client_space_id: args.clientSpaceId,
    chunk_id: args.chunkId,
    role: "enriched",
    linked_by: args.linkedBy,
    relevance: null,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      return { status: "already_linked", message: "Already linked to this task." };
    }
    throw new Error(`task_sources insert failed: ${insertError.message}`);
  }

  // Inserted status:'running' BEFORE the call, same as
  // services/action-items/generate.ts's llm_runs insert — an audit trail
  // reachable from the link even if the call never returns.
  const { data: run, error: runError } = await service
    .from("llm_runs")
    .insert({
      tenant_id: args.tenantId,
      client_space_id: args.clientSpaceId,
      kind: "enrich_task",
      status: "running",
      model: provider.model,
      provider: provider.id,
      prompt_version: ENRICH_PROMPT_VERSION,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (runError || !run) {
    console.error(`[tasks] enrich: llm_runs insert failed for task ${args.taskId}:`, runError);
    return { status: "linked_no_rewrite", message: "Linked. Couldn't start the description refresh — try again." };
  }

  await service.from("task_sources").update({ llm_run_id: run.id }).eq("task_id", args.taskId).eq("normalized_event_id", args.normalizedEventId);

  try {
    const result = await provider.enrichTaskDescription({
      project: args.project,
      task: args.task,
      newContext: args.newContext,
    });

    const nowIso = new Date().toISOString();
    // Re-checked here, never trusted from the flag alone: an empty or
    // identical description is treated as no-op even if the model claimed
    // changed:true.
    const currentDescription = args.task.description ?? "";
    const shouldUpdate =
      result.enrichment.changed &&
      result.enrichment.description.trim().length > 0 &&
      result.enrichment.description !== currentDescription;

    if (shouldUpdate) {
      await service
        .from("tasks")
        .update({ description: result.enrichment.description, llm_run_id: run.id, generated_at: nowIso })
        .eq("id", args.taskId);
    }

    await service
      .from("llm_runs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        prompt: result.prompt as Database["public"]["Tables"]["llm_runs"]["Update"]["prompt"],
        response: result.response as Database["public"]["Tables"]["llm_runs"]["Update"]["response"],
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        cache_read_tokens: result.usage.cacheReadTokens,
        cache_creation_tokens: result.usage.cacheCreationTokens,
        cost_usd: estimateCostUsd(result.usage, provider.model),
      })
      .eq("id", run.id);

    return shouldUpdate
      ? { status: "linked", message: "Linked and updated the description." }
      : { status: "linked_no_change", message: "Linked — no description change needed." };
  } catch (err) {
    // description is left UNTOUCHED — this is the failure path the link's
    // persistence is designed around. A Vercel 504 mid-call leaves this run
    // stuck at 'running' forever, same inherited wart generate.ts already
    // has; not fixed here.
    const message = err instanceof Error ? err.message : String(err);
    await service
      .from("llm_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message })
      .eq("id", run.id);
    return { status: "linked_no_rewrite", message: "Linked. Couldn't refresh the description — try again." };
  }
}
