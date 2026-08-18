import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { McpOAuth } from '../src/mcp/oauth.js'
import { McpRegistry } from '../src/mcp/registry.js'

/**
 * Counts how many times the SDK's refresh was actually called.
 *
 * Mocked at the module boundary rather than by injecting a seam, because the point of the
 * test is the number of network round trips the real code path makes.
 */
const refreshCalls: string[] = []
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthServerInfo: async () => ({
    authorizationServerUrl: 'https://as.test',
    authorizationServerMetadata: undefined,
    resourceMetadata: undefined,
  }),
  refreshAuthorization: async (_url: string, opts: { refreshToken: string }) => {
    refreshCalls.push(opts.refreshToken)
    // A rotating provider: every refresh mints a new refresh token and invalidates the old.
    await new Promise((resolve) => setTimeout(resolve, 25))
    return {
      access_token: `access_${refreshCalls.length}`,
      refresh_token: `rotated_${refreshCalls.length}`,
      expires_in: 3600,
    }
  },
  exchangeAuthorization: async () => ({ access_token: 'a', refresh_token: 'r' }),
  registerClient: async () => ({ client_id: 'c', redirect_uris: [] }),
  startAuthorization: async () => ({
    authorizationUrl: new URL('https://as.test'),
    codeVerifier: 'v',
  }),
}))

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'intellidev-oauth-'))
  const registry = await McpRegistry.open(join(dir, 'servers.json'))
  await registry.upsert({
    id: 'supabase',
    name: 'Supabase',
    url: 'https://mcp.test/mcp',
    auth: 'oauth2',
    health: 'ok',
    oauth: {
      authorizationServerUrl: 'https://as.test',
      clientId: 'c',
      accessToken: 'stale',
      refreshToken: 'original',
      // Already expired, so any call has to refresh.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  })
  return { registry, oauth: new McpOAuth(registry) }
}

describe('concurrent token refresh', () => {
  /**
   * REGRESSION GUARD. Two runs dispatched together both saw the same stale token and both
   * POSTed the same refresh token. A provider that rotates refresh tokens reads the second as
   * replay (RFC 6819 §5.2.2.3) and revokes the whole token family — a permanent disconnect,
   * not a retryable error. Concurrent dispatch is normal here, so this was reachable.
   */
  it('refreshes once for parallel callers and gives both the same token', async () => {
    refreshCalls.length = 0
    const { oauth, registry } = await fixture()
    const server = registry.get('supabase')!

    const [a, b, c] = await Promise.all([
      oauth.accessToken(server),
      oauth.accessToken(server),
      oauth.accessToken(server),
    ])

    expect(refreshCalls).toEqual(['original'])
    expect(a).toBe('access_1')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('refreshes again once the in-flight one has settled', async () => {
    refreshCalls.length = 0
    const { oauth, registry } = await fixture()

    await oauth.accessToken(registry.get('supabase')!)
    // Expire what the first refresh returned, so a second is genuinely due.
    const current = registry.get('supabase')!
    await registry.patch('supabase', {
      oauth: { ...current.oauth!, expiresAt: new Date(Date.now() - 1000).toISOString() },
    })

    await oauth.accessToken(registry.get('supabase')!)
    // The second refresh uses the ROTATED token, not the original.
    expect(refreshCalls).toEqual(['original', 'rotated_1'])
  })
})
