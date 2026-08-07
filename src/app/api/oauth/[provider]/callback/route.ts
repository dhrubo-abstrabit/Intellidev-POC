import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyOAuthState } from "@/lib/oauth/state";
import { isOAuthProvider } from "@/lib/oauth/providers";
import { integrationsRedirectUrl } from "@/lib/oauth/redirect";
import { getConnector } from "@/connectors/registry";
import { sealTokens, toBytea } from "@/lib/crypto/tokens";
import { uuidv7 } from "@/lib/db/uuid";

export const runtime = "nodejs";
// A connector fetch across many channels/pages can run past Vercel's
// default function timeout — 60s is the ceiling on the Hobby plan. The
// callback itself never fetches provider data, but exchangeCode + validate
// are network calls too, so keep the same ceiling as the sync route.
export const maxDuration = 60;

/** Providers whose token bundle can plausibly carry MISSING_REFRESH_TOKEN /
 * MISSING_SCOPES errors from exchangeCode — currently only the Google
 * connectors throw these (see connectors/google/oauth.ts); Slack's classic
 * bot tokens have no refresh concept. Kept as a message map, not a provider
 * check, so a future OAuth-based connector picks this up for free. */
function mapExchangeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("MISSING_REFRESH_TOKEN")) return "no_refresh_token";
  if (message.includes("MISSING_SCOPES")) return "scope_missing";
  return "exchange_failed";
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const { searchParams, origin } = new URL(request.url);

  if (!isOAuthProvider(provider)) {
    return NextResponse.json({ error: "Unknown OAuth provider" }, { status: 404 });
  }

  const stateToken = searchParams.get("state");
  const code = searchParams.get("code");
  const oauthError = searchParams.get("error");

  const state = stateToken ? verifyOAuthState(stateToken) : null;
  if (!state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_state_invalid`);
  }
  const { workspaceId, projectId } = state;

  // A state token minted for one provider must not be usable against a
  // different provider's callback — the signature alone only proves
  // authenticity, not "issued for THIS connect attempt".
  if (state.provider !== provider) {
    return NextResponse.redirect(
      integrationsRedirectUrl(origin, workspaceId, projectId, provider, "oauth_state_provider_mismatch"),
    );
  }

  if (oauthError || !code) {
    return NextResponse.redirect(integrationsRedirectUrl(origin, workspaceId, projectId, provider, "denied"));
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

  const connector = getConnector(provider);

  let credentials;
  try {
    credentials = await connector.exchangeCode!(code);
  } catch (err) {
    return NextResponse.redirect(integrationsRedirectUrl(origin, workspaceId, projectId, provider, mapExchangeError(err)));
  }

  const service = createServiceClient();

  // Reconnecting the SAME external account (same external_account_id) must
  // reuse that row's existing id rather than generate a new one: the AAD
  // binding in sealTokens is keyed on credentialId, and blindly upserting a
  // fresh id into a row an old (e.g. disconnected) `integrations` row still
  // references by credential_id would try to change a primary key a live
  // foreign key still points at — Postgres rejects that outright.
  const { data: existingCredential } = await service
    .from("connector_credentials")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .eq("external_account_id", credentials.externalAccountId)
    .maybeSingle();

  const credentialId = existingCredential?.id ?? uuidv7();
  const sealed = sealTokens(credentials.tokens, workspaceId, credentialId);
  const credentialFields = {
    workspace_id: workspaceId,
    provider,
    external_account_id: credentials.externalAccountId,
    external_account_label: credentials.externalAccountLabel,
    secret_ciphertext: toBytea(sealed.ciphertext),
    secret_iv: toBytea(sealed.iv),
    secret_key_version: sealed.keyVersion,
    secret_alg: sealed.alg,
    access_token_expires_at: credentials.accessTokenExpiresAt?.toISOString() ?? null,
    refresh_failed_at: null,
    refresh_failure_count: 0,
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
    return NextResponse.redirect(
      integrationsRedirectUrl(origin, workspaceId, projectId, provider, "credential_save_failed"),
    );
  }

  const isValid = await connector.validate(credentials);

  // Google connectors land "pending", not "connected": they need a scope
  // (Chat space ids, a Drive folder/drive URL) the user hasn't supplied yet,
  // and syncing before that would just be a no-op every cron tick. Slack
  // needs no such scoping, so it goes straight to "connected" as before.
  const initialStatus = !isValid ? "error" : connector.id === "slack" ? "connected" : "pending";

  // Deliberately omit `config` from this upsert: PostgREST only updates the
  // keys present in the payload, so leaving it out preserves a previously
  // saved scope (Chat space ids, Drive sources, Gmail query) across a
  // disconnect+reconnect. The column default `'{}'` covers a fresh insert.
  const { error: integrationError } = await service.from("integrations").upsert(
    {
      workspace_id: workspaceId,
      project_id: projectId,
      credential_id: upsertedCredential.id,
      provider,
      status: initialStatus,
      display_name: credentials.externalAccountLabel ?? connector.displayName,
      connected_by: user.id,
      last_error: isValid ? null : "Post-connect validation failed",
    },
    { onConflict: "project_id,provider,credential_id" },
  );

  if (integrationError) {
    return NextResponse.redirect(
      integrationsRedirectUrl(origin, workspaceId, projectId, provider, "integration_save_failed"),
    );
  }

  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.connected",
    target_type: "integration",
    target_id: upsertedCredential.id,
    metadata: { provider },
  });

  return NextResponse.redirect(
    integrationsRedirectUrl(origin, workspaceId, projectId, provider, isValid ? "connected" : "invalid"),
  );
}
