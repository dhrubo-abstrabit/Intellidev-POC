import type { ConnectorId } from "@/connectors/types";

/**
 * Connectors that go through the shared OAuth handshake. Hardcoded rather
 * than derived from connectors/registry.ts's `listConnectors()` because it
 * doubles as the URL allow-list for the dynamic callback route
 * (api/oauth/[provider]/callback) — an unexpected `provider` segment must
 * 404 there, not throw an unhandled 500 out of `getConnector()`. Keep this
 * in sync with which connectors set `requiresOAuth: true`.
 */
export const OAUTH_PROVIDERS = ["slack", "google_drive", "google_chat", "gmail"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Narrows an OAuthProvider (a route-param-shaped string) to a full
 * ConnectorId — safe because OAUTH_PROVIDERS is a subset of ConnectorId. */
export function oauthProviderToConnectorId(provider: OAuthProvider): ConnectorId {
  return provider;
}
