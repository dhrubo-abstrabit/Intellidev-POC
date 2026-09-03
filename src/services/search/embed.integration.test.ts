import { afterAll, beforeAll, describe, expect, it } from "vitest";
import OpenAI from "openai";
import { embeddingEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { runEmbedding } from "./embed";
import { retrieveContextChunks } from "./retrieve";

/**
 * Exercises the real embedding pipeline: real OpenAI text-embedding-3-small
 * calls (via LangChain's OpenAIEmbeddings), against the real local Supabase
 * instance. Cost is negligible — a handful of short chunks plus two query
 * embeddings is a few thousand tokens at $0.02/MTok, well under $0.001
 * total for this whole file.
 */
describe("runEmbedding / retrieveContextChunks (real OpenAI, real local DB)", () => {
  const service = createServiceClient();
  let userId: string;
  let tenantId: string;
  let clientSpaceId: string;
  let otherClientSpaceId: string;

  beforeAll(async () => {
    const email = `embed-integration-test-${Date.now()}@example.com`;
    const { data: authUser, error: authError } = await service.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`Failed to create test user: ${authError?.message}`);
    userId = authUser.user.id;

    const { data: tenant, error: tenantError } = await service
      .from("tenants")
      .insert({ name: "Embed Integration Test", slug: `embed-itest-${Date.now()}` })
      .select("id")
      .single();
    if (tenantError || !tenant) throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
    tenantId = tenant.id;

    const { data: workspace, error: workspaceError } = await service
      .from("workspaces")
      .insert({ tenant_id: tenantId, name: "Embed Integration Test", slug: `embed-itest-${Date.now()}` })
      .select("id")
      .single();
    if (workspaceError || !workspace) throw new Error(`Failed to create test workspace: ${workspaceError?.message}`);
    const workspaceId = workspace.id;

    const { data: clientSpace, error: clientSpaceError } = await service
      .from("client_spaces")
      .insert({ workspace_id: workspaceId, tenant_id: tenantId, name: "Space A", slug: "space-a" })
      .select("id")
      .single();
    if (clientSpaceError || !clientSpace) throw new Error(`Failed to create test client space: ${clientSpaceError?.message}`);
    clientSpaceId = clientSpace.id;

    const { data: otherClientSpace, error: otherClientSpaceError } = await service
      .from("client_spaces")
      .insert({ workspace_id: workspaceId, tenant_id: tenantId, name: "Space B", slug: "space-b" })
      .select("id")
      .single();
    if (otherClientSpaceError || !otherClientSpace) throw new Error(`Failed to create second test client space: ${otherClientSpaceError?.message}`);
    otherClientSpaceId = otherClientSpace.id;
  }, 30000);

  afterAll(async () => {
    await service.from("tenants").delete().eq("id", tenantId);
    await service.auth.admin.deleteUser(userId);
  });

  it("embeds pending chunks with real 1024-dim vectors and logs estimated cost/usage", async () => {
    const rows = [
      { title: "c1", content: "The checkout flow's payment step is failing intermittently for international cards." },
      { title: "c2", content: "QA confirmed the checkout payment failure only happens with non-US billing addresses." },
      { title: "c3", content: "Marketing finalized the Q3 newsletter copy and sent it for design review." },
      { title: "c4-other-topic", content: "The office coffee machine was replaced with a new espresso model this week." },
    ];
    const inserted = await Promise.all(
      rows.map((row, i) =>
        service
          .from("search_chunks")
          .insert({
            client_space_id: clientSpaceId,
            project_id: null,
            source_kind: "normalized_event",
            source_id: crypto.randomUUID(),
            chunk_index: 0,
            provider: "mock",
            occurred_at: new Date().toISOString(),
            title: row.title,
            content: row.content,
            embed_status: "pending",
            content_hash: `\\x${i.toString().padStart(64, "0")}`,
          })
          .select("id")
          .single(),
      ),
    );
    const chunkIds = inserted.map((r) => {
      if (r.error || !r.data) throw new Error(`failed to seed chunk: ${r.error?.message}`);
      return r.data.id;
    });

    const result = await runEmbedding(clientSpaceId);
    expect(result.status).toBe("succeeded");
    expect(result.embedded).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.hasMore).toBe(false);

    const { data: embeddedRows } = await service
      .from("search_chunks")
      .select("id, embedding, embedding_model, embed_status, embedded_at, embed_error")
      .in("id", chunkIds);
    expect(embeddedRows).toHaveLength(4);
    for (const row of embeddedRows ?? []) {
      expect(row.embed_status).toBe("embedded");
      expect(row.embedding_model).toBe("text-embedding-3-small@1024");
      expect(row.embedded_at).not.toBeNull();
      expect(row.embed_error).toBeNull();
      const vector = JSON.parse(row.embedding as unknown as string) as number[];
      expect(vector).toHaveLength(1024);
    }

    // Filtered by kind, not just client space — an unrelated 'extract' run
    // in the same space would otherwise make this assertion flaky.
    const { data: runs } = await service.from("llm_runs").select("*").eq("client_space_id", clientSpaceId).eq("kind", "embed");
    expect(runs).toHaveLength(1);
    const run = runs?.[0];
    expect(run?.status).toBe("succeeded");
    expect(run?.provider).toBe("openai");
    expect(run?.model).toBe("text-embedding-3-small@1024");
    expect(run?.prompt_version).toBe("embed-v2-tiktoken-est");
    expect(run?.prompt_tokens).toBeGreaterThan(0);
    expect(run?.cost_usd).toBeGreaterThan(0);
    expect(run?.latency_ms).toBeGreaterThan(0);
    expect(run?.completion_tokens).toBeNull();
    expect(run?.prompt).toBeNull();
    expect(run?.response).toBeNull();

    // Drift check: LangChain's OpenAIEmbeddings never surfaces the
    // provider's own billed usage, so runEmbedding logs a js-tiktoken
    // ESTIMATE (see embed.ts's EmbedResult.estimatedPromptTokens). This is
    // the only compensation available for losing that authoritative count —
    // one direct raw-SDK call on the identical inputs, asserting the
    // estimate tracks the real billed figure closely. Embeddings have no
    // per-request framing overhead the way chat messages do, so this should
    // land within a token or two, not just "in the right ballpark".
    const rawClient = new OpenAI({ apiKey: embeddingEnv().OPENAI_API_KEY });
    const rawResponse = await rawClient.embeddings.create({
      model: "text-embedding-3-small",
      dimensions: 1024,
      input: rows.map((r) => r.content),
      encoding_format: "float",
    });
    expect(Math.abs((run?.prompt_tokens ?? 0) - rawResponse.usage.prompt_tokens)).toBeLessThanOrEqual(1);
  }, 60000);

  it("is idempotent: a second run finds nothing pending and writes no new llm_runs row", async () => {
    const { count: runsBefore } = await service
      .from("llm_runs")
      .select("id", { count: "exact", head: true })
      .eq("client_space_id", clientSpaceId)
      .eq("kind", "embed");

    const result = await runEmbedding(clientSpaceId);
    expect(result.status).toBe("skipped");
    expect(result.embedded).toBe(0);

    const { count: runsAfter } = await service
      .from("llm_runs")
      .select("id", { count: "exact", head: true })
      .eq("client_space_id", clientSpaceId)
      .eq("kind", "embed");
    expect(runsAfter).toBe(runsBefore);
  }, 30000);

  it("marks an oversize chunk 'skipped' without consuming a provider call", async () => {
    const oversizeContent = "x".repeat(30_000); // over embed.ts's MAX_INPUT_BYTES (24,000)
    const { data: oversizeRow, error } = await service
      .from("search_chunks")
      .insert({
        client_space_id: clientSpaceId,
        project_id: null,
        source_kind: "normalized_event",
        source_id: crypto.randomUUID(),
        chunk_index: 0,
        provider: "mock",
        occurred_at: new Date().toISOString(),
        title: "oversize",
        content: oversizeContent,
        embed_status: "pending",
        content_hash: "\\x" + "0".repeat(64),
      })
      .select("id")
      .single();
    if (error || !oversizeRow) throw new Error(`failed to seed oversize chunk: ${error?.message}`);

    const result = await runEmbedding(clientSpaceId);
    expect(result.status).toBe("skipped");
    expect(result.skipped).toBe(1);
    expect(result.embedded).toBe(0);

    const { data: row } = await service
      .from("search_chunks")
      .select("embed_status, embed_error")
      .eq("id", oversizeRow.id)
      .single();
    expect(row?.embed_status).toBe("skipped");
    expect(row?.embed_error).toContain("exceeds");
  }, 30000);

  it("retrieveContextChunks ranks on-topic chunks ahead of an unrelated one, respects excludeSourceIds, and never leaks across client spaces", async () => {
    // A second client space's chunk, seeded and embedded independently —
    // must never come back for a query scoped to clientSpaceId.
    const { data: otherChunk } = await service
      .from("search_chunks")
      .insert({
        client_space_id: otherClientSpaceId,
        project_id: null,
        source_kind: "normalized_event",
        source_id: crypto.randomUUID(),
        chunk_index: 0,
        provider: "mock",
        occurred_at: new Date().toISOString(),
        title: "other-space",
        content: "The checkout flow's payment step is failing intermittently for international cards.",
        embed_status: "pending",
        content_hash: "\\x" + "1".repeat(64),
      })
      .select("id")
      .single();
    if (!otherChunk) throw new Error("failed to seed the other client space's chunk");
    const otherSpaceResult = await runEmbedding(otherClientSpaceId);
    expect(otherSpaceResult.status).toBe("succeeded");

    const { chunks } = await retrieveContextChunks(service, {
      clientSpaceId,
      queryText: "customers report checkout payments failing for cards issued outside the US",
      limit: 10,
      maxDistance: 2,
    });

    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("c1");
    expect(titles).toContain("c2");
    expect(titles).not.toContain("other-space");

    const c1Index = titles.indexOf("c1");
    const otherTopicIndex = titles.indexOf("c4-other-topic");
    if (otherTopicIndex !== -1) {
      expect(chunks[c1Index].distance).toBeLessThan(chunks[otherTopicIndex].distance);
    }

    const c1 = chunks.find((c) => c.title === "c1")!;
    const { chunks: withExclusion } = await retrieveContextChunks(service, {
      clientSpaceId,
      queryText: "customers report checkout payments failing for cards issued outside the US",
      limit: 10,
      maxDistance: 2,
      excludeSourceIds: [c1.sourceId],
    });
    expect(withExclusion.map((c) => c.title)).not.toContain("c1");
  }, 30000);
});
