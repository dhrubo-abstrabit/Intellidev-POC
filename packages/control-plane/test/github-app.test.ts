import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { AppNotInstalled, GitHubApp, gitHubAppFromEnv } from '../src/github/app.js'

/**
 * The App is the credential design `architecture.md` §8b specified; these are the properties
 * that make it better than the token it replaces, asserted rather than assumed.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/** Records requests and replies from a queue, so each call can be inspected. */
function fakeGitHub(replies: Array<{ status: number; body?: unknown }>) {
  const seen: Array<{ url: string; method: string; auth: string; body?: unknown }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const reply = replies.shift() ?? { status: 500 }
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: String((init?.headers as Record<string, string>)?.['authorization'] ?? ''),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    })
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { seen, fetchImpl }
}

function app(fetchImpl: typeof fetch, now = () => 1_700_000_000_000) {
  return new GitHubApp({ appId: '12345', privateKey: PEM, slug: 'intellidev', fetchImpl, now })
}

describe('the App JWT', () => {
  it('is signed with the private key and verifies against the public one', () => {
    const jwt = app(fakeGitHub([]).fetchImpl).appJwt()
    const [header, payload, signature] = jwt.split('.')
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
  })

  it('backdates iat and stays inside GitHub ten-minute ceiling', () => {
    // GitHub rejects a token issued in its future, and a small clock skew is normal — that
    // rejection is otherwise a baffling 401.
    const jwt = app(fakeGitHub([]).fetchImpl).appJwt()
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as {
      iat: number
      exp: number
      iss: string
    }
    const now = Math.floor(1_700_000_000_000 / 1000)
    expect(claims.iat).toBeLessThan(now)
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(claims.iss).toBe('12345')
  })
})

describe('minting a token', () => {
  it('scopes it to one repository and two permissions', async () => {
    // The heart of why this beats a PAT: the App may be installed org-wide, but a run on
    // one repository must not hold a credential that reaches the rest.
    const gh = fakeGitHub([
      { status: 200, body: { id: 42 } },
      { status: 200, body: { token: 'ghs_scoped', expires_at: '2026-01-01T01:00:00Z' } },
    ])
    const token = await app(gh.fetchImpl).tokenFor('acme', 'widget')

    expect(token.token).toBe('ghs_scoped')
    expect(gh.seen[1]?.url).toContain('/app/installations/42/access_tokens')
    expect(gh.seen[1]?.body).toEqual({
      repositories: ['widget'],
      permissions: { contents: 'write', pull_requests: 'write' },
    })
  })

  it('authenticates the exchange with the App JWT, never a token', async () => {
    const gh = fakeGitHub([
      { status: 200, body: { id: 42 } },
      { status: 200, body: { token: 'ghs_x', expires_at: '2026-01-01T01:00:00Z' } },
    ])
    await app(gh.fetchImpl).tokenFor('acme', 'widget')
    for (const call of gh.seen) expect(call.auth).toMatch(/^Bearer eyJ/)
  })

  it('caches, so a second run on the same repo costs no round trips', async () => {
    const gh = fakeGitHub([
      { status: 200, body: { id: 42 } },
      { status: 200, body: { token: 'ghs_x', expires_at: '2026-01-01T01:00:00Z' } },
    ])
    const instance = app(gh.fetchImpl, () => Date.parse('2026-01-01T00:00:00Z'))
    await instance.tokenFor('acme', 'widget')
    await instance.tokenFor('acme', 'widget')
    expect(gh.seen).toHaveLength(2)
  })

  it('refreshes before expiry rather than on it', async () => {
    // A token that expires mid-push fails the push, and a run forty minutes in cannot
    // recover it.
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const gh = fakeGitHub([
      { status: 200, body: { id: 42 } },
      { status: 200, body: { token: 'first', expires_at: '2026-01-01T00:05:00Z' } },
      { status: 200, body: { token: 'second', expires_at: '2026-01-01T01:00:00Z' } },
    ])
    const instance = app(gh.fetchImpl, () => clock)
    expect((await instance.tokenFor('acme', 'widget')).token).toBe('first')
    // Three minutes in: still valid, but inside the two-minute refresh margin.
    clock = Date.parse('2026-01-01T00:03:30Z')
    expect((await instance.tokenFor('acme', 'widget')).token).toBe('second')
  })
})

describe('when the App is not installed', () => {
  it('says so, with the link to fix it', async () => {
    const gh = fakeGitHub([{ status: 404, body: { message: 'Not Found' } }])
    await expect(app(gh.fetchImpl).tokenFor('acme', 'widget')).rejects.toThrow(AppNotInstalled)
    await expect(
      app(fakeGitHub([{ status: 404 }]).fetchImpl).tokenFor('acme', 'widget'),
    ).rejects.toThrow(/github\.com\/apps\/intellidev\/installations\/new/)
  })

  it('explains a 422 as a permissions problem, since that is what it always is', async () => {
    const gh = fakeGitHub([
      { status: 200, body: { id: 42 } },
      { status: 422, body: { message: 'Unprocessable' } },
    ])
    await expect(app(gh.fetchImpl).tokenFor('acme', 'widget')).rejects.toThrow(
      /Contents and Pull requests read\/write/,
    )
  })
})

describe('configuration from the environment', () => {
  it('is absent unless both the id and the key are set', () => {
    expect(gitHubAppFromEnv({})).toBeUndefined()
    expect(gitHubAppFromEnv({ GITHUB_APP_ID: '1' })).toBeUndefined()
  })

  it('unescapes a PEM written with literal \\n', () => {
    // A PEM has newlines, which are awkward in an env var. Getting it wrong otherwise
    // produces an opaque signing error much later.
    const escaped = PEM.replace(/\n/g, '\\n')
    const instance = gitHubAppFromEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: escaped })
    expect(instance).toBeDefined()
    // Proof it round-tripped: signing only works with a valid key.
    expect(instance!.appJwt().split('.')).toHaveLength(3)
  })

  it('refuses something that is not a PEM at all', () => {
    expect(() =>
      gitHubAppFromEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'not-a-key' }),
    ).toThrow(/does not look like a PEM/)
  })
})
