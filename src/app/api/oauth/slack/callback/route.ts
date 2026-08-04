import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifySlackOAuthState } from "@/connectors/slack/state";
import { slackConnector } from "@/connectors/slack";
import { sealTokens, toBytea } from "@/lib/crypto/tokens";
import { uuidv7 } from "@/lib/db/uuid";

export const runtime = "nodejs";

function redirectToIntegrations(origin: string, workspaceId: string, projectId: string, status: string): NextResponse {
  return NextResponse.redirect(
    `${origin}/w/${workspaceId}/p/${projectId}/integrations?slack=${encodeURIComponent(status)}`,
  );
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const stateToken = searchParams.get("state");
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  const state = stateToken ? verifySlackOAuthState(stateToken) : null;
  if (!state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_state_invalid`);
  }
  const { workspaceId, projectId } = state;

  if (oauthError || !code) {
    return redirectToIntegrations(origin, workspaceId, projectId, "denied");
  }

  const user = await requireUser();

  // The user-scoped client enforces `is_workspace_member` via RLS on the
  // `projects` select policy — a forged/stale state token pointing at a
  // workspace this user isn't in legitimately comes back empty here.
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!project) {
    return NextResponse.redirect(`${origin}/w/${workspaceId}?error=project_not_found`);
  }

  let credentials;
  try {
    credentials = await slackConnector.exchangeCode!(code);
  } catch {
    return redirectToIntegrations(origin, workspaceId, projectId, "exchange_failed");
  }

  const service = createServiceClient();

  // Reconnecting the SAME Slack workspace (same external_account_id) must
  // reuse that row's existing id rather than generate a new one: the AAD
  // binding in sealTokens is keyed on credentialId, and blindly upserting a
  // fresh id into a row an old (e.g. disconnected) `integrations` row still
  // references by credential_id would try to change a primary key a live
  // foreign key still points at — Postgres rejects that outright.
  const { data: existingCredential } = await service
    .from("connector_credentials")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "slack")
    .eq("external_account_id", credentials.externalAccountId)
    .maybeSingle();

  const credentialId = existingCredential?.id ?? uuidv7();
  const sealed = sealTokens(credentials.tokens, workspaceId, credentialId);
  const credentialFields = {
    workspace_id: workspaceId,
    provider: "slack" as const,
    external_account_id: credentials.externalAccountId,
    external_account_label: credentials.externalAccountLabel,
    secret_ciphertext: toBytea(sealed.ciphertext),
    secret_iv: toBytea(sealed.iv),
    secret_key_version: sealed.keyVersion,
    secret_alg: sealed.alg,
    revoked_at: null,
    created_by: user.id,
  };

  const { data: upsertedCredential, error: credentialError } = existingCredential
    ? await service.from("connector_credentials").update(credentialFields).eq("id", credentialId).select("id").single()
    : await service
        .from("connector_credentials")
        .insert({ id: credentialId, ...credentialFields })
        .select("id")
        .single();

  if (credentialError || !upsertedCredential) {
    return redirectToIntegrations(origin, workspaceId, projectId, "credential_save_failed");
  }

  const isValid = await slackConnector.validate(credentials);

  const { error: integrationError } = await service.from("integrations").upsert(
    {
      workspace_id: workspaceId,
      project_id: projectId,
      credential_id: upsertedCredential.id,
      provider: "slack",
      status: isValid ? "connected" : "error",
      display_name: credentials.externalAccountLabel ?? "Slack",
      connected_by: user.id,
      last_error: isValid ? null : "Post-connect validation failed",
    },
    { onConflict: "project_id,provider,credential_id" },
  );

  if (integrationError) {
    return redirectToIntegrations(origin, workspaceId, projectId, "integration_save_failed");
  }

  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.connected",
    target_type: "integration",
    target_id: upsertedCredential.id,
    metadata: { provider: "slack" },
  });

  return redirectToIntegrations(origin, workspaceId, projectId, isValid ? "connected" : "invalid");
}
