import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { runSync } from "@/services/sync/run-sync";
import { getLLMProvider } from "@/lib/llm/factory";
import { ANTHROPIC_MODEL } from "@/lib/llm/anthropic";
import { OPENAI_MODEL } from "@/lib/llm/openai";
import { embedOne, toVectorLiteral, EMBEDDING_MODEL } from "@/services/search/embed";
import { contentHash } from "@/services/search/chunk";
import { projectToday } from "@/lib/date/project-day";
import { uuidv7 } from "@/lib/db/uuid";
import type { DraftForConsolidation } from "@/lib/llm/types";
import { generateActionItems } from "./generate";

const EXPECTED_MODEL: Record<string, string> = { anthropic: ANTHROPIC_MODEL, openai: OPENAI_MODEL };

/**
 * Exercises the real LLM pipeline: mock-connector events -> normalize ->
 * a genuine LLM call (whichever provider LLM_PROVIDER resolves to — see
 * src/lib/env.ts) -> tasks, against the real local Supabase instance and
 * the real provider API (using the credentials in .env.local). This costs
 * a small, real amount of money — a handful of short synthetic messages
 * through either provider is a fraction of a cent — but it's the only way
 * to actually prove the structured-output parsing, the dedupe-by-title
 * merge logic, and the llm_runs bookkeeping work end to end.
 */
describe("generateActionItems (real LLM call, real local DB)", () => {
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

  it("generates action items from real events via a real LLM call, with retrieval genuinely best-effort", async () => {
    const provider = getLLMProvider();

    // No search_chunks exist yet at this point in the suite — proves
    // retrieval degrades gracefully to "no RELATED CONTEXT" rather than
    // being accidentally load-bearing for extraction to succeed at all.
    const { count: chunkCountBefore } = await service
      .from("search_chunks")
      .select("id", { count: "exact", head: true })
      .eq("client_space_id", clientSpaceId);
    expect(chunkCountBefore ?? 0).toBe(0);

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
      .select("status, model, provider, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, prompt")
      .eq("client_space_id", clientSpaceId)
      .single();
    expect(run?.status).toBe("succeeded");
    // Regression guard on the historical bug where llm_runs.model/.provider
    // were hardcoded to "claude-haiku-4-5"/"anthropic" regardless of which
    // provider actually ran.
    expect(run?.model).toBe(EXPECTED_MODEL[provider.id]);
    expect(run?.provider).toBe(provider.id);
    expect(run?.prompt_tokens).toBeGreaterThan(0);
    expect(run?.completion_tokens).toBeGreaterThan(0);
    // Never negative regardless of provider — see mapUsage's own doc
    // comment in lib/llm/openai.ts on why this could go wrong for OpenAI
    // specifically (input_tokens includes cached/cache-write tokens there).
    expect(run?.cache_read_tokens).toBeGreaterThanOrEqual(0);
    expect(run?.cache_creation_tokens).toBeGreaterThanOrEqual(0);
    expect(run?.cost_usd).toBeGreaterThan(0);
    // No RELATED CONTEXT section should appear in the logged prompt — an
    // empty labeled section is pure token cost, and there was nothing to
    // retrieve (see the search_chunks count assertion above).
    expect(JSON.stringify(run?.prompt)).not.toContain("RELATED CONTEXT");

    // All 5 mock events were "seen" by the model even if not every one
    // produced an action item — the whole point of processed_at is that
    // the backlog doesn't get re-sent forever.
    const { data: events } = await service.from("normalized_events").select("processed_at").eq("client_space_id", clientSpaceId);
    expect(events).toHaveLength(5);
    expect(events?.every((e) => e.processed_at !== null)).toBe(true);
  }, 60000);

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
  }, 60000);

  it("merges a differently-worded follow-up onto an already-open task instead of duplicating it (regression test for the reported cross-day duplicate bug)", async () => {
    const { data: project } = await service.from("projects").select("id").eq("client_space_id", clientSpaceId).single();
    if (!project) throw new Error("expected a project for this client space");

    // Fixed, out-of-band dates — distinct from projectToday("UTC"), which the
    // other tests in this suite use for the mock connector's own events, so
    // this test's rows never collide with theirs.
    const day1 = "2026-01-01";
    const day2 = "2026-01-02";

    async function seedEvent(date: string, dedupeKey: string, title: string, body: string) {
      const { error } = await service.from("normalized_events").insert({
        id: uuidv7(),
        client_space_id: clientSpaceId,
        project_id: project!.id,
        project_connector_id: projectConnectorId,
        provider: "mock",
        type: "mock.message",
        title,
        body,
        occurred_at: `${date}T12:00:00Z`,
        dedupe_key: dedupeKey,
      });
      if (error) throw new Error(`failed to seed normalized_events row: ${error.message}`);
    }

    // Mirrors the real production pair this test guards against: two
    // messages, worded differently, about the same underlying issue, on two
    // different days.
    await seedEvent(
      day1,
      "cross-day-dedupe-test-day1",
      "Embedding model decision needed",
      "We still need to pick between OpenAI's text-embedding-3-small and Qwen3-Embedding-0.6B (dimension 1024) for the search index before moving forward — nobody has made the call yet.",
    );
    const day1Result = await generateActionItems(clientSpaceId, day1);
    expect(day1Result.status).toBe("succeeded");
    expect(day1Result.itemsCreated).toBe(1);

    const { data: day1Tasks } = await service.from("tasks").select("id, title").eq("client_space_id", clientSpaceId).eq("for_date", day1);
    expect(day1Tasks).toHaveLength(1);
    const originalTask = day1Tasks![0];

    await seedEvent(
      day2,
      "cross-day-dedupe-test-day2",
      "Follow up on embedding model",
      "Can you finalize the embedding model? We are closing milestone 0 in today's standup.",
    );
    const day2Result = await generateActionItems(clientSpaceId, day2);
    expect(day2Result.status).toBe("succeeded");

    // Proves the actual code path this fix touches, independent of what the
    // model separately decided about title-reuse during extraction:
    // consolidateActionItems was called even though this run produced
    // exactly one draft — the call that used to be skipped entirely for any
    // single-draft day (see generate.ts's needsConsolidation). Without this
    // assertion, the test below could pass by coincidence if the model's own
    // extraction-time title-reuse happened to produce a hash-identical title
    // on its own — which is exactly the unreliable mechanism the reported
    // bug slipped through in production.
    const { data: day2Run } = await service
      .from("llm_runs")
      .select("prompt")
      .eq("client_space_id", clientSpaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect((day2Run?.prompt as { consolidation?: unknown } | null)?.consolidation).not.toBeNull();

    // The whole point of the fix: a day that produces exactly one draft
    // still gets matched against already-open work, so this merges onto
    // the day-1 task instead of creating a second one.
    expect(day2Result.itemsCreated).toBe(0);
    expect(day2Result.itemsMerged).toBe(1);

    // Scoped by for_date (set once, at creation, never touched by a later
    // merge) rather than "every open task in this client space" — earlier
    // tests in this suite leave their own open tasks behind.
    const { data: tasksForDay1 } = await service.from("tasks").select("id, title").eq("client_space_id", clientSpaceId).eq("for_date", day1);
    expect(tasksForDay1).toHaveLength(1);
    expect(tasksForDay1![0].id).toBe(originalTask.id);
    // The ORIGINAL title survives the merge — a merge updates description/
    // priority/confidence, never title, which is what keeps dedupe_hash
    // stable across repeated merges onto the same task.
    expect(tasksForDay1![0].title).toBe(originalTask.title);

    const { data: sources } = await service.from("task_sources").select("role").eq("task_id", originalTask.id);
    expect(sources?.map((s) => s.role).sort()).toEqual(["created_from", "mentioned"]);
  }, 60000);

  it("retrieves a related historical chunk into the RELATED CONTEXT prompt section, and never auto-links it as a source", async () => {
    // Pick any already-processed event from this client space's earlier
    // syncs — a real, valid normalized_events id (so a citation, if the
    // model makes one, passes task_sources' FK), and NOT part of today's
    // fresh batch below (so it isn't excluded from retrieval as "already in
    // NEW EVENTS verbatim").
    const { data: earlierEvent } = await service
      .from("normalized_events")
      .select("id, body")
      .eq("client_space_id", clientSpaceId)
      .not("body", "is", null)
      .limit(1)
      .single();
    if (!earlierEvent?.body) throw new Error("expected at least one earlier processed event with a body to seed a related chunk from");

    // Embedding near-identical text to an event that's about to exist again
    // (the mock connector reuses the same synthetic topics every sync — see
    // the "merging" test above) gives this a realistic, non-contrived shot
    // at landing under RETRIEVAL_MAX_DISTANCE without hand-tuning a vector.
    const historicalText = `Last week: ${earlierEvent.body}`;
    const { embedding } = await embedOne(historicalText);
    const { error: chunkError } = await service.from("search_chunks").insert({
      client_space_id: clientSpaceId,
      project_id: null,
      source_kind: "normalized_event",
      source_id: earlierEvent.id,
      chunk_index: 0,
      provider: "mock",
      occurred_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      title: null,
      content: historicalText,
      embedding: toVectorLiteral(embedding),
      embedding_model: EMBEDDING_MODEL,
      embed_status: "embedded",
      content_hash: contentHash(historicalText),
    });
    if (chunkError) throw new Error(`failed to seed search_chunks row: ${chunkError.message}`);

    const syncResult = await runSync(projectConnectorId, "manual");
    expect(syncResult.status).toBe("succeeded");

    const result = await generateActionItems(clientSpaceId, projectToday("UTC"));
    expect(result.status).toBe("succeeded");

    const { data: run } = await service
      .from("llm_runs")
      .select("prompt")
      .eq("client_space_id", clientSpaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    const promptText = JSON.stringify(run?.prompt);
    expect(promptText).toContain("RELATED CONTEXT");
    expect(promptText).toContain(earlierEvent.body.slice(0, 40));

    // The citation channel that used to let a model call auto-write an
    // 'enriched' task_sources row from a RELATED CONTEXT excerpt was
    // removed (see PROMPT_VERSION's "v5" note in lib/llm/prompt.ts) —
    // extraction can now NEVER produce one, regardless of what's retrieved.
    // Enrichment is a PM-initiated action (services/tasks/enrich.ts,
    // exercised by find-related.test.ts and enrich.test.ts) that this
    // pipeline never touches.
    const { data: citations } = await service.from("task_sources").select("id").eq("client_space_id", clientSpaceId).eq("role", "enriched");
    expect(citations ?? []).toHaveLength(0);
  }, 60000);

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
  }, 60000);
});
