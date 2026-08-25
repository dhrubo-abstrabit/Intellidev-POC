import { createSign } from 'node:crypto'

/**
 * Mints GitHub App installation tokens.
 *
 * This is what `docs/architecture.md` §8b always specified, and it is a materially better
 * boundary than the personal access token it replaces:
 *
 *  - **The private key never leaves this process.** A run receives a token, never the key,
 *    so a compromised run cannot mint more access after the one it holds expires.
 *  - **Tokens are scoped to one repository**, not to everything the human who made the PAT
 *    can reach. A leaked token from a run on `acme/widget` cannot touch `acme/billing`.
 *  - **They expire in an hour**, and the adapter's credential cache already refreshes
 *    before expiry — it exists for exactly this.
 *  - **Access is granted by installing the App**, which an org owner does once and can
 *    revoke without touching this deployment. A PAT belongs to a person and dies with them.
 *
 * Deliberately stateless about installations. There is no "connect" record to keep in sync,
 * because GitHub already knows where the App is installed: the installation is looked up
 * from the repository on demand. That makes a newly-installed repo work immediately and a
 * revoked one fail immediately, with nothing to reconcile.
 */

export interface GitHubAppOptions {
  /** Numeric App id from the App's settings page. */
  readonly appId: string
  /** PEM private key. Never logged, never returned, never sent anywhere but GitHub. */
  readonly privateKey: string
  /**
   * The App's slug, used to build the install link an error message offers.
   *
   * Optional because GitHub reports it: `GET /app` returns it, so it is discovered on first
   * use rather than being one more thing to copy correctly. Supplying it just skips a call.
   */
  readonly slug?: string
  readonly apiBase?: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
}

export interface InstallationToken {
  readonly token: string
  readonly expiresAt: string
}

/** Raised when the App simply is not installed where the run needs it. */
export class AppNotInstalled extends Error {
  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly installUrl: string | undefined,
  ) {
    super(
      `the GitHub App is not installed on ${owner}/${repo}` +
        (installUrl ? `. Install it here: ${installUrl}` : ''),
    )
  }
}

interface CachedToken {
  readonly token: string
  readonly expiresAtMs: number
}

export class GitHubApp {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  /** Keyed by `owner/repo`, because tokens are scoped per repository. */
  private readonly tokens = new Map<string, CachedToken>()
  private readonly installations = new Map<string, number>()
  private discoveredSlug: string | undefined
  private slugLookupFailed = false

  constructor(private readonly opts: GitHubAppOptions) {
    this.apiBase = opts.apiBase ?? 'https://api.github.com'
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Where a human goes to grant access, if the slug is known yet.
   *
   * Synchronous, so it is whatever has been discovered so far — `installUrl()` is only ever
   * used to enrich an error, and an error must not depend on another network call
   * succeeding.
   */
  get installUrl(): string | undefined {
    const slug = this.opts.slug ?? this.discoveredSlug
    return slug ? `https://github.com/apps/${slug}/installations/new` : undefined
  }

  /**
   * Asks GitHub what this App is called.
   *
   * Cached for the process lifetime: an App's slug changes only if it is renamed, and the
   * only cost of a stale one is a wrong link in an error message. Failures are swallowed —
   * losing the link is not worth failing a run over.
   */
  private async discoverSlug(): Promise<void> {
    if (this.opts.slug || this.discoveredSlug || this.slugLookupFailed) return
    try {
      const res = await this.fetchImpl(`${this.apiBase}/app`, { headers: this.appHeaders() })
      if (!res.ok) {
        this.slugLookupFailed = true
        return
      }
      const body = (await res.json()) as { slug?: string }
      if (body.slug) this.discoveredSlug = body.slug
      else this.slugLookupFailed = true
    } catch {
      this.slugLookupFailed = true
    }
  }

  /**
   * A token for one repository, cached until shortly before it expires.
   *
   * Refreshed two minutes early rather than on expiry: a token that expires mid-push fails
   * the push, and a run that has been going forty minutes has no way to recover it.
   */
  async tokenFor(owner: string, repo: string): Promise<InstallationToken> {
    const key = `${owner}/${repo}`.toLowerCase()
    const cached = this.tokens.get(key)
    const now = this.now()

    if (cached && cached.expiresAtMs - 2 * 60_000 > now) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() }
    }

    const installationId = await this.installationFor(owner, repo)
    const minted = await this.mint(installationId, repo)
    this.tokens.set(key, {
      token: minted.token,
      expiresAtMs: Date.parse(minted.expiresAt),
    })
    return minted
  }

  /**
   * Which installation covers a repository.
   *
   * Cached because it changes only when someone installs or uninstalls the App, and the
   * lookup costs a round trip on a path that already has one.
   */
  private async installationFor(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase()
    const known = this.installations.get(key)
    if (known !== undefined) return known

    const res = await this.fetchImpl(`${this.apiBase}/repos/${owner}/${repo}/installation`, {
      headers: this.appHeaders(),
    })

    if (res.status === 404) {
      // Not installed, or installed without this repository selected. Both mean the same
      // thing to the caller and have the same fix — so spend one call learning the slug,
      // because the install link is the most useful part of this message.
      this.installations.delete(key)
      await this.discoverSlug()
      throw new AppNotInstalled(owner, repo, this.installUrl)
    }
    if (!res.ok) {
      throw new Error(
        `could not find the App installation for ${owner}/${repo}: ${res.status} ${await safeText(res)}`,
      )
    }

    const body = (await res.json()) as { id?: number }
    if (typeof body.id !== 'number') {
      throw new Error(`GitHub returned no installation id for ${owner}/${repo}`)
    }
    this.installations.set(key, body.id)
    return body.id
  }

  /**
   * Exchanges the App JWT for an installation token.
   *
   * Scoped down twice on purpose: to the **single repository** the run needs, and to the
   * **two permissions** it needs. The App may be installed across an entire org, but a run
   * on one repository should not hold a credential that reaches the rest — that narrowing
   * is most of why this is better than a PAT.
   */
  private async mint(installationId: number, repo: string): Promise<InstallationToken> {
    const res = await this.fetchImpl(
      `${this.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: { ...this.appHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          repositories: [repo],
          permissions: { contents: 'write', pull_requests: 'write' },
        }),
      },
    )

    if (!res.ok) {
      const detail = await safeText(res)
      // A 422 here is almost always the App lacking a permission it is being asked to
      // delegate, which is a settings fix rather than a code one.
      throw new Error(
        `could not mint an installation token: ${res.status} ${detail}` +
          (res.status === 422
            ? '. Check the App grants Contents and Pull requests read/write.'
            : ''),
      )
    }

    const body = (await res.json()) as { token?: string; expires_at?: string }
    if (!body.token || !body.expires_at) {
      throw new Error('GitHub returned an installation token with no token or expiry')
    }
    return { token: body.token, expiresAt: body.expires_at }
  }

  private appHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.appJwt()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }
  }

  /**
   * The App's own JWT, signed with the private key.
   *
   * `iat` is backdated a minute because GitHub rejects a token whose issue time is in its
   * future, and a small clock skew between this host and GitHub is normal — that rejection
   * is otherwise a baffling 401. Ten minutes is GitHub's hard ceiling; nine keeps a margin.
   */
  appJwt(): string {
    const now = Math.floor(this.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const payload = { iat: now - 60, exp: now + 9 * 60, iss: this.opts.appId }

    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
    const signer = createSign('RSA-SHA256')
    signer.update(signingInput)
    const signature = signer.sign(this.opts.privateKey).toString('base64url')
    return `${signingInput}.${signature}`
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

async function safeText(res: Response): Promise<string> {
  return res
    .text()
    .then((t) => t.slice(0, 300))
    .catch(() => '')
}

/**
 * Reads App configuration from the environment.
 *
 * The key arrives as a PEM, which contains newlines — awkward in an env var, so a literal
 * `\n` is accepted and unescaped. Getting that wrong produces an opaque signing error, so
 * it is handled here rather than left to whoever sets the variable.
 */
export function gitHubAppFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubApp | undefined {
  const appId = env['GITHUB_APP_ID']
  const rawKey = env['GITHUB_APP_PRIVATE_KEY']
  if (!appId || !rawKey) return undefined

  const privateKey = rawKey.includes('\\n') ? rawKey.replace(/\\n/g, '\n') : rawKey
  if (!privateKey.includes('BEGIN')) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY does not look like a PEM. Paste the whole key including the ' +
        'BEGIN and END lines; newlines may be written as \\n.',
    )
  }

  return new GitHubApp({
    appId,
    privateKey,
    ...(env['GITHUB_APP_SLUG'] ? { slug: env['GITHUB_APP_SLUG'] } : {}),
  })
}
