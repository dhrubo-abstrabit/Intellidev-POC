import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { mockCredentials } from "@/connectors/mock";
import { getNangoConnection } from "@/lib/nango/connections";
import { ConnectorAuthError } from "@/connectors/errors";
import type { ConnectorCredentials } from "@/connectors/types";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;
export type IntegrationRow = Pick<
  Database["public"]["Tables"]["integrations"]["Row"],
  "id" | "workspace_id" | "client_space_id" | "provider" | "credential_id"
>;

/**
 * Resolves an integration's usable credentials. Nango owns refresh entirely
 * now — on read, and proactively at least once a day — so unlike the
 * pre-Nango design this never writes anything back to connector_credentials
 * on the happy path (see NANGO_MIGRATION_LOG.md D-010 for what this
 * replaced: a hand-rolled refresh-on-expiry loop that re-sealed tokens
 * under an AES-256-GCM key and tracked its own failure bookkeeping).
 * `getAccessToken()` is a lazy, memoized closure — a sync that routes every
 * call through Nango's proxy (which authenticates by connectionId, not a
 * raw token) never pays the extra Nango round-trip at all.
 *
 * Throws if the credential is missing, has no Nango connection on file yet
 * (a pre-Nango row nobody has reconnected — force-reconnect is the
 * deliberate migration strategy, D-003, not a bug to work around), or has
 * been revoked locally — a revoked credential must never be handed to a
 * connector even if Nango still holds the connection.
 */
export async function loadCredentials(
  service: ServiceClient,
  integration: IntegrationRow,
): Promise<ConnectorCredentials> {
  if (integration.provider === "mock") {
    return mockCredentials();
  }
  if (!integration.credential_id) {
    throw new Error(`Integration ${integration.id} (${integration.provider}) has no credential on file`);
  }

  const { data: credentialRow, error } = await service
    .from("connector_credentials")
    .select("id, nango_connection_id, nango_provider_config_key, external_account_id, external_account_label, revoked_at")
    .eq("id", integration.credential_id)
    .eq("workspace_id", integration.workspace_id)
    .maybeSingle();
  if (error || !credentialRow) {
    throw new Error(`Credential ${integration.credential_id} not found`);
  }

  // A disconnected integration must never sync again with a connection we
  // promised the provider (and the user) we'd stop using, even if the row
  // hasn't been deleted yet.
  if (credentialRow.revoked_at) {
    throw new Error(`Credential ${credentialRow.id} has been revoked`);
  }

  if (!credentialRow.nango_connection_id || !credentialRow.nango_provider_config_key) {
    throw new ConnectorAuthError(
      `Credential ${credentialRow.id} has not been reconnected through Nango yet — reconnect this integration.`,
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
