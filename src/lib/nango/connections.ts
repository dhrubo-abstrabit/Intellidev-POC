import "server-only";
import { ConnectorAuthError } from "@/connectors/errors";
import { nangoEnv } from "@/lib/env";

/**
 * Subset of Nango's GET /connections/{id} response we actually consume.
 * `raw` is the provider's full token response verbatim — there is no
 * `granted_scopes` field in Nango's schema (verified against docs
 * 2026-08-19, see NANGO_MIGRATION_LOG.md), so a Google scope-verification
 * check must parse `raw.scope` itself; a user can deselect individual
 * scopes on Google's consent screen even under a union-of-scopes grant.
 */
export interface NangoConnection {
  connectionId: string;
  providerConfigKey: string;
  accessToken: string;
  expiresAt: string | null;
  raw: Record<string, unknown>;
}

interface RawConnectionResponse {
  connection_id: string;
  provider_config_key: string;
  credentials: {
    type: string;
    access_token: string;
    refresh_token?: string;
    expires_at?: string;
    raw?: Record<string, unknown>;
  };
}

/**
 * Fetches a connection's current access token from Nango, refreshing it
 * first if it's expired (Nango's documented behavior — see D-001..D-011:
 * "every time you fetch a connection with this endpoint, Nango checks if
 * the access token has expired and refreshes it if so"). Used by the two
 * binary-download code paths that bypass the proxy (D-004) and by
 * services/sync/credentials.ts's ConnectorCredentials.getAccessToken().
 *
 * A non-2xx here is ambiguous between "Nango itself is unreachable" and
 * "the connection's grant is actually dead" — callers that need to
 * distinguish those (services/sync/credentials.ts) should catch this and
 * classify by status rather than assuming every failure is auth-related.
 */
export async function getNangoConnection(
  connectionId: string,
  providerConfigKey: string,
  options: { forceRefresh?: boolean } = {},
): Promise<NangoConnection> {
  const env = nangoEnv();
  const url = new URL(`${env.NANGO_SERVER_URL}/connections/${encodeURIComponent(connectionId)}`);
  url.searchParams.set("provider_config_key", providerConfigKey);
  if (options.forceRefresh) url.searchParams.set("force_refresh", "true");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.NANGO_SECRET_KEY}` },
  });

  if (res.status === 401 || res.status === 404) {
    throw new ConnectorAuthError(`Nango has no usable connection for ${connectionId}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nango getConnection(${connectionId}) failed with ${res.status}: ${text || res.statusText}`);
  }

  const body = (await res.json()) as RawConnectionResponse;
  return {
    connectionId: body.connection_id,
    providerConfigKey: body.provider_config_key,
    accessToken: body.credentials.access_token,
    expiresAt: body.credentials.expires_at ?? null,
    raw: body.credentials.raw ?? {},
  };
}

/**
 * Lists connections matching every given tag (AND-matched, per Nango's
 * `GET /connections?tags[k]=v` — see D-011). The reconciliation fallback
 * for capturing a connection id when the client-side Connect UI event is
 * lost (tab closed mid-flow) — free self-hosted Nango has no webhooks.
 */
export async function listConnectionsByTags(
  tags: Record<string, string>,
): Promise<Array<{ connectionId: string; providerConfigKey: string }>> {
  const env = nangoEnv();
  const url = new URL(`${env.NANGO_SERVER_URL}/connections`);
  for (const [key, value] of Object.entries(tags)) {
    url.searchParams.set(`tags[${key}]`, value);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.NANGO_SECRET_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nango listConnections failed with ${res.status}: ${text || res.statusText}`);
  }

  const body = (await res.json()) as { connections: Array<{ connection_id: string; provider_config_key: string }> };
  return body.connections.map((c) => ({ connectionId: c.connection_id, providerConfigKey: c.provider_config_key }));
}

/**
 * Deletes a connection in Nango — the disconnect-flow counterpart to
 * exchangeCode/connect. Best-effort by convention with every other
 * disconnect path in this codebase (services/.../actions.ts already
 * swallows provider-revoke failures so a broken credential stays
 * removable); callers should catch and log, not propagate.
 */
export async function deleteNangoConnection(connectionId: string, providerConfigKey: string): Promise<void> {
  const env = nangoEnv();
  const url = new URL(`${env.NANGO_SERVER_URL}/connections/${encodeURIComponent(connectionId)}`);
  url.searchParams.set("provider_config_key", providerConfigKey);

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${env.NANGO_SECRET_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nango deleteConnection(${connectionId}) failed with ${res.status}: ${text || res.statusText}`);
  }
}
