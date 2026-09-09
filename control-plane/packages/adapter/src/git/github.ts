/**
 * The slice of the GitHub API we need: open a PR, and find one that already exists.
 *
 * Tokens come from the broker per call rather than being held here, so a run longer than
 * an hour opens its PR with a fresh token.
 */

export interface RepoRef {
  owner: string
  repo: string
}

/**
 * Parse `owner/repo` out of the forms a manifest might carry.
 *
 * Accepts `github.com/acme/web`, `https://github.com/acme/web.git`,
 * `git@github.com:acme/web.git` and bare `acme/web`, because all four turn up in real
 * project config and failing on one of them at PR time wastes the whole run.
 */
export function parseRepoRef(url: string): RepoRef {
  const trimmed = url.trim().replace(/\.git$/, '')
  const scp = /^[^@]+@[^:]+:(?<owner>[^/]+)\/(?<repo>[^/]+)$/.exec(trimmed)
  if (scp?.groups) return { owner: scp.groups['owner']!, repo: scp.groups['repo']! }

  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, '')
  const segments = withoutScheme.split('/').filter(Boolean)
  const tail = segments.slice(-2)
  if (tail.length !== 2 || !tail[0] || !tail[1]) {
    throw new Error(`cannot parse owner/repo from "${url}"`)
  }
  return { owner: tail[0], repo: tail[1] }
}

export interface OpenPullRequestInput {
  repo: RepoRef
  head: string
  base: string
  title: string
  body: string
  draft?: boolean
}

export interface PullRequest {
  number: number
  url: string
}

export interface GitHubClientOptions {
  /** Fetched per call, so a long run never pushes with an expired token. */
  token: () => Promise<string>
  apiBase?: string
  fetchImpl?: typeof fetch
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch
  private readonly apiBase: string

  constructor(private readonly opts: GitHubClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.apiBase = opts.apiBase ?? 'https://api.github.com'
  }

  async openPullRequest(input: OpenPullRequestInput): Promise<PullRequest> {
    const { repo } = input
    const res = await this.request('POST', `/repos/${repo.owner}/${repo.repo}/pulls`, {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft ?? false,
    })

    if (res.status === 422) {
      // GitHub returns 422 when a PR for this head already exists. A retried or resumed
      // run must adopt it rather than fail — the branch and the work are still ours.
      const existing = await this.findOpenPullRequest(repo, input.head)
      if (existing) return existing
    }

    if (!res.ok) {
      throw new Error(`open PR failed: ${res.status} ${await res.text().catch(() => '')}`)
    }
    const json = (await res.json()) as { number: number; html_url: string }
    return { number: json.number, url: json.html_url }
  }

  async findOpenPullRequest(repo: RepoRef, head: string): Promise<PullRequest | null> {
    const res = await this.request(
      'GET',
      `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(
        `${repo.owner}:${head}`,
      )}`,
    )
    if (!res.ok) return null
    const list = (await res.json()) as Array<{ number: number; html_url: string }>
    const first = list[0]
    return first ? { number: first.number, url: first.html_url } : null
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.opts.token()
    return this.fetchImpl(new URL(path, this.apiBase), {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}
