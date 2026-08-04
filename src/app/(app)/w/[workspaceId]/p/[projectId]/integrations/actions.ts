"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createSlackOAuthState } from "@/connectors/slack/state";
import { getConnector } from "@/connectors/registry";
import { mockCredentials } from "@/connectors/mock";
import { openTokens, fromBytea } from "@/lib/crypto/tokens";
import { publishJob } from "@/lib/queue/qstash";

async function assertProjectMembership(workspaceId: string, projectId: string): Promise<void> {
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!project) {
    throw new Error("Not a member of this workspace, or project not found.");
  }
}

/** Kept as a redirecting action (not the toast/AsyncButton pattern the rest
 * of this file uses) because redirect() only reliably triggers a real
 * navigation when the action is invoked via a form submit — see
 * ConnectSlackButton. */
export async function connectSlack(workspaceId: string, projectId: string): Promise<void> {
  await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  const state = createSlackOAuthState(workspaceId, projectId);
  redirect(getConnector("slack").getAuthorizeUrl!(state));
}

export async function connectMock(workspaceId: string, projectId: string): Promise<{ message: string }> {
  const user = await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  const service = createServiceClient();
  const { error } = await service.from("integrations").upsert(
    {
      workspace_id: workspaceId,
      project_id: projectId,
      credential_id: null,
      provider: "mock",
      status: "connected",
      display_name: "Mock (sample data)",
      connected_by: user.id,
      last_error: null,
    },
    { onConflict: "project_id,provider,credential_id" },
  );
  if (error) {
    throw new Error("Could not connect the mock integration.");
  }

  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.connected",
    target_type: "integration",
    metadata: { provider: "mock" },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
  return { message: "Mock connector connected" };
}

export async function syncNow(workspaceId: string, projectId: string, integrationId: string): Promise<{ message: string }> {
  await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  // Publishes to QStash, which then calls our own /api/jobs/sync back over
  // the public internet — this only actually delivers once NEXT_PUBLIC_APP_URL
  // is reachable from Upstash (i.e. deployed, or tunneled). Against a bare
  // `localhost` dev server, Upstash rejects the publish outright ("endpoint
  // resolves to a loopback address"), so this is caught and surfaced as a
  // normal thrown error rather than an unhandled QstashError.
  try {
    await publishJob("/api/jobs/sync", { integrationId, trigger: "manual" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not queue a sync: ${message}`);
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  return { message: "Sync queued" };
}

export async function disconnectIntegration(
  workspaceId: string,
  projectId: string,
  integrationId: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  const service = createServiceClient();
  const { data: integration } = await service
    .from("integrations")
    .select("id, provider, credential_id")
    .eq("id", integrationId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!integration) {
    throw new Error("Integration not found.");
  }

  if (integration.credential_id) {
    const { data: credentialRow } = await service
      .from("connector_credentials")
      .select("id, secret_ciphertext, secret_iv, secret_key_version, secret_alg")
      .eq("id", integration.credential_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (credentialRow) {
      // openTokens throws on an auth-tag mismatch (tampered/corrupt
      // ciphertext) — a security event per its own doc comment, not
      // routine control flow, but the disconnect itself must still
      // succeed: a credential that can't be decrypted anymore still needs
      // to be revocable from the UI, and the raw crypto error message
      // shouldn't reach the client (Server Action errors forward
      // `.message` verbatim, unlike page-render errors).
      try {
        const tokens = openTokens(
          {
            ciphertext: fromBytea(credentialRow.secret_ciphertext as unknown as string),
            iv: fromBytea(credentialRow.secret_iv as unknown as string),
            keyVersion: credentialRow.secret_key_version,
            alg: credentialRow.secret_alg as "aes-256-gcm",
          },
          workspaceId,
          credentialRow.id,
        );
        const connector = getConnector(integration.provider);
        await connector.disconnect({ tokens, externalAccountId: "" }).catch(() => {});
      } catch (err) {
        console.error(`Failed to decrypt/revoke credential ${credentialRow.id} with provider:`, err);
      }
      await service
        .from("connector_credentials")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", credentialRow.id);
    }
  } else if (integration.provider === "mock") {
    await getConnector("mock").disconnect(mockCredentials());
  }

  await service.from("integrations").update({ status: "disconnected" }).eq("id", integration.id);

  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.disconnected",
    target_type: "integration",
    target_id: integration.id,
    metadata: { provider: integration.provider },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
  return { message: "Integration disconnected" };
}
