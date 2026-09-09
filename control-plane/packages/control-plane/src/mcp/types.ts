/**
 * A connected MCP server, as the control plane remembers it.
 *
 * Connected ONCE here, then reused by every task — which is the whole point of the gateway.
 * The container never performs OAuth: it is headless, so there is nobody to click "Allow".
 * The control plane completes consent, keeps the tokens, and hands each run a plain bearer
 * access token through the credential broker. That keeps the container's contract identical
 * whether a server uses a PAT or OAuth.
 */
export type McpAuthKind = 'none' | 'bearer' | 'oauth2'

export type McpHealth = 'unknown' | 'ok' | 'unauthorized' | 'error'

export interface McpOAuthState {
  /** Cached from discovery so a refresh does not have to walk RFC 9728 again. */
  authorizationServerUrl: string
  clientId: string
  /**
   * The redirect URIs the client was registered with.
   *
   * Stored because a client is bound to them: reusing a client id while sending a redirect it
   * was not registered for gets a flat `redirect_uri not allowed` from the authorization
   * server, which reads like a config error rather than the stale-registration it is.
   */
  redirectUris?: string[]
  /**
   * Present when the authorization server issues one even for a public client — Supabase
   * does, despite `token_endpoint_auth_method: none` being requested.
   */
  clientSecret?: string
  scope?: string
  /** The audience the tokens were minted for, from the resource metadata. */
  resource?: string
  accessToken?: string
  refreshToken?: string
  /** ISO. Absent means unknown, which is treated as "refresh before using". */
  expiresAt?: string
}

export interface McpServerRecord {
  id: string
  name: string
  url: string
  auth: McpAuthKind
  /** A static bearer token, for servers that authenticate with a PAT. */
  token?: string
  oauth?: McpOAuthState
  health: McpHealth
  /** Tool names as the agent will see them, recorded by the last verify. */
  tools?: string[]
  toolCount?: number
  verifiedAt?: string
  lastError?: string
}

/** What the browser is allowed to see: no tokens, ever. */
export interface McpServerPublic {
  id: string
  name: string
  url: string
  auth: McpAuthKind
  health: McpHealth
  tools?: string[]
  toolCount?: number
  verifiedAt?: string
  lastError?: string
  /** So the UI can show "connect" versus "reconnect" without seeing the token. */
  authorized: boolean
}

export function toPublic(record: McpServerRecord): McpServerPublic {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    auth: record.auth,
    health: record.health,
    ...(record.tools ? { tools: record.tools } : {}),
    ...(record.toolCount === undefined ? {} : { toolCount: record.toolCount }),
    ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    authorized:
      record.auth === 'none' ||
      (record.auth === 'bearer' && Boolean(record.token)) ||
      (record.auth === 'oauth2' && Boolean(record.oauth?.accessToken)),
  }
}
