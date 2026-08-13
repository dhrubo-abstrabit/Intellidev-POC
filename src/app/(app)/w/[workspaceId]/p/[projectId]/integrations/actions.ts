"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, assertProjectMembership } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/service";
import { createOAuthState } from "@/lib/oauth/state";
import { isOAuthProvider } from "@/lib/oauth/providers";
import { getConnector } from "@/connectors/registry";
import { mockCredentials } from "@/connectors/mock";
import { openTokens, fromBytea } from "@/lib/crypto/tokens";
import { enqueueJob } from "@/lib/queue";
import { loadCredentials } from "@/services/sync/credentials";
import { getConfigSchema, isConfigScoped, scopeFingerprint } from "@/lib/db/schemas/integration-config";
import type { ConfigFieldSpec } from "@/lib/db/schemas/integration-config";
import { GOOGLE_CONFIG_SECTIONS } from "@/connectors/google/config";
import type { Database, Json } from "@/lib/db/database.types";

export interface SaveIntegrationConfigResult {
  error?: string;
  message?: string;
}

/** Pulls each declared field out of FormData into the shape the provider's
 * Zod schema expects — text-list fields (one URL/id per line in a textarea)
 * become string arrays here rather than in the schema, so the schema itself
 * can stay a plain array-of-string validator. */
function parseFieldsFromFormData(fields: ConfigFieldSpec[], formData: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "text-list") {
      raw[field.key] = String(formData.get(field.key) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } else if (field.kind === "number") {
      const value = formData.get(field.key);
      raw[field.key] = value === null || value === "" ? undefined : Number(value);
    } else if (field.kind === "boolean") {
      raw[field.key] = formData.get(field.key) === "on";
    } else {
      raw[field.key] = String(formData.get(field.key) ?? "");
    }
  }
  return raw;
}

/** Re-projects one namespaced section of a FormData into an un-prefixed view,
 * so parseFieldsFromFormData can run against it unchanged. */
function sectionFormData(prefix: string, formData: FormData): FormData {
  const section = new FormData();
  for (const [name, value] of formData.entries()) {
    if (name.startsWith(`${prefix}.`)) section.append(name.slice(prefix.length + 1), value);
  }
  return section;
}

/** Builds `{gmail, drive, chat}` from ONE submit of the merged Google config
 * form, whose inputs are namespaced `<section>.<fieldKey>` (plus a
 * `<section>.enabled` checkbox) so three services' field keys can share a
 * form without colliding. A section is null when its checkbox wasn't ticked
 * — its inputs are ignored entirely rather than parsed and discarded, so
 * nothing inside a service the user just turned off can fail validation. */
function parseGoogleFieldsFromFormData(formData: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const section of GOOGLE_CONFIG_SECTIONS) {
    raw[section.key] =
      formData.get(`${section.key}.enabled`) === "on"
        ? parseFieldsFromFormData(section.fields, sectionFormData(section.key, formData))
        : null;
  }
  // processAttachments/maxAttachmentsPerRun (connectors/google/config.ts)
  // are deliberately NOT read here — they have no form fields to read from,
  // so `raw` simply omits them and googleConfigSchema's own
  // .default(true)/.default(15) applies on every save. Reading them from
  // formData with no matching input would silently write `false` on every
  // save instead (a missing checkbox is indistinguishable from an unchecked
  // one) — the opposite of "enabled by default, hidden from the form".
  return raw;
}

/** Kept as a redirecting action (not the toast/AsyncButton pattern the rest
 * of this file uses) because redirect() only reliably triggers a real
 * navigation when the action is invoked via a form submit — see
 * ConnectProviderButton. Generic over every OAuth connector (Slack, Gmail,
 * Google Drive, Google Chat) — adding a new one needs no new action here. */
export async function connectProvider(provider: string, workspaceId: string, projectId: string): Promise<void> {
  await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  if (!isOAuthProvider(provider)) {
    throw new Error(`"${provider}" is not an OAuth-based connector.`);
  }

  const state = createOAuthState(provider, workspaceId, projectId);
  redirect(getConnector(provider).getAuthorizeUrl!(state));
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

  // With JOB_BACKEND=qstash, this publishes to Upstash, which then calls our
  // own /api/jobs/sync back over the public internet — that only actually
  // delivers once NEXT_PUBLIC_APP_URL is reachable from Upstash (i.e.
  // deployed, or tunneled). Against a bare `localhost` dev server, Upstash
  // rejects the publish outright ("endpoint resolves to a loopback
  // address"), so this is caught and surfaced as a normal thrown error
  // rather than an unhandled QstashError. JOB_BACKEND=pgmq has no such
  // restriction — see src/lib/queue/index.ts.
  try {
    await enqueueJob("/api/jobs/sync", { integrationId, trigger: "manual" });
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

/**
 * Saves a connector's per-integration scope (Chat space ids, Drive
 * folder/shared-drive URLs, a Gmail search query, ...) into
 * integrations.config. useActionState-shaped, following
 * create-project-form.tsx's pattern — the first action in this file to take
 * FormData, because AsyncButton's `() => Promise<{message}>` signature has
 * no room for it.
 */
export async function saveIntegrationConfig(
  workspaceId: string,
  projectId: string,
  integrationId: string,
  _prev: SaveIntegrationConfigResult,
  formData: FormData,
): Promise<SaveIntegrationConfigResult> {
  const user = await requireUser();
  await assertProjectMembership(workspaceId, projectId);

  const service = createServiceClient();
  const { data: integration } = await service
    .from("integrations")
    .select("id, workspace_id, project_id, provider, credential_id, status, config")
    .eq("id", integrationId)
    .eq("project_id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!integration) {
    return { error: "Integration not found." };
  }

  const entry = getConfigSchema(integration.provider);
  if (!entry) {
    return { error: `"${integration.provider}" has no configurable options.` };
  }

  // Google submits three namespaced sections at once (see
  // GoogleIntegrationConfigForm); every other connector submits one flat set
  // of `entry.fields`. Both converge on the same parsed object from here
  // down — validation, resolve(), scope-change detection, the
  // pending -> connected flip and the audit log are all shared.
  const raw =
    integration.provider === "google"
      ? parseGoogleFieldsFromFormData(formData)
      : parseFieldsFromFormData(entry.fields, formData);
  const parsed = entry.schema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid configuration." };
  }

  if (entry.resolve) {
    const connector = getConnector(integration.provider);
    let credentials;
    try {
      credentials = await loadCredentials(service, integration, connector);
    } catch (err) {
      return { error: `Could not load this integration's credentials: ${err instanceof Error ? err.message : String(err)}` };
    }
    const resolved = await entry.resolve(parsed.data, { credentials });
    if (!resolved.ok) {
      return { error: resolved.error };
    }
  }

  // A changed scope (different Drive folders, different Chat spaces, a
  // different Gmail query) invalidates whatever cursor was built for the
  // old one — e.g. Drive's modifiedTimeFloor from a completely different
  // folder tree is meaningless (and could even skip real activity) once
  // replayed against a new one.
  const previousConfig = (integration.config ?? {}) as Record<string, unknown>;
  const scopeChanged = scopeFingerprint(entry, previousConfig) !== scopeFingerprint(entry, parsed.data);

  const nowConfigured = isConfigScoped(entry, parsed.data);
  const update: Database["public"]["Tables"]["integrations"]["Update"] = { config: parsed.data as Json };
  // Google connectors land "pending" straight out of OAuth (see
  // api/oauth/[provider]/callback) until a scope is supplied — flip to
  // "connected" the moment that happens so the cron actually picks it up.
  if (integration.status === "pending" && nowConfigured) {
    update.status = "connected";
    update.last_error = null;
  }

  const { error: updateError } = await service.from("integrations").update(update).eq("id", integration.id);
  if (updateError) {
    return { error: "Could not save the configuration." };
  }

  if (scopeChanged) {
    // A connector holding several independent sub-cursors in one row (only
    // `google` today) gets to prune just the part its scope change actually
    // invalidated — otherwise editing one sub-service's scope would reset
    // the other two as collateral damage. Everything else keeps the original
    // behavior: delete the row, resume from scratch.
    let prunedCursor: Record<string, unknown> | null = null;
    if (entry.pruneCursorOnScopeChange) {
      const { data: cursorRow } = await service
        .from("integration_cursors")
        .select("cursor")
        .eq("integration_id", integration.id)
        .eq("scope_key", "default")
        .maybeSingle();
      const currentCursor = cursorRow?.cursor;
      prunedCursor = entry.pruneCursorOnScopeChange(
        previousConfig,
        parsed.data,
        currentCursor && typeof currentCursor === "object" && !Array.isArray(currentCursor)
          ? (currentCursor as Record<string, unknown>)
          : null,
      );
    }

    if (prunedCursor) {
      // UPDATE, not upsert: a non-null return means the hook was handed an
      // existing cursor to prune, so the row is already there — and
      // inventing one for an integration that has never synced would just
      // be a lie about its resume position.
      await service
        .from("integration_cursors")
        .update({ cursor: prunedCursor as Json })
        .eq("integration_id", integration.id)
        .eq("scope_key", "default");
    } else {
      await service.from("integration_cursors").delete().eq("integration_id", integration.id).eq("scope_key", "default");
    }
  }

  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.configured",
    target_type: "integration",
    target_id: integration.id,
    metadata: { provider: integration.provider },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  return { message: "Configuration saved." };
}
