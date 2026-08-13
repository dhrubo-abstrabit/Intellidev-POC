import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { runSync } from "./run-sync";

/**
 * Exercises the real fetch -> raw_events -> normalize -> normalized_events
 * -> cursor pipeline against the cloud Supabase project (vitest.integration.config.ts
 * loads .env.local, which points here — see CLAUDE.md), using the mock
 * connector so it needs no network access and no live OAuth grant. Calls
 * runSync() directly rather than through a queue round-trip, so it's
 * agnostic to JOB_BACKEND — driving the actual queue (either QStash, whose
 * callback can't reach a bare `localhost` dev server, or pgmq, which can —
 * see src/lib/queue/index.ts) is exercised manually, not by this test.
 */
describe("runSync (mock connector, real local DB)", () => {
  const service = createServiceClient();
  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let integrationId: string;

  beforeAll(async () => {
    const email = `sync-integration-test-${Date.now()}@example.com`;
    const { data: authUser, error: authError } = await service.auth.admin.createUser({
      email,
      password: "TestPassword123!",
      email_confirm: true,
    });
    if (authError || !authUser.user) throw new Error(`Failed to create test user: ${authError?.message}`);
    userId = authUser.user.id;

    const { data: workspace, error: workspaceError } = await service
      .from("workspaces")
      .insert({ name: "Sync Integration Test", slug: `sync-itest-${Date.now()}`, owner_id: userId })
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
  });

  afterAll(async () => {
    // Cascades through workspace_members, projects, integrations, sync_jobs,
    // raw_events, normalized_events, integration_cursors.
    await service.from("workspaces").delete().eq("id", workspaceId);
    await service.auth.admin.deleteUser(userId);
  });

  it("fetches, normalizes, and advances the cursor on a first run", async () => {
    const result = await runSync(integrationId, "manual");

    expect(result.status).toBe("succeeded");
    expect(result.eventsFetched).toBe(5);
    expect(result.eventsWritten).toBe(5);

    const { data: rawEvents } = await service.from("raw_events").select("id").eq("integration_id", integrationId);
    expect(rawEvents).toHaveLength(5);

    const { data: normalizedEvents } = await service
      .from("normalized_events")
      .select("id, type, dedupe_key")
      .eq("integration_id", integrationId);
    expect(normalizedEvents).toHaveLength(5);
    expect(normalizedEvents?.every((e) => e.type === "message.posted")).toBe(true);

    const { data: cursorRow } = await service
      .from("integration_cursors")
      .select("cursor")
      .eq("integration_id", integrationId)
      .eq("scope_key", "default")
      .single();
    expect(cursorRow?.cursor).toEqual({ seq: 5 });

    const { data: integration } = await service
      .from("integrations")
      .select("status, last_sync_succeeded_at, consecutive_failures")
      .eq("id", integrationId)
      .single();
    expect(integration?.status).toBe("connected");
    expect(integration?.last_sync_succeeded_at).not.toBeNull();
    expect(integration?.consecutive_failures).toBe(0);

    const { data: syncJob } = await service
      .from("sync_jobs")
      .select("status, events_fetched, events_written, trigger")
      .eq("integration_id", integrationId)
      .single();
    expect(syncJob).toMatchObject({ status: "succeeded", events_fetched: 5, events_written: 5, trigger: "manual" });
  });

  it("persists a pending event_attachments row for the message the mock connector tags with an attachment", async () => {
    // The first run's batch covers seq 0..4; mockConnector.fetchSince tags
    // exactly seq % 5 === 2 with hasAttachment — see connectors/mock/index.ts.
    const { data: normalizedEvent } = await service
      .from("normalized_events")
      .select("id")
      .eq("integration_id", integrationId)
      .eq("dedupe_key", "message.posted:mock-general:2")
      .single();
    expect(normalizedEvent).not.toBeNull();

    const { data: attachments } = await service
      .from("event_attachments")
      .select("status, provider_attachment_id, filename, mime_type, size_bytes, download_ref, normalized_event_id")
      .eq("normalized_event_id", normalizedEvent!.id);

    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]).toMatchObject({
      status: "pending",
      provider_attachment_id: "mock-att-2",
      filename: "sample.txt",
      mime_type: "text/plain",
      size_bytes: 36,
      download_ref: { seq: 2 },
    });

    // No attachment was tagged for seq 0, 1, 3, or 4 — normalize() must not
    // have fabricated one for any of them.
    const { count: totalAttachments } = await service
      .from("event_attachments")
      .select("id", { count: "exact", head: true })
      .eq("integration_id", integrationId);
    expect(totalAttachments).toBe(1);
  });

  it("fetches the NEXT batch (not a repeat) on a second run, proving the cursor advanced for real", async () => {
    const result = await runSync(integrationId, "manual");
    expect(result.status).toBe("succeeded");
    expect(result.eventsWritten).toBe(5);

    const { data: rawEvents } = await service
      .from("raw_events")
      .select("provider_event_id")
      .eq("integration_id", integrationId);
    // 10 total across both runs, all distinct provider_event_ids — if the
    // cursor hadn't advanced, this second batch would collide with the
    // first and the dedupe unique index would have silently dropped it.
    expect(rawEvents).toHaveLength(10);
    expect(new Set(rawEvents?.map((r) => r.provider_event_id)).size).toBe(10);

    const { data: cursorRow } = await service
      .from("integration_cursors")
      .select("cursor")
      .eq("integration_id", integrationId)
      .eq("scope_key", "default")
      .single();
    expect(cursorRow?.cursor).toEqual({ seq: 10 });
  });

  it("re-running fetchSince with the SAME cursor is a safe no-op (idempotent re-delivery)", async () => {
    // Simulate a QStash at-least-once redelivery by resetting the cursor
    // back to what it was before the second run, then re-running.
    await service
      .from("integration_cursors")
      .update({ cursor: { seq: 5 } })
      .eq("integration_id", integrationId)
      .eq("scope_key", "default");

    const result = await runSync(integrationId, "manual");
    expect(result.status).toBe("succeeded");
    // fetchSince still reports 5 fetched (it doesn't know about dedup), but
    // 0 should be newly *written* since all 5 already exist from run #2.
    expect(result.eventsFetched).toBe(5);
    expect(result.eventsWritten).toBe(0);

    const { data: rawEvents } = await service.from("raw_events").select("id").eq("integration_id", integrationId);
    expect(rawEvents).toHaveLength(10);
  });
});
