import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { runSync } from "./run-sync";

/**
 * Exercises the real fetch -> raw_events -> normalize -> normalized_events
 * -> cursor pipeline against the real local Supabase instance (see
 * vitest.integration.config.ts), using the mock connector so it needs no
 * network access and no live OAuth grant. Calls runSync() directly rather
 * than through a queue round-trip — driving the actual pgmq/pg_cron queue
 * (src/lib/queue/index.ts) is exercised manually, not by this test.
 */
describe("runSync (mock connector, real local DB)", () => {
  const service = createServiceClient();
  let userId: string;
  let tenantId: string;
  let clientSpaceId: string;
  let projectConnectorId: string;

  beforeAll(async () => {
    const email = `sync-integration-test-${Date.now()}@example.com`;
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
      .insert({ name: "Sync Integration Test", slug: `sync-itest-${Date.now()}` })
      .select("id")
      .single();
    if (tenantError || !tenant) throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
    tenantId = tenant.id;

    const { data: workspace, error: workspaceError } = await service
      .from("workspaces")
      .insert({ tenant_id: tenantId, name: "Sync Integration Test", slug: `sync-itest-${Date.now()}` })
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
  });

  afterAll(async () => {
    // Deleting the tenant cascades through workspaces, client_spaces,
    // projects, space_connections, project_connectors, sync_jobs,
    // raw_events, normalized_events, project_connector_cursors,
    // event_attachments, and tenant_members/workspace_members.
    await service.from("tenants").delete().eq("id", tenantId);
    await service.auth.admin.deleteUser(userId);
  });

  it("fetches, normalizes, and advances the cursor on a first run", async () => {
    const result = await runSync(projectConnectorId, "manual");

    expect(result.status).toBe("succeeded");
    expect(result.eventsFetched).toBe(5);
    expect(result.eventsWritten).toBe(5);

    const { data: rawEvents } = await service.from("raw_events").select("id").eq("project_connector_id", projectConnectorId);
    expect(rawEvents).toHaveLength(5);

    const { data: normalizedEvents } = await service
      .from("normalized_events")
      .select("id, type, dedupe_key")
      .eq("project_connector_id", projectConnectorId);
    expect(normalizedEvents).toHaveLength(5);
    expect(normalizedEvents?.every((e) => e.type === "message.posted")).toBe(true);

    const { data: cursorRow } = await service
      .from("project_connector_cursors")
      .select("cursor")
      .eq("project_connector_id", projectConnectorId)
      .eq("scope_key", "default")
      .single();
    expect(cursorRow?.cursor).toEqual({ seq: 5 });

    // Sync bookkeeping lives on project_connectors; grant health (status)
    // lives separately on space_connections — see run-sync.ts's own comment
    // on why there is no status column on project_connectors.
    const { data: projectConnector } = await service
      .from("project_connectors")
      .select("last_sync_succeeded_at, consecutive_failures, connection_id")
      .eq("id", projectConnectorId)
      .single();
    expect(projectConnector?.last_sync_succeeded_at).not.toBeNull();
    expect(projectConnector?.consecutive_failures).toBe(0);

    const { data: connection } = await service
      .from("space_connections")
      .select("status")
      .eq("id", projectConnector!.connection_id)
      .single();
    expect(connection?.status).toBe("connected");

    const { data: syncJob } = await service
      .from("sync_jobs")
      .select("status, events_fetched, events_written, trigger")
      .eq("project_connector_id", projectConnectorId)
      .single();
    expect(syncJob).toMatchObject({ status: "succeeded", events_fetched: 5, events_written: 5, trigger: "manual" });
  });

  it("persists a pending event_attachments row for the message the mock connector tags with an attachment", async () => {
    // The first run's batch covers seq 0..4; mockConnector.fetchSince tags
    // exactly seq % 5 === 2 with hasAttachment — see connectors/mock/index.ts.
    const { data: normalizedEvent } = await service
      .from("normalized_events")
      .select("id")
      .eq("project_connector_id", projectConnectorId)
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
      .eq("project_connector_id", projectConnectorId);
    expect(totalAttachments).toBe(1);
  });

  it("fetches the NEXT batch (not a repeat) on a second run, proving the cursor advanced for real", async () => {
    const result = await runSync(projectConnectorId, "manual");
    expect(result.status).toBe("succeeded");
    expect(result.eventsWritten).toBe(5);

    const { data: rawEvents } = await service
      .from("raw_events")
      .select("provider_event_id")
      .eq("project_connector_id", projectConnectorId);
    // 10 total across both runs, all distinct provider_event_ids — if the
    // cursor hadn't advanced, this second batch would collide with the
    // first and the dedupe unique index would have silently dropped it.
    expect(rawEvents).toHaveLength(10);
    expect(new Set(rawEvents?.map((r) => r.provider_event_id)).size).toBe(10);

    const { data: cursorRow } = await service
      .from("project_connector_cursors")
      .select("cursor")
      .eq("project_connector_id", projectConnectorId)
      .eq("scope_key", "default")
      .single();
    expect(cursorRow?.cursor).toEqual({ seq: 10 });
  });

  it("re-running fetchSince with the SAME cursor is a safe no-op (idempotent re-delivery)", async () => {
    // Simulate an at-least-once redelivery by resetting the cursor back to
    // what it was before the second run, then re-running.
    await service
      .from("project_connector_cursors")
      .update({ cursor: { seq: 5 } })
      .eq("project_connector_id", projectConnectorId)
      .eq("scope_key", "default");

    const result = await runSync(projectConnectorId, "manual");
    expect(result.status).toBe("succeeded");
    // fetchSince still reports 5 fetched (it doesn't know about dedup), but
    // 0 should be newly *written* since all 5 already exist from run #2.
    expect(result.eventsFetched).toBe(5);
    expect(result.eventsWritten).toBe(0);

    const { data: rawEvents } = await service.from("raw_events").select("id").eq("project_connector_id", projectConnectorId);
    expect(rawEvents).toHaveLength(10);
  });
});
