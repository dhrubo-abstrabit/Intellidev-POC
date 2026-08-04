import "server-only";
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { getLLMProvider } from "@/lib/llm/factory";
import { estimateCostUsd } from "@/lib/llm/pricing";
import { uuidv7 } from "@/lib/db/uuid";
import type { ActionItemContext } from "@/lib/llm/types";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

const PROMPT_VERSION = "action-items-v1";
// Bounds one run's cost/latency; the unprocessed-events partial index makes
// pulling the oldest backlog first cheap, so a large backlog just means more
// runs, not a slower single run.
const MAX_EVENTS_PER_RUN = 200;

export interface GenerateActionItemsResult {
  status: "succeeded" | "skipped" | "failed";
  itemsCreated: number;
  itemsMerged: number;
  error?: string;
}

/** dedupe_hash is a hash of the item's own (normalized) title — there is no
 * separate model-invented key. Reusing an open item's exact title is what
 * makes two runs produce the same hash and merge instead of duplicating. */
function normalizedTitleHash(title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex");
}

function projectLocalDate(timezone: string): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the date column's shape.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

async function loadContext(
  service: ServiceClient,
  project: Pick<Database["public"]["Tables"]["projects"]["Row"], "id" | "name" | "description" | "timezone">,
): Promise<{ context: ActionItemContext; eventIds: string[] } | null> {
  const { data: unprocessedEvents } = await service
    .from("normalized_events")
    .select("id, type, actor_display, actor, title, body, occurred_at")
    .eq("project_id", project.id)
    .is("processed_at", null)
    .order("occurred_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (!unprocessedEvents || unprocessedEvents.length === 0) {
    return null;
  }

  const { data: openItems } = await service
    .from("action_items")
    .select("title, kind, priority")
    .eq("project_id", project.id)
    .in("status", ["pending", "in_progress"]);

  const { data: recentSummaries } = await service
    .from("daily_summaries")
    .select("summary_date, summary")
    .eq("project_id", project.id)
    .order("summary_date", { ascending: false })
    .limit(3);

  return {
    eventIds: unprocessedEvents.map((e) => e.id),
    context: {
      project: { id: project.id, name: project.name, description: project.description, timezone: project.timezone },
      openActionItems: (openItems ?? []).map((i) => ({ title: i.title, kind: i.kind, priority: i.priority })),
      recentSummaries: (recentSummaries ?? []).map((s) => ({ date: s.summary_date, summary: s.summary })),
      newEvents: unprocessedEvents.map((e) => ({
        id: e.id,
        type: e.type,
        actorDisplay: e.actor_display ?? e.actor,
        title: e.title,
        body: e.body,
        occurredAt: e.occurred_at,
      })),
    },
  };
}

/**
 * Generates (or refines) action items for one project from whatever
 * normalized_events haven't been through the model yet. Safe to call
 * repeatedly: events are marked processed_at regardless of whether they
 * produced an item, and items merge onto existing open rows by title hash
 * rather than duplicating — see normalizedTitleHash above.
 */
export async function generateActionItems(projectId: string): Promise<GenerateActionItemsResult> {
  const service = createServiceClient();

  const { data: project } = await service
    .from("projects")
    .select("id, workspace_id, name, description, timezone")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) {
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: "Project not found" };
  }

  const loaded = await loadContext(service, project);
  if (!loaded) {
    return { status: "skipped", itemsCreated: 0, itemsMerged: 0 };
  }
  const { context, eventIds } = loaded;

  const { data: run, error: runError } = await service
    .from("llm_runs")
    .insert({
      workspace_id: project.workspace_id,
      project_id: project.id,
      kind: "action_items",
      status: "running",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      prompt_version: PROMPT_VERSION,
      input_event_ids: eventIds,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (runError || !run) {
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: runError?.message };
  }

  try {
    const provider = getLLMProvider();
    const generation = await provider.generateActionItems(context);

    const validEventIds = new Set(eventIds);
    const forDate = projectLocalDate(project.timezone);

    const candidateHashes = generation.items.map((item) => normalizedTitleHash(item.title));
    const { data: existingOpen } = candidateHashes.length
      ? await service
          .from("action_items")
          .select("id, dedupe_hash")
          .eq("project_id", project.id)
          .in("status", ["pending", "in_progress"])
          .in("dedupe_hash", candidateHashes)
      : { data: [] as { id: string; dedupe_hash: string }[] };
    const existingByHash = new Map((existingOpen ?? []).map((row) => [row.dedupe_hash, row.id]));

    let itemsCreated = 0;
    let itemsMerged = 0;
    const sourceLinks: Database["public"]["Tables"]["action_item_source_events"]["Insert"][] = [];

    for (const item of generation.items) {
      const hash = normalizedTitleHash(item.title);
      const existingId = existingByHash.get(hash);
      const sourceEventIds = item.sourceEventIds.filter((id) => validEventIds.has(id));

      if (existingId) {
        await service
          .from("action_items")
          .update({
            description: item.description ?? null,
            priority: item.priority,
            confidence_score: item.confidence,
            owner_hint: item.ownerHint ?? null,
            llm_run_id: run.id,
            generated_at: new Date().toISOString(),
          })
          .eq("id", existingId);
        itemsMerged += 1;
        sourceLinks.push(
          ...sourceEventIds.map((eventId) => ({
            action_item_id: existingId,
            normalized_event_id: eventId,
            workspace_id: project.workspace_id,
          })),
        );
      } else {
        const newId = uuidv7();
        await service.from("action_items").insert({
          id: newId,
          workspace_id: project.workspace_id,
          project_id: project.id,
          llm_run_id: run.id,
          kind: item.kind,
          title: item.title,
          description: item.description ?? null,
          priority: item.priority,
          confidence_score: item.confidence,
          owner_hint: item.ownerHint ?? null,
          dedupe_hash: hash,
          for_date: forDate,
        });
        itemsCreated += 1;
        sourceLinks.push(
          ...sourceEventIds.map((eventId) => ({
            action_item_id: newId,
            normalized_event_id: eventId,
            workspace_id: project.workspace_id,
          })),
        );
      }
    }

    if (sourceLinks.length > 0) {
      // (action_item_id, normalized_event_id) is the primary key — a
      // redelivered/rerun job citing the same event again is a harmless
      // no-op, not a duplicate-key error, as long as we ignore conflicts.
      await service.from("action_item_source_events").upsert(sourceLinks, {
        onConflict: "action_item_id,normalized_event_id",
        ignoreDuplicates: true,
      });
    }

    // Mark every event this run looked at as processed, whether or not it
    // produced an item — otherwise the next run re-sends it to the model
    // forever and never converges on "nothing new".
    const nowIso = new Date().toISOString();
    await service.from("normalized_events").update({ processed_at: nowIso }).in("id", eventIds);

    await service
      .from("llm_runs")
      .update({
        status: "succeeded",
        finished_at: nowIso,
        prompt: generation.prompt as Database["public"]["Tables"]["llm_runs"]["Update"]["prompt"],
        response: generation.response as Database["public"]["Tables"]["llm_runs"]["Update"]["response"],
        prompt_tokens: generation.usage.promptTokens,
        completion_tokens: generation.usage.completionTokens,
        cache_read_tokens: generation.usage.cacheReadTokens,
        cache_creation_tokens: generation.usage.cacheCreationTokens,
        cost_usd: estimateCostUsd(generation.usage),
      })
      .eq("id", run.id);

    return { status: "succeeded", itemsCreated, itemsMerged };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await service
      .from("llm_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message })
      .eq("id", run.id);
    return { status: "failed", itemsCreated: 0, itemsMerged: 0, error: message };
  }
}
