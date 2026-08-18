import { randomBytes } from 'node:crypto'
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js'
import type { McpRegistry } from './registry.js'
import type { McpServerRecord } from './types.js'

/**
 * OAuth 2.1 for MCP servers, run entirely in the control plane.
 *
 * Every primitive here comes from the MCP SDK rather than being hand-rolled — discovery
 * (RFC 9728), dynamic client registration (RFC 7591), PKCE, and the token grants. Writing
 * those by hand is how audience and PKCE bugs get introduced, and the SDK is already a
 * dependency because the gateway speaks MCP.
 *
 * The flow deliberately stops at the control plane boundary: a run receives the resulting
 * access token as a plain bearer credential, so nothing about OAuth reaches the container or
 * the harness config.
 */
export interface PendingAuthorization {
  serverId: string
  state: string
  codeVerifier: string
  redirectUri: string
  authorizationServerUrl: string
  metadata?: AuthorizationServerMetadata
  resource?: URL
  startedAt: number
}

/** Ten minutes: long enough for a consent screen, short enough to not accumulate. */
const PENDING_TTL_MS = 10 * 60 * 1000

export class McpOAuth {
  /**
   * In memory, keyed by `state`.
   *
   * A control-plane restart mid-consent therefore loses the flow and the callback fails with
   * "unknown state". That is an accepted limitation of the local path — the alternative is
   * persisting a PKCE verifier, which is a credential, to buy robustness against a restart
   * that takes seconds to recover from by clicking Connect again.
   */
  private readonly pending = new Map<string, PendingAuthorization>()

  constructor(private readonly registry: McpRegistry) {}

  /**
   * Discover, register a client if needed, and build the URL to send the human to.
   *
   * Discovery happens on every connect rather than being cached at add-time, because an
   * authorization server can move its endpoints and a stale cache would fail in a way that
   * looks like a credential problem.
   */
  async begin(
    server: McpServerRecord,
    redirectUri: string,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const info = await discoverOAuthServerInfo(server.url)
    const authorizationServerUrl = info.authorizationServerUrl
    const metadata = info.authorizationServerMetadata

    // RFC 9728: the token has to be minted for the resource the MCP server declares, not for
    // whatever URL we happen to have typed — they differ as soon as a query string is added.
    const resource = info.resourceMetadata?.resource
      ? new URL(info.resourceMetadata.resource)
      : new URL(server.url)

    const scope =
      server.oauth?.scope ??
      info.resourceMetadata?.scopes_supported?.join(' ') ??
      metadata?.scopes_supported?.join(' ')

    const client = await this.clientFor(server, {
      authorizationServerUrl,
      metadata,
      redirectUri,
      scope,
    })

    const state = randomBytes(16).toString('base64url')
    const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
      ...(metadata ? { metadata } : {}),
      clientInformation: { client_id: client.clientId, client_secret: client.clientSecret },
      redirectUrl: redirectUri,
      ...(scope ? { scope } : {}),
      state,
      resource,
    })

    this.sweep()
    this.pending.set(state, {
      serverId: server.id,
      state,
      codeVerifier,
      redirectUri,
      authorizationServerUrl,
      ...(metadata ? { metadata } : {}),
      resource,
      startedAt: Date.now(),
    })

    return { authorizationUrl: authorizationUrl.toString(), state }
  }

  /** Exchange the code for tokens and store them against the server. */
  async complete(state: string, code: string): Promise<McpServerRecord> {
    const flow = this.pending.get(state)
    if (!flow) {
      throw new Error(
        'unknown or expired authorization state — start the connection again from the UI',
      )
    }
    this.pending.delete(state)

    const server = this.registry.get(flow.serverId)
    if (!server?.oauth) throw new Error(`MCP server ${flow.serverId} is no longer registered`)

    const tokens = await exchangeAuthorization(flow.authorizationServerUrl, {
      ...(flow.metadata ? { metadata: flow.metadata } : {}),
      clientInformation: {
        client_id: server.oauth.clientId,
        ...(server.oauth.clientSecret ? { client_secret: server.oauth.clientSecret } : {}),
      },
      authorizationCode: code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      ...(flow.resource ? { resource: flow.resource } : {}),
    })

    return this.registry.patch(server.id, {
      oauth: {
        ...server.oauth,
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.expires_in
          ? { expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }
          : {}),
      },
      health: 'unknown',
      lastError: undefined,
    })
  }

  /**
   * The bearer token a run should use, refreshed if it is close to expiring.
   *
   * Called at dispatch rather than inside the container, so a run never has to know how its
   * credential was obtained — and a token that expires mid-run is a known gap: a run longer
   * than the token's life will start failing upstream calls, because nothing refreshes it
   * once the container has it.
   */
  async accessToken(server: McpServerRecord): Promise<string | undefined> {
    if (server.auth === 'none') return undefined
    if (server.auth === 'bearer') return server.token
    if (!server.oauth?.accessToken) return undefined

    const expiresAt = server.oauth.expiresAt ? Date.parse(server.oauth.expiresAt) : 0
    // A minute of slack, so a token does not expire between here and the upstream call.
    const stale = !expiresAt || expiresAt - Date.now() < 60_000
    if (!stale || !server.oauth.refreshToken) return server.oauth.accessToken

    try {
      const info = await discoverOAuthServerInfo(server.url)
      const tokens = await refreshAuthorization(info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        clientInformation: {
          client_id: server.oauth.clientId,
          ...(server.oauth.clientSecret ? { client_secret: server.oauth.clientSecret } : {}),
        },
        refreshToken: server.oauth.refreshToken,
        ...(server.oauth.resource ? { resource: new URL(server.oauth.resource) } : {}),
      })
      const updated = await this.registry.patch(server.id, {
        oauth: {
          ...server.oauth,
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(tokens.expires_in
            ? { expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() }
            : {}),
        },
      })
      return updated.oauth?.accessToken
    } catch (error) {
      // Return the stale token rather than nothing: the upstream will answer 401 and the run
      // reports `upstream_unavailable`, which is a clearer signal than "no credential".
      await this.registry.patch(server.id, {
        lastError: `token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      return server.oauth.accessToken
    }
  }

  /** Reuse a registered client, or register one via RFC 7591. */
  private async clientFor(
    server: McpServerRecord,
    opts: {
      authorizationServerUrl: string
      metadata?: AuthorizationServerMetadata
      redirectUri: string
      scope?: string
    },
  ): Promise<{ clientId: string; clientSecret?: string }> {
    // A client is bound to its redirect URI, so a changed port means registering again.
    if (
      server.oauth?.clientId &&
      server.oauth.authorizationServerUrl === opts.authorizationServerUrl
    ) {
      return {
        clientId: server.oauth.clientId,
        ...(server.oauth.clientSecret ? { clientSecret: server.oauth.clientSecret } : {}),
      }
    }

    let registered: OAuthClientInformationFull
    try {
      registered = await registerClient(opts.authorizationServerUrl, {
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
        clientMetadata: {
          client_name: 'Intellidev (local)',
          redirect_uris: [opts.redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...(opts.scope ? { scope: opts.scope } : {}),
        },
      })
    } catch (error) {
      throw new Error(
        `dynamic client registration failed at ${opts.authorizationServerUrl}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Servers without RFC 7591 need a pre-registered client, which this local path does not support yet.`,
      )
    }

    await this.registry.patch(server.id, {
      oauth: {
        ...server.oauth,
        authorizationServerUrl: opts.authorizationServerUrl,
        clientId: registered.client_id,
        ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
      },
    })

    return {
      clientId: registered.client_id,
      ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [state, flow] of this.pending) {
      if (flow.startedAt < cutoff) this.pending.delete(state)
    }
  }
}
