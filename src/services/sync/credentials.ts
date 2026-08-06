import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { mockCredentials } from "@/connectors/mock";
import { openTokens, sealTokens, fromBytea, toBytea } from "@/lib/crypto/tokens";
import { ConnectorRefreshError } from "@/connectors/errors";
import type { Connector, ConnectorCredentials } from "@/connectors/types";
import type { Database } from "@/lib/db/database.types";

type ServiceClient = ReturnType<typeof createServiceClient>;
export type IntegrationRow = Pick<
  Database["public"]["Tables"]["integrations"]["Row"],
  "id" | "workspace_id" | "project_id" | "provider" | "credential_id"
>;

// How much runway before an access token's real expiry we treat it as
// already-expired and refresh proactively — refreshing at T-5m instead of
// waiting for a 401 avoids burning a whole fetchSince call (and its
// deadline budget) on a token that was going to fail anyway.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether a credential should be refreshed before use. A NULL expiry means
 * "unknown" and MUST be treated as needing refresh, not skipped — that's
 * both the state of every credential from before this module existed (Slack
 * tokens never set it) and how run-sync.ts forces a refresh after a
 * ConnectorAuthError (it clears access_token_expires_at rather than
 * guessing a new value). Exported for unit testing.
 */
export function needsRefresh(expiresAt: Date | null, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - now.getTime() <= REFRESH_SKEW_MS;
}

/**
 * Resolves an integration's usable credentials, refreshing first if the
 * connector supports it and the current token is expired/expiring/unknown.
 * Extracted out of run-sync.ts (which now just calls this) so it's reusable
 * and independently unit-testable. Throws if the credential is missing,
 * undecryptable, or has been revoked — a revoked credential must never be
 * handed to a connector, even if its ciphertext still happens to decrypt.
 */
export async function loadCredentials(
  service: ServiceClient,
  integration: IntegrationRow,
  connector: Connector,
): Promise<ConnectorCredentials> {
  if (integration.provider === "mock") {
    return mockCredentials();
  }
  if (!integration.credential_id) {
    throw new Error(`Integration ${integration.id} (${integration.provider}) has no credential on file`);
  }

  const { data: credentialRow, error } = await service
    .from("connector_credentials")
    .select(
      "id, secret_ciphertext, secret_iv, secret_key_version, secret_alg, external_account_id, external_account_label, access_token_expires_at, revoked_at, refresh_failure_count",
    )
    .eq("id", integration.credential_id)
    .eq("workspace_id", integration.workspace_id)
    .maybeSingle();
  if (error || !credentialRow) {
    throw new Error(`Credential ${integration.credential_id} not found`);
  }

  // A disconnected integration must never sync again with the token we
  // promised the provider (and the user) we'd stop using, even if the row
  // hasn't been deleted yet.
  if (credentialRow.revoked_at) {
    throw new Error(`Credential ${credentialRow.id} has been revoked`);
  }

  const tokens = openTokens(
    {
      ciphertext: fromBytea(credentialRow.secret_ciphertext as unknown as string),
      iv: fromBytea(credentialRow.secret_iv as unknown as string),
      keyVersion: credentialRow.secret_key_version,
      alg: credentialRow.secret_alg as "aes-256-gcm",
    },
    integration.workspace_id,
    credentialRow.id,
  );

  const expiresAt = credentialRow.access_token_expires_at ? new Date(credentialRow.access_token_expires_at) : null;
  const credentials: ConnectorCredentials = {
    tokens,
    externalAccountId: credentialRow.external_account_id,
    externalAccountLabel: credentialRow.external_account_label ?? undefined,
    accessTokenExpiresAt: expiresAt ?? undefined,
  };

  // Providers whose tokens don't expire (Slack's classic bot tokens, mock)
  // don't implement refreshTokens at all — skip the whole path rather than
  // treating a permanently-null expiry as "always needs refresh".
  if (!connector.refreshTokens || !needsRefresh(expiresAt)) {
    return credentials;
  }

  try {
    // MUST be the complete bundle, not a delta — see the refreshTokens doc
    // comment on Connector. Re-sealed under the SAME credentialId: sealTokens'
    // AAD is `v1|workspaceId|credentialId`, so re-sealing under a fresh id
    // would make every future openTokens() throw an auth-tag error.
    const refreshed = await connector.refreshTokens(credentials);
    const sealed = sealTokens(refreshed.tokens, integration.workspace_id, credentialRow.id);
    await service
      .from("connector_credentials")
      .update({
        secret_ciphertext: toBytea(sealed.ciphertext),
        secret_iv: toBytea(sealed.iv),
        secret_key_version: sealed.keyVersion,
        secret_alg: sealed.alg,
        access_token_expires_at: refreshed.accessTokenExpiresAt?.toISOString() ?? null,
        refresh_failed_at: null,
        refresh_failure_count: 0,
      })
      .eq("id", credentialRow.id);
    return refreshed;
  } catch (err) {
    // A 5xx/network blip is NOT proof the grant itself is dead — only a
    // permanent ConnectorRefreshError (e.g. Google's invalid_grant) sets
    // revoked_at. Setting it unconditionally here would let one transient
    // failure permanently brick a working credential.
    const permanent = err instanceof ConnectorRefreshError && err.permanent;
    await service
      .from("connector_credentials")
      .update({
        refresh_failed_at: new Date().toISOString(),
        refresh_failure_count: credentialRow.refresh_failure_count + 1,
        ...(permanent ? { revoked_at: new Date().toISOString() } : {}),
      })
      .eq("id", credentialRow.id);
    // Rethrow so run-sync's existing catch applies its normal backoff and
    // degraded/error status flip — no new status machinery needed here.
    throw err instanceof Error ? err : new Error(String(err));
  }
}
