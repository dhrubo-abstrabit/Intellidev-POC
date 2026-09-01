"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { assertProjectScope } from "@/lib/scope";
import { createServiceClient } from "@/lib/supabase/service";
import { getConnector } from "@/connectors/registry";
import { mockCredentials } from "@/connectors/mock";
import { createConnectSession } from "@/lib/nango/sessions";
import { getNangoConnection, listConnectionsByTags, deleteNangoConnection } from "@/lib/nango/connections";
import { uuidv7 } from "@/lib/db/uuid";
import { enqueueJob } from "@/lib/queue";
import { loadCredentials } from "@/services/sync/credentials";
import { getConfigSchema, isConfigScoped, scopeFingerprint } from "@/lib/db/schemas/integration-config";
import type { ConfigFieldSpec } from "@/lib/db/schemas/integration-config";
import { GOOGLE_CONFIG_SECTIONS } from "@/connectors/google/config";
import { GOOGLE_ALL_SCOPES } from "@/connectors/google";
import type { ConnectorCredentials, ConnectorId } from "@/connectors/types";
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

/** Whether `provider` is a connector that authenticates through Nango —
 * replaces the old lib/oauth/providers.ts allow-list (deleted along with
 * the rest of lib/oauth/* — see NANGO_MIGRATION_LOG.md). Narrows to
 * ConnectorId so callers can pass straight into getConnector(). */
function isNangoConnector(provider: string): provider is ConnectorId {
  try {
    return Boolean(getConnector(provider as ConnectorId).nangoProviderConfigKey);
  } catch {
    return false; // unknown id, or a retired gmail/google_drive/google_chat row
  }
}

/** Required scopes per provider, keyed by how each provider's granted-scope
 * string is delimited (Google: space, Slack: comma) — used to verify a
 * connection actually got everything it asked for, since Nango's
 * GET /connections response has no `granted_scopes` field and a user can
 * deselect individual scopes on Google's consent screen even under a
 * union-of-scopes request. Replaces exchangeGoogleCode's old MISSING_SCOPES
 * check. */
const REQUIRED_SCOPES: Partial<Record<ConnectorId, { scopes: string[]; separator: string }>> = {
  google: { scopes: GOOGLE_ALL_SCOPES, separator: " " },
};

// Google canonicalizes the short OpenID-alias scopes it was granted into
// their long googleapis.com form inside the token response's `scope` field —
// "openid" comes back literal, but "email"/"profile" (as requested via
// scopes.ts's IDENTITY_SCOPES) come back as
// "https://www.googleapis.com/auth/userinfo.email"/"...userinfo.profile".
// Confirmed directly against a real live grant whose id_token DID carry
// email/profile claims despite the raw scope string never containing the
// literal words "email"/"profile" — without this map, missingScopes flags a
// fully-granted connection as missing permissions on every real Google
// connect. See NANGO_MIGRATION_LOG.md D-027.
const GOOGLE_GRANTED_SCOPE_ALIASES: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

function missingScopes(provider: ConnectorId, grantedScopeString: string | undefined): string[] {
  const required = REQUIRED_SCOPES[provider];
  if (!required) return [];
  const granted = new Set<string>();
  for (const raw of (grantedScopeString ?? "")
    .split(required.separator)
    .map((s) => s.trim())
    .filter(Boolean)) {
    granted.add(raw);
    if (provider === "google" && raw in GOOGLE_GRANTED_SCOPE_ALIASES) {
      granted.add(GOOGLE_GRANTED_SCOPE_ALIASES[raw]);
    }
  }
  return required.scopes.filter((s) => !granted.has(s));
}

/**
 * Shared by both finalizeConnection (the client-driven happy path) and
 * reconcileConnections (the fallback for a Connect UI session whose
 * `connect` event never reached us — see D-011: free self-hosted Nango has
 * no webhooks). Does the actual identify -> scope-check -> upsert-grant ->
 * validate -> upsert-project-connector work; callers are responsible for
 * confirming the connectionId is legitimately this client space's BEFORE
 * calling this.
 *
 * Two writes, not one: space_connections (the OAuth grant — client-space
 * scoped, since a client space corresponds to one distinct provider account)
 * and project_connectors (this project's scoping of that grant — see
 * supabase/migrations/20260901000800_connectors.sql). A grant reused by a
 * second project just gets a second project_connectors row pointing at the
 * same space_connections id; `projectId` is what that second write — and the
 * `audit_logs` row recording which project's Integrations page the connect
 * happened from — is scoped to.
 */
async function finalizeConnectionCore(
  workspaceId: string,
  clientSpaceId: string,
  tenantId: string,
  projectId: string,
  provider: ConnectorId,
  connectionId: string,
  providerConfigKey: string,
  userId: string,
): Promise<{ message: string }> {
  const connector = getConnector(provider);

  let cachedAccessToken: string | undefined;
  const placeholderCredentials: ConnectorCredentials = {
    connectionId,
    providerConfigKey,
    externalAccountId: "",
    async getAccessToken() {
      if (cachedAccessToken) return cachedAccessToken;
      const connection = await getNangoConnection(connectionId, providerConfigKey);
      cachedAccessToken = connection.accessToken;
      return cachedAccessToken;
    },
  };

  let identity: { externalAccountId: string; externalAccountLabel?: string; accountDomain?: string };
  try {
    identity = connector.identify
      ? await connector.identify(placeholderCredentials)
      : { externalAccountId: connectionId };
  } catch (err) {
    throw new Error(`Could not identify the connected account: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (REQUIRED_SCOPES[provider]) {
    // A failure to even READ the connection back is swallowed — identify()
    // above already proved the connection works, so this non-essential
    // second read must not fail the whole connect. A genuine scope
    // mismatch (once the read succeeds) DOES throw, outside this catch.
    const connection = await getNangoConnection(connectionId, providerConfigKey).catch(() => null);
    if (connection) {
      const missing = missingScopes(provider, connection.raw.scope as string | undefined);
      if (missing.length > 0) {
        throw new Error(
          `Not all requested permissions were granted (missing: ${missing.join(", ")}). Disconnect and reconnect to approve the full list.`,
        );
      }
    }
  }

  const service = createServiceClient();

  // Reconnecting the SAME external account reuses that row's existing id —
  // scoped to client_space_id: space_connections' unique(client_space_id,
  // provider, external_account_id) is the actual uniqueness boundary (see
  // 20260901000800_connectors.sql). One grant here can now legitimately back
  // several projects' project_connectors rows.
  const { data: existingConnection } = await service
    .from("space_connections")
    .select("id")
    .eq("client_space_id", clientSpaceId)
    .eq("provider", provider)
    .eq("external_account_id", identity.externalAccountId)
    .maybeSingle();

  const connectionId_ = existingConnection?.id ?? uuidv7();
  const connectionFields = {
    client_space_id: clientSpaceId,
    provider,
    auth_mode: "nango" as const,
    external_account_id: identity.externalAccountId,
    external_account_label: identity.externalAccountLabel,
    account_domain: identity.accountDomain,
    nango_connection_id: connectionId,
    nango_provider_config_key: providerConfigKey,
    revoked_at: null,
    connected_by: userId,
  };

  const { data: upsertedConnection, error: connectionError } = existingConnection
    ? await service.from("space_connections").update(connectionFields).eq("id", connectionId_).select("id").single()
    : await service
        .from("space_connections")
        .insert({ id: connectionId_, ...connectionFields })
        .select("id")
        .single();

  if (connectionError || !upsertedConnection) {
    throw new Error("Connected, but saving the credential failed. Please try again.");
  }

  const finalCredentials: ConnectorCredentials = { ...placeholderCredentials, externalAccountId: identity.externalAccountId };
  const isValid = await connector.validate(finalCredentials);

  await service
    .from("space_connections")
    .update({ status: isValid ? "connected" : "error", last_validated_at: new Date().toISOString() })
    .eq("id", upsertedConnection.id);

  // Google needs a scope (Chat space ids, a Drive folder/drive URL) the user
  // hasn't supplied yet, and syncing before that would just be a no-op every
  // cron tick — this project's connector starts with sync disabled until
  // saveIntegrationConfig flips it on (see the pending->connected flip that
  // used to live on the old integrations.status). Every other provider needs
  // no such scoping, so it starts enabled, as before.
  const initialSyncEnabled = provider !== "google";

  // Reuse this project's existing connector row on a reconnect instead of
  // creating a duplicate — unique(project_id, connection_id) is the actual
  // boundary. Deliberately omit `config` from the update path: PostgREST
  // only updates keys present in the payload, so leaving it out preserves a
  // previously saved scope (Chat space ids, Drive sources, Gmail query)
  // across a disconnect+reconnect. The column default `'{}'` covers a fresh
  // insert.
  const { data: existingProjectConnector } = await service
    .from("project_connectors")
    .select("id")
    .eq("project_id", projectId)
    .eq("connection_id", upsertedConnection.id)
    .maybeSingle();

  const { data: projectConnector, error: projectConnectorError } = existingProjectConnector
    ? await service
        .from("project_connectors")
        .update({ enabled: true, sync_enabled: initialSyncEnabled })
        .eq("id", existingProjectConnector.id)
        .select("id")
        .single()
    : await service
        .from("project_connectors")
        .insert({
          client_space_id: clientSpaceId,
          project_id: projectId,
          connection_id: upsertedConnection.id,
          provider,
          sync_enabled: initialSyncEnabled,
          created_by: userId,
        })
        .select("id")
        .single();

  if (projectConnectorError || !projectConnector) {
    throw new Error("Connected, but saving the integration failed. Please try again.");
  }

  await service.from("audit_logs").insert({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    client_space_id: clientSpaceId,
    project_id: projectId,
    actor_user_id: userId,
    actor_type: "user",
    action: "integration.connected",
    target_type: "project_connector",
    target_id: projectConnector.id,
    metadata: { provider },
  });

  // Deliberately NOT calling revalidatePath here — this core is shared with
  // reconcileConnections, which now also calls it (after finalizing
  // everything it found), so a caller invoking this in a loop doesn't
  // revalidate once per orphan. Every caller of this core is a genuine
  // client-triggered Server Action now (see reconcileConnections' own doc
  // comment — it moved off the render path), so revalidatePath is safe
  // everywhere; it's just each caller's job to call it once, not this core's.
  return {
    message: isValid ? `${connector.displayName} connected.` : `${connector.displayName} connected, but failed its post-connect check.`,
  };
}

/**
 * Mints a short-lived Nango Connect session token for the client-side
 * Connect UI (see ConnectProviderButton) — replaces the old
 * redirect-to-authorize-URL flow entirely. Tagged by client_space_id (not
 * project_id): a connection belongs to the client space, and
 * finalizeConnection/reconcileConnections need to find it again later
 * without trusting a client-reported connection id — Nango assigns
 * connection ids as random UUIDs the caller can't choose.
 */
export async function createIntegrationConnectSession(
  workspaceId: string,
  projectId: string,
  provider: string,
): Promise<{ sessionToken: string }> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  if (!isNangoConnector(provider)) {
    throw new Error(`"${provider}" is not an OAuth-based connector.`);
  }
  const connector = getConnector(provider);

  const session = await createConnectSession({
    tags: {
      workspace_id: workspaceId,
      client_space_id: scope.clientSpaceId,
      provider,
      end_user_id: user.id,
      ...(user.email ? { end_user_email: user.email } : {}),
    },
    allowedIntegrations: [connector.nangoProviderConfigKey!],
  });
  return { sessionToken: session.token };
}

/**
 * Called from the client once the Connect UI reports a successful
 * `connect` event. Does NOT trust the client-reported connectionId at face
 * value — verifies it actually appears in Nango's own tag-filtered
 * connection list for this client space first (D-011: this
 * reconciliation-by-tags is the whole reason sessions are tagged above).
 */
export async function finalizeConnection(
  workspaceId: string,
  projectId: string,
  provider: string,
  connectionId: string,
  providerConfigKey: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  if (!isNangoConnector(provider)) {
    throw new Error(`"${provider}" is not an OAuth-based connector.`);
  }

  const owned = await listConnectionsByTags({
    workspace_id: workspaceId,
    client_space_id: scope.clientSpaceId,
    provider,
  }).catch(() => []);
  if (!owned.some((c) => c.connectionId === connectionId)) {
    throw new Error("This connection could not be verified. Please try connecting again.");
  }

  const result = await finalizeConnectionCore(
    workspaceId,
    scope.clientSpaceId,
    scope.tenantId,
    projectId,
    provider,
    connectionId,
    providerConfigKey,
    user.id,
  );
  // Called from a genuine client-triggered Server Action (not during
  // render), so revalidatePath is valid here — see finalizeConnectionCore's
  // own comment for why it doesn't call this itself.
  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  return result;
}

export interface ReconcileConnectionsResult {
  message: string;
  reconciledCount: number;
}

/**
 * Sweeps Nango connections tagged for this client space and finalizes any
 * that have no local space_connections row yet — the fallback for a
 * Connect UI session that succeeded on Nango's side but whose `connect`
 * event never reached finalizeConnection (tab closed mid-flow, a network
 * blip). Best-effort per connection: one orphan failing to finalize must not
 * block the others.
 *
 * NOT run automatically on every Integrations page render anymore — that
 * made an uncached, un-timed-out Nango HTTP call (plus a DB round trip per
 * connection) part of every page load, for a check that almost always finds
 * nothing. Two callers cover the cases that matter instead: ConnectUI's
 * `close` event without a preceding `connect` (see ConnectProviderButton —
 * the exact moment an orphan can be created, caught for free, client-side),
 * and a manual "Check for connections" button for the rarer whole-browser-
 * crashed case. Both are genuine client-triggered Server Action calls now
 * (never during render), so — unlike the old render-path version — this is
 * free to call revalidatePath itself.
 */
export async function reconcileConnections(
  workspaceId: string,
  projectId: string,
): Promise<ReconcileConnectionsResult> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const connections = await listConnectionsByTags({
    workspace_id: workspaceId,
    client_space_id: scope.clientSpaceId,
  }).catch(() => []);
  if (connections.length === 0) {
    return { message: "No new connections found.", reconciledCount: 0 };
  }

  const service = createServiceClient();

  // One query for every candidate's existence, not one per connection in a
  // loop — the partial unique index on nango_connection_id (see
  // 20260901000800_connectors.sql) already covers this lookup.
  const { data: existingRows } = await service
    .from("space_connections")
    .select("nango_connection_id")
    .in(
      "nango_connection_id",
      connections.map((c) => c.connectionId),
    );
  const alreadyLocal = new Set((existingRows ?? []).map((r) => r.nango_connection_id));

  let reconciledCount = 0;
  for (const conn of connections) {
    if (alreadyLocal.has(conn.connectionId)) continue;
    if (!isNangoConnector(conn.providerConfigKey)) continue;

    // providerConfigKey doubles as our internal connector id here — true
    // for both connectors that exist today (google, slack), since Nango's
    // integration unique_key and this app's ConnectorId happen to be the
    // same string for each. Would need the session's own `provider` tag
    // read back instead if a future connector's Nango key ever diverges
    // from its connector id.
    await finalizeConnectionCore(
      workspaceId,
      scope.clientSpaceId,
      scope.tenantId,
      projectId,
      conn.providerConfigKey,
      conn.connectionId,
      conn.providerConfigKey,
      user.id,
    )
      .then(() => {
        reconciledCount += 1;
      })
      .catch((err) => {
        console.warn(`[reconcileConnections] failed to finalize orphaned connection ${conn.connectionId}:`, err);
      });
  }

  if (reconciledCount > 0) {
    revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  }

  return {
    message:
      reconciledCount > 0
        ? `Found and connected ${reconciledCount} integration${reconciledCount === 1 ? "" : "s"}.`
        : "No new connections found.",
    reconciledCount,
  };
}

export async function connectMock(workspaceId: string, projectId: string): Promise<{ message: string }> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const service = createServiceClient();

  // space_connections.external_account_id is NOT NULL — mock gets a real
  // (constant) value here, so unlike the old design's permanently-null
  // credential_id, the standard unique(client_space_id, provider,
  // external_account_id) index already catches a concurrent duplicate on its
  // own; no partial-index workaround needed. Still select-then-insert-or-
  // update rather than an upsert, with the insert's unique-violation caught
  // as "someone else won the race" — same idiom as createWorkspace's slug
  // retry and settleBatchMembership's compare-and-swap.
  const { data: existingConnection } = await service
    .from("space_connections")
    .select("id")
    .eq("client_space_id", scope.clientSpaceId)
    .eq("provider", "mock")
    .maybeSingle();

  const connectionId = existingConnection?.id ?? uuidv7();
  const connectionFields = {
    status: "connected" as const,
    external_account_label: "Mock workspace",
    connected_by: user.id,
    revoked_at: null,
  };
  const { error: connectionError } = existingConnection
    ? await service.from("space_connections").update(connectionFields).eq("id", connectionId)
    : await service.from("space_connections").insert({
        id: connectionId,
        client_space_id: scope.clientSpaceId,
        provider: "mock",
        auth_mode: "none",
        external_account_id: "mock",
        ...connectionFields,
      });
  if (connectionError && connectionError.code !== "23505") {
    throw new Error("Could not connect the mock integration.");
  }

  const { data: existingProjectConnector } = await service
    .from("project_connectors")
    .select("id")
    .eq("project_id", projectId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  const { error: projectConnectorError } = existingProjectConnector
    ? await service.from("project_connectors").update({ enabled: true, sync_enabled: true }).eq("id", existingProjectConnector.id)
    : await service.from("project_connectors").insert({
        client_space_id: scope.clientSpaceId,
        project_id: projectId,
        connection_id: connectionId,
        provider: "mock",
        sync_enabled: true,
        created_by: user.id,
      });
  // 23505 (unique_violation) here means a concurrent call already inserted
  // the row between the select above and this insert — that's the mock
  // integration ending up connected, exactly what this call wanted, so it's
  // a success, not an error.
  if (projectConnectorError && projectConnectorError.code !== "23505") {
    throw new Error("Could not connect the mock integration.");
  }

  await service.from("audit_logs").insert({
    tenant_id: scope.tenantId,
    workspace_id: workspaceId,
    client_space_id: scope.clientSpaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.connected",
    target_type: "project_connector",
    metadata: { provider: "mock" },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
  return { message: "Mock connector connected" };
}

export async function syncNow(workspaceId: string, projectId: string, projectConnectorId: string): Promise<{ message: string }> {
  await requireUser();
  await assertProjectScope(workspaceId, projectId);

  // Publishes onto pgmq, which pg_cron's dispatcher drains every few seconds
  // and delivers to /api/jobs/sync as a net.http_post — see
  // src/lib/queue/index.ts and the pgmq/pg_cron migration. Any enqueue
  // failure (e.g. the local Postgres image not having pgmq's Vault secrets
  // seeded — see supabase/local-dispatch-secrets.sql) is caught and surfaced
  // as a normal thrown error rather than an unhandled rejection.
  try {
    await enqueueJob("/api/jobs/sync", { projectConnectorId, trigger: "manual" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not queue a sync: ${message}`);
  }

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  return { message: "Sync queued" };
}

/**
 * Detaches THIS PROJECT from a connector — it does not necessarily revoke
 * the underlying grant. A space_connections row can back several projects'
 * project_connectors rows (see finalizeConnectionCore), and disconnecting
 * from one project's Integrations page must not break sync for a sibling
 * project still using the same grant. Only when this was the LAST
 * project_connectors row referencing that connection does this also revoke
 * it with the provider and mark it locally revoked.
 */
export async function disconnectIntegration(
  workspaceId: string,
  projectId: string,
  projectConnectorId: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const service = createServiceClient();
  const { data: projectConnector } = await service
    .from("project_connectors")
    .select("id, provider, connection_id")
    .eq("id", projectConnectorId)
    .eq("project_id", projectId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!projectConnector) {
    throw new Error("Integration not found.");
  }

  // Disable, NOT delete: raw_events/normalized_events/event_attachments all
  // three-column-FK to project_connectors ON DELETE CASCADE (see
  // 20260901001000_events.sql / 20260901001800_event_attachments_connector.sql)
  // — deleting this row would silently wipe every message this project ever
  // ingested through it, and orphan task_sources for tasks that survive
  // (tasks itself has no FK to project_connectors). "Disconnect" promising
  // "you can reconnect later" means keep the history, stop the syncing.
  // finalizeConnectionCore already re-enables this exact row on a genuine
  // reconnect rather than inserting a duplicate.
  await service.from("project_connectors").update({ enabled: false, sync_enabled: false }).eq("id", projectConnector.id);

  const { count: remainingUsers } = await service
    .from("project_connectors")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", projectConnector.connection_id)
    .eq("enabled", true);

  if (!remainingUsers) {
    const { data: connectionRow } = await service
      .from("space_connections")
      .select("id, nango_connection_id, nango_provider_config_key")
      .eq("id", projectConnector.connection_id)
      .maybeSingle();

    if (connectionRow?.nango_connection_id && connectionRow.nango_provider_config_key) {
      // Best-effort, in order: a provider-specific revoke on top of Nango's
      // own connection deletion (see Connector.disconnect's doc comment —
      // most providers need nothing beyond Nango's own delete; only kept
      // where a provider needs an explicit extra revoke call).
      try {
        if (isNangoConnector(projectConnector.provider)) {
          const connector = getConnector(projectConnector.provider);
          let cachedAccessToken: string | undefined;
          await connector
            .disconnect?.({
              connectionId: connectionRow.nango_connection_id,
              providerConfigKey: connectionRow.nango_provider_config_key,
              externalAccountId: "",
              async getAccessToken() {
                if (cachedAccessToken) return cachedAccessToken;
                const connection = await getNangoConnection(
                  connectionRow.nango_connection_id!,
                  connectionRow.nango_provider_config_key!,
                );
                cachedAccessToken = connection.accessToken;
                return cachedAccessToken;
              },
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error(`Failed to run provider-specific revoke for connection ${connectionRow.id}:`, err);
      }

      await deleteNangoConnection(connectionRow.nango_connection_id, connectionRow.nango_provider_config_key).catch((err) => {
        console.error(`Failed to delete Nango connection for connection ${connectionRow.id}:`, err);
      });
    } else if (projectConnector.provider === "mock") {
      await getConnector("mock").disconnect?.(mockCredentials());
    }
    // A connection row with no nango_connection_id at all (mock, or a
    // pre-Nango row nobody reconnected) has nothing to revoke with the
    // provider or with Nango; it's still marked revoked below so it stops
    // being offered.

    if (connectionRow) {
      await service
        .from("space_connections")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("id", connectionRow.id);
    }
  }

  await service.from("audit_logs").insert({
    tenant_id: scope.tenantId,
    workspace_id: workspaceId,
    client_space_id: scope.clientSpaceId,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.disconnected",
    target_type: "project_connector",
    target_id: projectConnector.id,
    metadata: { provider: projectConnector.provider },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  revalidatePath(`/w/${workspaceId}/p/${projectId}`);
  return { message: "Integration disconnected" };
}

/**
 * Saves a connector's per-project scope (Chat space ids, Drive
 * folder/shared-drive URLs, a Gmail search query, ...) into
 * project_connectors.config. useActionState-shaped, following
 * create-project-form.tsx's pattern — the first action in this file to take
 * FormData, because AsyncButton's `() => Promise<{message}>` signature has
 * no room for it.
 */
export async function saveIntegrationConfig(
  workspaceId: string,
  projectId: string,
  projectConnectorId: string,
  _prev: SaveIntegrationConfigResult,
  formData: FormData,
): Promise<SaveIntegrationConfigResult> {
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);

  const service = createServiceClient();
  const { data: projectConnector } = await service
    .from("project_connectors")
    .select("id, client_space_id, project_id, provider, connection_id, sync_enabled, config")
    .eq("id", projectConnectorId)
    .eq("project_id", projectId)
    .eq("client_space_id", scope.clientSpaceId)
    .maybeSingle();
  if (!projectConnector) {
    return { error: "Integration not found." };
  }

  const entry = getConfigSchema(projectConnector.provider);
  if (!entry) {
    return { error: `"${projectConnector.provider}" has no configurable options.` };
  }

  // Google submits three namespaced sections at once (see
  // GoogleIntegrationConfigForm); every other connector submits one flat set
  // of `entry.fields`. Both converge on the same parsed object from here
  // down — validation, resolve(), scope-change detection, the
  // sync_enabled flip and the audit log are all shared.
  const raw =
    projectConnector.provider === "google"
      ? parseGoogleFieldsFromFormData(formData)
      : parseFieldsFromFormData(entry.fields, formData);
  const parsed = entry.schema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid configuration." };
  }

  if (entry.resolve) {
    let credentials;
    try {
      credentials = await loadCredentials(service, projectConnector);
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
  const previousConfig = (projectConnector.config ?? {}) as Record<string, unknown>;
  const scopeChanged = scopeFingerprint(entry, previousConfig) !== scopeFingerprint(entry, parsed.data);

  const nowConfigured = isConfigScoped(entry, parsed.data);
  const update: Database["public"]["Tables"]["project_connectors"]["Update"] = { config: parsed.data as Json };
  // Google connectors start with sync disabled straight out of connect (see
  // finalizeConnectionCore) until a scope is supplied — flip it on the
  // moment that happens so the cron actually picks this connector up. There
  // is no `status` column on project_connectors to also clear here — a
  // connector's own health only ever comes from sync bookkeeping
  // (last_error/consecutive_failures), not from this save.
  if (!projectConnector.sync_enabled && nowConfigured) {
    update.sync_enabled = true;
  }

  const { error: updateError } = await service.from("project_connectors").update(update).eq("id", projectConnector.id);
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
        .from("project_connector_cursors")
        .select("cursor")
        .eq("project_connector_id", projectConnector.id)
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
      // inventing one for a connector that has never synced would just be a
      // lie about its resume position.
      await service
        .from("project_connector_cursors")
        .update({ cursor: prunedCursor as Json })
        .eq("project_connector_id", projectConnector.id)
        .eq("scope_key", "default");
    } else {
      await service
        .from("project_connector_cursors")
        .delete()
        .eq("project_connector_id", projectConnector.id)
        .eq("scope_key", "default");
    }
  }

  await service.from("audit_logs").insert({
    tenant_id: scope.tenantId,
    workspace_id: workspaceId,
    client_space_id: projectConnector.client_space_id,
    project_id: projectId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "integration.configured",
    target_type: "project_connector",
    target_id: projectConnector.id,
    metadata: { provider: projectConnector.provider },
  });

  revalidatePath(`/w/${workspaceId}/p/${projectId}/integrations`);
  return { message: "Configuration saved." };
}
