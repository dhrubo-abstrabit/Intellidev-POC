import "server-only";
import { nangoEnv } from "@/lib/env";

/**
 * Nango tags: max 10 keys, key length <=64, value length <=255, values are
 * non-empty strings (verified against docs 2026-08-19). Used to correlate a
 * Nango connection back to a workspace+client space+integration, since
 * Nango assigns connection ids as random UUIDs the caller cannot choose —
 * see NANGO_MIGRATION_LOG.md D-008/D-011.
 */
export type ConnectSessionTags = Record<string, string>;

export interface CreateConnectSessionOptions {
  tags: ConnectSessionTags;
  /** Restricts which Nango integration(s) the Connect UI offers — pass the
   * single provider being connected (e.g. ["google"] or ["slack"]). */
  allowedIntegrations: string[];
}

export interface ConnectSession {
  token: string;
  expiresAt: string;
}

/**
 * Mints a short-lived (30m, per Nango's docs) connect session token for the
 * frontend Connect UI (`nango.openConnectUI()` + `setSessionToken()`). Must
 * be called from a server action/route — NANGO_SECRET_KEY never reaches
 * the client.
 */
export async function createConnectSession(options: CreateConnectSessionOptions): Promise<ConnectSession> {
  const env = nangoEnv();
  const res = await fetch(`${env.NANGO_SERVER_URL}/connect/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NANGO_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tags: options.tags,
      allowed_integrations: options.allowedIntegrations,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nango createConnectSession failed with ${res.status}: ${text || res.statusText}`);
  }

  const body = (await res.json()) as { data: { token: string; expires_at: string } };
  return { token: body.data.token, expiresAt: body.data.expires_at };
}
