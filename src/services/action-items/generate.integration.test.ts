import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { runSync } from "@/services/sync/run-sync";
import { getLLMProvider } from "@/lib/llm/factory";
import { projectToday } from "@/lib/date/project-day";
import type { DraftForConsolidation } from "@/lib/llm/types";
import { generateActionItems } from "./generate";

/**
 * Exercises the real LLM pipeline: mock-connector events -> normalize ->
 * a genuine Claude Haiku 4.5 call -> action_items, against the real local
 * Supabase instance and the real Anthropic API (using the API key in
 * .env.local). This costs a small, real amount of money — a handful of
 * short synthetic messages through Haiku 4.5 is a fraction of a cent — but
 * it's the only way to actually prove the structured-output parsing, the
 * dedupe-by-title merge logic, and the llm_runs bookkeeping work end to end.
 */
describe("generateActionItems (real Anthropic call, real local DB)", () => {
  const service = createServiceClient();
  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let integrationId: string;

  beforeAll(async () => {
    const email = `llm-integration-test-${Date.now()}@example.com`;
    const { data: authUser, error: authError } = await service.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`Failed to create test user: ${authError?.message}`);
    userId = authUser.user.id;

    const { data: workspace, error: workspaceError } = await service
      .from("workspaces")
      .insert({ name: "LLM Integration Test", slug: `llm-itest-${Date.now()}`, owner_id: userId })
      .select("id")
      .single();
    if (workspaceError || !workspace) throw new Error(`Failed to create test workspace: ${workspaceError?.message}`);
    workspaceId = workspace.id;

    const { data: project, error: projectError } = await service
      .from("projects")
      .insert({ workspace_id: workspaceId, name: "Test Project", slug: "test-project", created_by: userId })
      .select("id")
      .single();
    if (projectError || !project) throw new Error(`Failed to create test project: ${projectError?.message}`);
    projectId = project.id;

    const { data: integration, error: integrationError } = await service
      .from("integrations")
      .insert({
        workspace_id: workspaceId,
        project_id: projectId,
        provider: "mock",
        status: "connected",
        display_name: "Mock (sample data)",
        connected_by: userId,
      })
      .select("id")
      .single();
    if (integrationError || !integration) throw new Error(`Failed to create test integration: ${integrationError?.message}`);
    integrationId = integration.id;

    // Populate normalized_events for the LLM step to consume.
    const syncResult = await runSync(integrationId, "manual");
    if (syncResult.status !== "succeeded") throw new Error(`Setup sync failed: ${syncResult.error}`);
  }, 30000);

  afterAll(async () => {
    await service.from("workspaces").delete().eq("id", workspaceId);
    await service.auth.admin.deleteUser(userId);
  });

  it("generates action items from real events via a real Haiku 4.5 call", async () => {
    // The mock connector stamps occurredAt as "now" — the test project
    // defaults to timezone 'UTC' (projects.timezone's column default), so
    // projectToday("UTC") always matches.
    const result = await generateActionItems(projectId, projectToday("UTC"));

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeUndefined();

    const { data: run } = await service
      .from("llm_runs")
      .select("status, model, prompt_tokens, completion_tokens, cost_usd, input_event_ids")
      .eq("project_id", projectId)
      .single();
    expect(run?.status).toBe("succeeded");
    expect(run?.model).toBe("claude-haiku-4-5");
    expect(run?.prompt_tokens).toBeGreaterThan(0);
    expect(run?.completion_tokens).toBeGreaterThan(0);
    expect(run?.cost_usd).toBeGreaterThan(0);
    expect(run?.input_event_ids).toHaveLength(5);

    // All 5 mock events were "seen" by the model even if not every one
    // produced an action item — the whole point of processed_at is that
    // the backlog doesn't get re-sent forever.
    const { data: events } = await service.from("normalized_events").select("processed_at").eq("project_id", projectId);
    expect(events?.every((e) => e.processed_at !== null)).toBe(true);
  }, 30000);

  it("is a clean skip when there are no unprocessed events left", async () => {
    const result = await generateActionItems(projectId, projectToday("UTC"));
    expect(result).toEqual({ status: "skipped", itemsCreated: 0, itemsMerged: 0 });
  });

  it("merging: re-running against fresh events with the same open items doesn't duplicate", async () => {
    const { count: beforeTotal } = await service
      .from("action_items")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);

    const syncResult = await runSync(integrationId, "manual");
    expect(syncResult.status).toBe("succeeded");

    const result = await generateActionItems(projectId, projectToday("UTC"));
    expect(result.status).toBe("succeeded");

    const { data: allItems } = await service.from("action_items").select("id, title").eq("project_id", projectId);
    const titles = allItems?.map((i) => i.title) ?? [];
    // If merging worked, titles stay unique even though the model saw a
    // fresh batch of the *same* synthetic conversation topics again.
    expect(new Set(titles).size).toBe(titles.length);
    expect(allItems?.length ?? 0).toBeGreaterThanOrEqual(beforeTotal ?? 0);
  }, 30000);

  it("consolidateActionItems merges near-duplicate drafts describing the same underlying issue", async () => {
    const provider = getLLMProvider();
    const drafts: DraftForConsolidation[] = [
      {
        key: "d1",
        draft: {
          kind: "blocker",
          title: "Checkout tests are flaky",
          description: "The checkout flow's CI test suite fails intermittently, blocking merges.",
          priority: "high",
          confidence: 0.8,
          sourceEventIds: [],
        },
      },
      {
        key: "d2",
        draft: {
          kind: "blocker",
          title: "Intermittent failures in the checkout end-to-end suite",
          description: "QA reports the checkout e2e tests fail roughly 1 in 5 runs.",
          priority: "high",
          confidence: 0.75,
          sourceEventIds: [],
        },
      },
      {
        key: "d3",
        draft: {
          kind: "action",
          title: "Update the onboarding docs",
          description: "Docs still reference the old signup flow.",
          priority: "low",
          confidence: 0.6,
          sourceEventIds: [],
        },
      },
    ];

    const result = await provider.consolidateActionItems([], drafts);

    // d1 and d2 describe the same underlying flaky-test issue; d3 is
    // unrelated. Real semantic dedup should collapse the first two into one
    // group while leaving the third on its own.
    expect(result.consolidation.groups).toHaveLength(2);
    const flakyGroup = result.consolidation.groups.find((g) => g.draftKeys.includes("d1"));
    expect(flakyGroup?.draftKeys.sort()).toEqual(["d1", "d2"]);
    const docsGroup = result.consolidation.groups.find((g) => g.draftKeys.includes("d3"));
    expect(docsGroup?.draftKeys).toEqual(["d3"]);
  }, 30000);
});
