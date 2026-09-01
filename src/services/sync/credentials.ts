import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { mockCredentials } from "@/connectors/mock";
import { getNangoConnection } from "@/lib/nango/connections";
import { ConnectorAuthError } from "@/connectors/errors";
import type { ConnectorCredentials } from "@/connectors/types";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;

/**
 * The slice of a project_connectors row this module needs. Replaces the old
 * IntegrationRow: the grant moved up to space_connections (per client space)
 * and the schedule/config moved down to project_connectors (per project), so
 * resolving credentials is now a hop from the connector to its connection.
 */
export type ProjectConnectorRow = Pick<
  Database["public"]["Tables"]["project_connectors"]["Row"],
  "id" | "client_space_id" | "project_id" | "provider" | "connection_id"
>;

/**
 * Resolves a project connector's usable credentials. Nango owns refresh
 * entirely — on read, and proactively at least once a day — so this never
 * writes anything back on the happy path (see NANGO_MIGRATION_LOG.md D-010
 * for what it replaced: a hand-rolled refresh-on-expiry loop that re-sealed
 * tokens under an AES-256-GCM key and tracked its own failure bookkeeping).
 * `getAccessToken()` is a lazy, memoized closure — a sync that routes every
 * call through Nango's proxy (which authenticates by connectionId, not a raw
 * token) never pays the extra Nango round-trip at all.
 *
 * Throws if the connection is missing, is not a Nango connection, or has been
 * revoked locally — a revoked connection must never be handed to a connector
 * even if Nango still holds it upstream.
 */
export async function loadCredentials(
  service: ServiceClient,
  connector: ProjectConnectorRow,
): Promise<ConnectorCredentials> {
  if (connector.provider === "mock") {
    return mockCredentials();
  }

  // Scoped by client_space_id as well as id — defence in depth against a
  // connector row pointing at another space's grant. This replaces the old
  // workspace_id check: project_connectors carries no workspace_id, because
  // the grant it reaches for is owned by the client space, not the workspace.
  const { data: connectionRow, error } = await service
    .from("space_connections")
    .select(
      "id, auth_mode, nango_connection_id, nango_provider_config_key, external_account_id, external_account_label, revoked_at",
    )
    .eq("id", connector.connection_id)
    .eq("client_space_id", connector.client_space_id)
    .maybeSingle();
  if (error || !connectionRow) {
    throw new Error(`Space connection ${connector.connection_id} not found`);
  }
  const credentialRow = connectionRow;

  // A disconnected connection must never sync again with a grant we promised
  // the provider (and the user) we'd stop using, even if the row hasn't been
  // deleted yet.
  if (credentialRow.revoked_at) {
    throw new Error(`Space connection ${credentialRow.id} has been revoked`);
  }

  // api_key connections (Supabase, OpenAI Codex) hold a locally-sealed secret
  // rather than a Nango connection. They are a valid auth_mode the schema
  // supports, but no connector implements one yet — fail loudly rather than
  // fall through to the Nango path and produce a confusing null-token error.
  if (credentialRow.auth_mode !== "nango") {
    throw new ConnectorAuthError(
      `Space connection ${credentialRow.id} uses auth_mode '${credentialRow.auth_mode}', which no connector supports yet.`,
    );
  }

  if (!credentialRow.nango_connection_id || !credentialRow.nango_provider_config_key) {
    throw new ConnectorAuthError(
      `Space connection ${credentialRow.id} has no Nango connection on file — reconnect this connector.`,
    );
  }

  const connectionId = credentialRow.nango_connection_id;
  const providerConfigKey = credentialRow.nango_provider_config_key;
  let cachedAccessToken: string | undefined;

  return {
    connectionId,
    providerConfigKey,
    externalAccountId: credentialRow.external_account_id,
    externalAccountLabel: credentialRow.external_account_label ?? undefined,
    async getAccessToken(): Promise<string> {
      if (cachedAccessToken) return cachedAccessToken;
      const connection = await getNangoConnection(connectionId, providerConfigKey);
      cachedAccessToken = connection.accessToken;
      return cachedAccessToken;
    },
  };
}
