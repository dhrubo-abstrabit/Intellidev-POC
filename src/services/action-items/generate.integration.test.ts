import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { runSync } from "@/services/sync/run-sync";
import { getLLMProvider } from "@/lib/llm/factory";
import { projectToday } from "@/lib/date/project-day";
import type { DraftForConsolidation } from "@/lib/llm/types";
import { generateActionItems } from "./generate";

/**
 * Exercises the real LLM pipeline: mock-connector events -> normalize ->
 * a genuine Claude Haiku 4.5 call -> tasks, against the real local
 * Supabase instance and the real Anthropic API (using the API key in
 * .env.local). This costs a small, real amount of money — a handful of
 * short synthetic messages through Haiku 4.5 is a fraction of a cent — but
 * it's the only way to actually prove the structured-output parsing, the
 * dedupe-by-title merge logic, and the llm_runs bookkeeping work end to end.
 */
describe("generateActionItems (real Anthropic call, real local DB)", () => {
  const service = createServiceClient();
  let userId: string;
  let tenantId: string;
  let clientSpaceId: string;
  let projectConnectorId: string;

  beforeAll(async () => {
    const email = `llm-integration-test-${Date.now()}@example.com`;
    const { data: authUser, error: authError } = await service.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`Failed to create test user: ${authError?.message}`);
    userId = authUser.user.id;

    // Full 4-level chain: a workspace can't exist without a tenant above it,
    // and a project connector can't exist without a client space above it
    // (see src/lib/scope.ts). Neither tenants nor workspaces carries
    // owner_id — ownership is tenant_members.role='owner'/
    // workspace_members.role='admin', normally granted atomically by
    // handle_new_tenant/handle_new_workspace, which both no-op under a
    // service-role insert (auth.uid() is null with no session) — harmless
    // here since nothing in this test's path FKs to those roster tables.
    const { data: tenant, error: tenantError } = await service
      .from("tenants")
      .insert({ name: "LLM Integration Test", slug: `llm-itest-${Date.now()}` })
      .select("id")
      .single();
    if (tenantError || !tenant) throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
    tenantId = tenant.id;

    const { data: workspace, error: workspaceError } = await service
      .from("workspaces")
      .insert({ tenant_id: tenantId, name: "LLM Integration Test", slug: `llm-itest-${Date.now()}` })
      .select("id")
      .single();
    if (workspaceError || !workspace) throw new Error(`Failed to create test workspace: ${workspaceError?.message}`);
    const workspaceId = workspace.id;

    const { data: clientSpace, error: clientSpaceError } = await service
      .from("client_spaces")
      .insert({ workspace_id: workspaceId, tenant_id: tenantId, name: "Test Client Space", slug: "test-client-space" })
      .select("id")
      .single();
    if (clientSpaceError || !clientSpace) throw new Error(`Failed to create test client space: ${clientSpaceError?.message}`);
    clientSpaceId = clientSpace.id;

    const { data: project, error: projectError } = await service
      .from("projects")
      .insert({ client_space_id: clientSpaceId, workspace_id: workspaceId, name: "Test Project", slug: "test-project", created_by: userId })
      .select("id")
      .single();
    if (projectError || !project) throw new Error(`Failed to create test project: ${projectError?.message}`);
    const projectId = project.id;

    // Two writes, not one: space_connections (the grant, client-space scoped)
    // and project_connectors (this project's scoping of it) — see
    // supabase/migrations/20260901000800_connectors.sql.
    const { data: connection, error: connectionError } = await service
      .from("space_connections")
      .insert({
        client_space_id: clientSpaceId,
        provider: "mock",
        auth_mode: "none",
        external_account_id: "mock",
        external_account_label: "Mock workspace",
        status: "connected",
        connected_by: userId,
      })
      .select("id")
      .single();
    if (connectionError || !connection) throw new Error(`Failed to create test space connection: ${connectionError?.message}`);

    const { data: projectConnector, error: projectConnectorError } = await service
      .from("project_connectors")
      .insert({
        client_space_id: clientSpaceId,
        project_id: projectId,
        connection_id: connection.id,
        provider: "mock",
        sync_enabled: true,
        created_by: userId,
      })
      .select("id")
      .single();
    if (projectConnectorError || !projectConnector) {
      throw new Error(`Failed to create test project connector: ${projectConnectorError?.message}`);
    }
    projectConnectorId = projectConnector.id;

    // Populate normalized_events for the LLM step to consume.
    const syncResult = await runSync(projectConnectorId, "manual");
    if (syncResult.status !== "succeeded") throw new Error(`Setup sync failed: ${syncResult.error}`);
  }, 30000);

  afterAll(async () => {
    // Deleting the tenant cascades through workspaces, client_spaces,
    // projects, and everything keyed under them.
    await service.from("tenants").delete().eq("id", tenantId);
    await service.auth.admin.deleteUser(userId);
  });

  it("generates action items from real events via a real Haiku 4.5 call", async () => {
    // The mock connector stamps occurredAt as "now" — the test client space
    // defaults to timezone 'UTC' (client_spaces.timezone's column default),
    // so projectToday("UTC") always matches.
    const result = await generateActionItems(clientSpaceId, projectToday("UTC"));

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeUndefined();

    // input_event_ids was dropped from llm_runs in the v2 rebuild in favor
    // of task_sources, which records provenance per TASK, not per run — see
    // generate.ts's own comment on llm_runs.kind. That's a narrower
    // guarantee than "every event was fed to the model" (an event the model
    // judged not task-worthy never appears in task_sources at all), so it's
    // not a like-for-like replacement here. The assertion below on
    // processed_at is what's left to prove every seeded event was actually
    // sent to the model, deterministically, regardless of what it decided to
    // do with each one.
    const { data: run } = await service
      .from("llm_runs")
      .select("status, model, prompt_tokens, completion_tokens, cost_usd")
      .eq("client_space_id", clientSpaceId)
      .single();
    expect(run?.status).toBe("succeeded");
    expect(run?.model).toBe("claude-haiku-4-5");
    expect(run?.prompt_tokens).toBeGreaterThan(0);
    expect(run?.completion_tokens).toBeGreaterThan(0);
    expect(run?.cost_usd).toBeGreaterThan(0);

    // All 5 mock events were "seen" by the model even if not every one
    // produced an action item — the whole point of processed_at is that
    // the backlog doesn't get re-sent forever.
    const { data: events } = await service.from("normalized_events").select("processed_at").eq("client_space_id", clientSpaceId);
    expect(events).toHaveLength(5);
    expect(events?.every((e) => e.processed_at !== null)).toBe(true);
  }, 30000);

  it("is a clean skip when there are no unprocessed events left", async () => {
    const result = await generateActionItems(clientSpaceId, projectToday("UTC"));
    expect(result).toEqual({ status: "skipped", itemsCreated: 0, itemsMerged: 0 });
  });

  it("merging: re-running against fresh events with the same open items doesn't duplicate", async () => {
    const { count: beforeTotal } = await service
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("client_space_id", clientSpaceId);

    const syncResult = await runSync(projectConnectorId, "manual");
    expect(syncResult.status).toBe("succeeded");

    const result = await generateActionItems(clientSpaceId, projectToday("UTC"));
    expect(result.status).toBe("succeeded");

    const { data: allItems } = await service.from("tasks").select("id, title").eq("client_space_id", clientSpaceId);
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
