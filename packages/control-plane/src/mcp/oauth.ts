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
import type { McpStore } from './store.js'
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

  /**
   * In-flight refreshes, keyed by server id, so only one runs at a time per server.
   *
   * Without this, two runs dispatched together both notice the same stale token and both POST
   * the same refresh token. Providers that rotate refresh tokens — Atlassian and Asana are
   * documented cases — treat the second POST as replay under RFC 6819 §5.2.2.3 and revoke the
   * whole token family, which means a permanent disconnect needing manual re-authorisation
   * rather than a retryable error.
   *
   * Concurrent dispatch is a normal thing here, not an edge case, so this is reachable. The
   * upstream SDK has the same gap open as issue #1760; it cannot be borrowed from there, and
   * this code calls `refreshAuthorization` directly rather than the `auth()` orchestrator, so
   * the guard has to live here.
   */
  private readonly refreshing = new Map<string, Promise<string | undefined>>()

  constructor(private readonly registry: McpStore) {}

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

    const server = await this.registry.get(flow.serverId)
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

    if (!isStale(server.oauth) || !server.oauth.refreshToken) return server.oauth.accessToken

    // Join a refresh already in flight rather than starting a second one.
    //
    // Two layers, and both are needed. This map collapses concurrent callers *inside* one
    // process, which is the common case and costs nothing. The store's lock serialises across
    // processes, which is the case that revokes a token family when it is missing.
    const existing = this.refreshing.get(server.id)
    if (existing) return existing

    const attempt = this.registry
      .withServerLock(server.id, async () => {
        // Re-read inside the lock. Whoever held it before may have just refreshed, in which
        // case there is a fresh token to use and nothing to do — refreshing again would
        // consume a rotated refresh token for no reason.
        const current = (await this.registry.get(server.id)) ?? server
        if (current.oauth?.accessToken && !isStale(current.oauth)) {
          return current.oauth.accessToken
        }
        return await this.refresh(current)
      })
      .finally(() => this.refreshing.delete(server.id))
    this.refreshing.set(server.id, attempt)
    return attempt
  }

  private async refresh(server: McpServerRecord): Promise<string | undefined> {
    if (!server.oauth?.refreshToken) return server.oauth?.accessToken

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
    // Reuse only when the existing registration covers BOTH this authorization server and
    // this exact redirect. Checking the server alone was a real bug: opening the UI on
    // `localhost` after registering from `127.0.0.1` reused the client, and the authorization
    // server refused the redirect with a message that named neither cause nor cure.
    const redirectUris = loopbackVariants(opts.redirectUri)
    if (
      server.oauth?.clientId &&
      server.oauth.authorizationServerUrl === opts.authorizationServerUrl &&
      server.oauth.redirectUris?.includes(opts.redirectUri)
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
          redirect_uris: redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...(opts.scope ? { scope: opts.scope } : {}),
        },
      })
    } catch (error) {
      /**
       * Lead with what the server actually said.
       *
       * FOUND BY READING ONE. Supabase refused a registration with `redirect_uris.0: URL must
       * use https, be localhost, or use a custom scheme` — the exact cause and cure — and the
       * panel showed a schema complaint about the *shape* of the error instead, because the SDK
       * validates the body against RFC 6749's `{error: string}` and a server that answers
       * `{message: ...}` fails that check first.
       *
       * So the raw body is hoisted to the front. The parse failure is kept afterwards, since a
       * server whose errors do not follow the spec is itself worth knowing about, but it is no
       * longer the first thing a person reads.
       */
      const said = rawServerMessage(error)
      throw new Error(
        `dynamic client registration failed at ${opts.authorizationServerUrl}: ` +
          `${said ?? (error instanceof Error ? error.message : String(error))}` +
          (said ? ` (full response: ${error instanceof Error ? error.message : String(error)})` : '') +
          `. Servers without RFC 7591 need a pre-registered client, which this path does not support yet.`,
      )
    }

    await this.registry.patch(server.id, {
      oauth: {
        ...server.oauth,
        authorizationServerUrl: opts.authorizationServerUrl,
        clientId: registered.client_id,
        ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
        redirectUris: registered.redirect_uris ?? redirectUris,
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

/**
 * Both spellings of a loopback callback, registered together.
 *
 * `127.0.0.1` and `localhost` reach the same server but are not the same redirect URI, and
 * which one is in play depends on what the human typed in the address bar. Registering both
 * makes switching between them free, rather than producing a refusal from the authorization
 * server that points at neither the cause nor the cure.
 */
function loopbackVariants(redirectUri: string): string[] {
  const url = new URL(redirectUri)
  const partner =
    url.hostname === '127.0.0.1' ? 'localhost' : url.hostname === 'localhost' ? '127.0.0.1' : null
  if (!partner) return [redirectUri]

  const other = new URL(redirectUri)
  other.hostname = partner
  return [redirectUri, other.toString()]
}

/**
 * Whether an access token is close enough to expiry to be worth replacing.
 *
 * A minute of slack, so a token does not expire between the check and the upstream call it is
 * about to be used for. Shared by the pre-check and the re-check inside the lock, because those
 * two disagreeing would mean a refresh that immediately decides it was unnecessary — or worse,
 * one that decides it *was* necessary after somebody else already did it.
 */
function isStale(oauth: { expiresAt?: string }): boolean {
  const expiresAt = oauth.expiresAt ? Date.parse(oauth.expiresAt) : 0
  return !expiresAt || expiresAt - Date.now() < 60_000
}

/**
 * The server's own words, dug out of an SDK error that wrapped them.
 *
 * The useful sentence is usually inside a `Raw body: {...}` suffix, behind a schema complaint
 * about a body that did not match RFC 6749. Returns undefined when there is nothing better to
 * say, so the caller keeps the original message rather than replacing it with silence.
 */
function rawServerMessage(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error)
  const raw = /Raw body:\s*(\{.*\})\s*$/s.exec(text)
  if (!raw) return undefined
  try {
    const body = JSON.parse(raw[1]!) as Record<string, unknown>
    const said = body['message'] ?? body['error_description'] ?? body['error']
    return typeof said === 'string' ? said : undefined
  } catch {
    return undefined
  }
}
