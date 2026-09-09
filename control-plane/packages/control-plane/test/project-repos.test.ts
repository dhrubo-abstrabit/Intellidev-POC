import { describe, expect, it } from 'vitest'
import { AppNotInstalled, GitHubApp } from '../src/github/app.js'

/**
 * Adding a repository to a project checks that the App can reach it.
 *
 * The alternative is discovering it thirty seconds into a run: a repository the App is not
 * installed on produces a 403 from `git push` inside a container, which reaches a person as a
 * failed run rather than as a form error naming the fix. That is the difference this makes, and
 * it is why `describeRepository` mints a token rather than only looking the installation up —
 * an installation says the App is on the *owner*, not that this repository was selected.
 */

/** A GitHub stand-in, so the shapes that matter can be produced deliberately. */
function fakeGitHub(
  handlers: Record<string, () => { ok: boolean; status?: number; body?: unknown }>,
) {
  // Typed as the real `fetch`, so the fake cannot drift from the signature it stands in for.
  const impl: typeof fetch = async (input) => {
    const url = String(input)
    // Matched on the path *ending*, because substring matching is ambiguous in both
    // directions here: `/app/installations/42/access_tokens` contains `/installation`, and
    // `/repos/acme/widget/installation` contains `/repos/acme/widget`.
    const path = url.split('?')[0] ?? ''
    const key = Object.keys(handlers).find((k) => path.endsWith(k))
    const result = key ? handlers[key]!() : { ok: false, status: 404, body: {} }
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 404),
      json: async () => result.body ?? {},
      text: async () => JSON.stringify(result.body ?? {}),
    } as unknown as Response
  }
  return impl
}

const KEY = `-----BEGIN RSA PRIVATE KEY-----
${'A'.repeat(64)}
-----END RSA PRIVATE KEY-----`

/** Signing is exercised elsewhere; here the JWT only has to be produced without throwing. */
function appWith(fetchImpl: typeof fetch): GitHubApp {
  const app = new GitHubApp({ appId: '1', privateKey: KEY, slug: 'intellidev-bot', fetchImpl })
  // The private key is not a real one, so stub the assertion rather than the network.
  ;(app as unknown as { appJwt: () => string }).appJwt = () => 'jwt'
  return app
}

describe('verifying a repository before it is added', () => {
  it('reports the installation and default branch when the App can reach it', async () => {
    const app = appWith(
      fakeGitHub({
        '/installation': () => ({ ok: true, body: { id: 42 } }),
        '/access_tokens': () => ({
          ok: true,
          body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() },
        }),
        '/repos/acme/widget': () => ({
          ok: true,
          body: { default_branch: 'trunk', private: true },
        }),
      }),
    )
    const found = await app.describeRepository('acme', 'widget')
    expect(found.installationId).toBe(42)
    // Taken from GitHub rather than assumed: a repository's default is not always `main`.
    expect(found.defaultBranch).toBe('trunk')
    expect(found.private).toBe(true)
  })

  it('refuses when the App is not installed at all, with the install link', async () => {
    const app = appWith(fakeGitHub({ '/installation': () => ({ ok: false, status: 404 }) }))
    const error = await app.describeRepository('torvalds', 'linux').catch((e: Error) => e)
    expect(error).toBeInstanceOf(AppNotInstalled)
    // The link is the whole remedy, so it has to be in the message a person sees.
    expect(String(error)).toContain('https://github.com/apps/intellidev-bot/installations/new')
  })

  it('refuses when the App is on the owner but this repository was not selected', async () => {
    // The case a bare installation lookup would miss: the installation exists and a token
    // mints, but the repository still will not answer.
    const app = appWith(
      fakeGitHub({
        '/installation': () => ({ ok: true, body: { id: 42 } }),
        '/access_tokens': () => ({
          ok: true,
          body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() },
        }),
        '/repos/acme/secret': () => ({ ok: false, status: 404 }),
      }),
    )
    await expect(app.describeRepository('acme', 'secret')).rejects.toBeInstanceOf(AppNotInstalled)
  })

  it('defaults the branch to main when GitHub does not say', async () => {
    const app = appWith(
      fakeGitHub({
        '/installation': () => ({ ok: true, body: { id: 7 } }),
        '/access_tokens': () => ({
          ok: true,
          body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() },
        }),
        '/repos/acme/widget': () => ({ ok: true, body: {} }),
      }),
    )
    expect((await app.describeRepository('acme', 'widget')).defaultBranch).toBe('main')
  })
})

describe('listing what an installation covers', () => {
  it('returns the repositories, for a picker', async () => {
    const app = appWith(
      fakeGitHub({
        '/installation': () => ({ ok: true, body: { id: 7 } }),
        '/access_tokens': () => ({
          ok: true,
          body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() },
        }),
        '/installation/repositories': () => ({
          ok: true,
          body: {
            repositories: [
              { name: 'widget', default_branch: 'main', owner: { login: 'acme' } },
              { name: 'gadget', owner: { login: 'acme' } },
            ],
          },
        }),
      }),
    )
    const repos = await app.listRepositories('acme', 'widget')
    expect(repos).toEqual([
      { owner: 'acme', repo: 'widget', defaultBranch: 'main' },
      { owner: 'acme', repo: 'gadget', defaultBranch: 'main' },
    ])
  })

  it('returns nothing rather than throwing when the listing fails', async () => {
    // A picker that cannot list is an empty picker; it should not take down the page that
    // renders it.
    const app = appWith(
      fakeGitHub({
        '/installation': () => ({ ok: true, body: { id: 7 } }),
        '/access_tokens': () => ({
          ok: true,
          body: { token: 'ghs_x', expires_at: new Date(Date.now() + 3.6e6).toISOString() },
        }),
        '/installation/repositories': () => ({ ok: false, status: 500 }),
      }),
    )
    expect(await app.listRepositories('acme', 'widget')).toEqual([])
  })
})
