import type { HarnessId, StageId } from '@intellidev/shared'
import type { SeatRefresher } from '../harness/seat-refresher.js'
import type { SeatStore } from '../harness/seat-store.js'
import type { Store } from '../store/types.js'
import type { RunTokenRegistry } from './tokens.js'
import { AppNotInstalled, type GitHubApp } from '../github/app.js'

/**
 * The credential broker, control-plane side.
 *
 * This is what B3 exists for. Until now a run's credentials travelled in its container
 * environment: the GitHub token, every MCP token, the harness seat material. That is
 * readable by the model-authored code running inside the container, and on Fargate it is
 * also readable in the ECS console by anyone with `ecs:DescribeTasks`. So the run now holds
 * exactly one thing — its own run token — and *asks* for the rest.
 *
 * Three properties make that an actual boundary rather than a longer path to the same place:
 *
 *  - **Scoped to one run.** The token resolves to a run id, and every answer is computed
 *    from *that* run's task. A token cannot fetch another run's seat or another project's
 *    secrets, because the run id is never taken from the request body.
 *  - **Nothing is reusable.** Answers carry an expiry, and the token is revoked the moment
 *    the run settles, so a leaked token is useless shortly after the run it belonged to.
 *  - **Every grant is recorded.** A credential handed out with no trace is indistinguishable
 *    from one that leaked, so each call reports what was asked for and whether it was given.
 */

export interface CredentialGrant {
  readonly runId: string
  readonly kind: 'git' | 'seat' | 'mcp' | 'secrets'
  readonly detail: string
  readonly granted: boolean
  readonly reason?: string
  readonly at: string
}

export interface CredentialBrokerOptions {
  readonly store: Store
  readonly tokens: RunTokenRegistry
  readonly accounts: SeatStore
  /**
   * Keeps the harness seat alive, so a run is never handed a token that expires while it works.
   *
   * Optional: a store with no refresher configured behaves exactly as before, which is what the
   * in-memory development loop and most tests want.
   */
  readonly seatRefresher?: Pick<SeatRefresher, 'ensureFresh'>
  /** Resolves an upstream MCP server's current token, refreshing if needed. */
  readonly mcpToken: (serverId: string) => Promise<string | undefined>
  /**
   * The GitHub App. Preferred over a token when configured.
   *
   * Its private key never leaves this process — a run receives a minted installation token
   * scoped to its own repository, so a compromised run cannot mint more access.
   */
  readonly githubApp?: Pick<GitHubApp, 'tokenFor'>
  /** A personal access token, for local development when no App is configured. */
  readonly githubToken?: string
  /** How long an answer claims to be valid. Short, because a run re-asks cheaply. */
  readonly ttlSeconds?: number
  readonly onGrant?: (grant: CredentialGrant) => void
  readonly now?: () => number
}

/** Raised for a request that must become a 4xx rather than a 500. */
export class CredentialRefused extends Error {
  constructor(
    readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message)
  }
}

export class ControlPlaneCredentialBroker {
  constructor(private readonly opts: CredentialBrokerOptions) {}

  /**
   * Resolves a bearer token to the run it belongs to.
   *
   * Separate from the handlers so every one of them is forced to start from an
   * *authenticated* run id rather than a request field. That is the difference between a
   * broker and an open endpoint.
   */
  async authenticate(bearer: string | undefined): Promise<string> {
    const token = bearer?.replace(/^Bearer\s+/i, '').trim()
    const runId = token ? await this.opts.tokens.verify(token) : undefined
    if (!runId) throw new CredentialRefused(401, 'invalid or expired run token')

    const run = await this.opts.store.getRun(runId)
    if (!run) throw new CredentialRefused(404, 'run no longer exists')
    return runId
  }

  /**
   * A git credential for the run's own repository host.
   *
   * The host is checked against the run's task rather than trusted: a run asking for
   * credentials to a host it was never pointed at is either a bug or an exfiltration
   * attempt, and both deserve a refusal rather than a token.
   */
  async git(
    runId: string,
    host: string,
  ): Promise<{ username: string; password: string; expiresAt: string }> {
    const task = await this.taskFor(runId)
    const allowed = hostOf(task.repoUrl)

    if (!allowed || normaliseHost(host) !== allowed) {
      this.record(
        runId,
        'git',
        host,
        false,
        `run's repository is on ${allowed ?? 'an unknown host'}`,
      )
      throw new CredentialRefused(
        403,
        `no credential for ${host}: this run's repository is elsewhere`,
      )
    }

    /**
     * The App first, and the token only as a fallback.
     *
     * An installation token is scoped to this one repository and expires in an hour; a PAT
     * is scoped to everything the person who made it can reach and expires when they
     * remember. `x-access-token` is the username for both, so nothing downstream changes.
     */
    const repo = repoPathOf(task.repoUrl)
    if (this.opts.githubApp && repo) {
      try {
        const minted = await this.opts.githubApp.tokenFor(repo.owner, repo.repo)
        this.record(runId, 'git', `${repo.owner}/${repo.repo} (app)`, true)
        return { username: 'x-access-token', password: minted.token, expiresAt: minted.expiresAt }
      } catch (error) {
        if (error instanceof AppNotInstalled) {
          // A 403 with the install link, not a 500: nothing is broken, the App simply has
          // not been granted access to this repository yet.
          this.record(runId, 'git', host, false, 'app not installed on this repository')
          throw new CredentialRefused(403, error.message)
        }
        this.record(runId, 'git', host, false, `app token mint failed: ${describe(error)}`)
        throw new CredentialRefused(404, `could not mint a GitHub token: ${describe(error)}`)
      }
    }

    if (!this.opts.githubToken) {
      this.record(runId, 'git', host, false, 'no github app and no token configured')
      throw new CredentialRefused(
        404,
        'the control plane has no GitHub credential: install the GitHub App, or set ' +
          'INTELLIDEV_GITHUB_TOKEN for local development',
      )
    }

    this.record(runId, 'git', host, true, 'via personal access token')
    return { username: 'x-access-token', password: this.opts.githubToken, expiresAt: this.expiry() }
  }

  /**
   * The harness seat material the UI login stored.
   *
   * Refuses a harness the run was not dispatched for. Otherwise one run could pull the
   * credential for a harness it has no business touching.
   */
  async seat(
    runId: string,
    harness: string,
  ): Promise<{ harness: string; material: Record<string, unknown>; expiresAt: string }> {
    const task = await this.taskFor(runId)
    if (harness !== task.harness) {
      this.record(runId, 'seat', harness, false, `run is dispatched for ${task.harness}`)
      throw new CredentialRefused(
        403,
        `this run may only request its own harness (${task.harness})`,
      )
    }

    /**
     * Refreshed here, before the container ever sees it — never inside the run.
     *
     * Two runs sharing a seat is the normal case, and if each refreshed its own copy they would
     * both rotate the refresh token and invalidate each other; the loser fails mid-run looking
     * like an expired subscription. OpenAI says the same of codex outright: "Do not share the
     * same auth.json across concurrent jobs or multiple machines."
     *
     * Doing it here removes the reason a container would ever refresh: the token it is handed
     * has more life left than the run has budget. Concurrent requests collapse into one refresh
     * — a promise inside this process, an advisory lock across instances — so the token is
     * rotated once and everybody gets the same new one.
     *
     * A failure is deliberately not fatal: the stored credential may still work, and the
     * harness's own error is a better message than one invented here.
     */
    if (this.opts.seatRefresher) {
      await this.opts.seatRefresher
        .ensureFresh({ clientSpaceId: task.clientSpaceId }, task.harness as HarnessId)
        .catch(() => undefined)
    }

    const material = await this.opts.accounts.material(
      { clientSpaceId: task.clientSpaceId },
      task.harness as HarnessId,
    )
    // Empty material is a valid answer, not an error: opencode's free tier needs no login,
    // and a harness that does need one complains far more clearly than a boot failure.
    this.record(runId, 'seat', harness, true, material ? undefined : 'no account connected')
    return { harness, material: material ?? {}, expiresAt: this.expiry() }
  }

  /**
   * An upstream MCP token, but only for a server the run's task actually attached.
   *
   * The check matters more here than anywhere else: MCP tokens are third-party OAuth
   * credentials, so handing one to a run that was not given that server would leak access
   * to an unrelated system.
   */
  async mcp(runId: string, serverId: string): Promise<{ token: string; expiresAt: string }> {
    const task = await this.taskFor(runId)
    if (!task.mcpServerIds.includes(serverId)) {
      this.record(runId, 'mcp', serverId, false, 'server not attached to this task')
      throw new CredentialRefused(403, `MCP server "${serverId}" is not attached to this task`)
    }

    const token = await this.opts.mcpToken(serverId)
    if (!token) {
      this.record(runId, 'mcp', serverId, false, 'no token stored')
      throw new CredentialRefused(404, `no token for MCP server "${serverId}"`)
    }

    this.record(runId, 'mcp', serverId, true)
    return { token, expiresAt: this.expiry() }
  }

  /**
   * Project secrets for a stage.
   *
   * Deliberately empty rather than absent. There is no vault yet — B2 adds Secrets Manager
   * — and returning an empty set with the names it could not resolve lets a run say
   * precisely what it lacked, instead of failing on a 404 that reads like a broker fault.
   */
  async secrets(
    runId: string,
    stage: StageId,
  ): Promise<{ values: Record<string, string>; unresolved: string[] }> {
    await this.taskFor(runId)
    this.record(runId, 'secrets', stage, true, 'no secret store configured yet (B2)')
    return { values: {}, unresolved: [] }
  }

  private async taskFor(runId: string) {
    const run = await this.opts.store.getRun(runId)
    if (!run) throw new CredentialRefused(404, 'run no longer exists')
    const task = await this.opts.store.getTask(run.taskId)
    if (!task) throw new CredentialRefused(404, 'task no longer exists')
    return task
  }

  private expiry(): string {
    const ms = (this.opts.ttlSeconds ?? 15 * 60) * 1000
    return new Date((this.opts.now?.() ?? Date.now()) + ms).toISOString()
  }

  private record(
    runId: string,
    kind: CredentialGrant['kind'],
    detail: string,
    granted: boolean,
    reason?: string,
  ): void {
    this.opts.onGrant?.({
      runId,
      kind,
      detail,
      granted,
      ...(reason ? { reason } : {}),
      at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
    })
  }
}

/** The host a repository URL points at, or undefined if it is not a URL we understand. */
function hostOf(repoUrl: string): string | undefined {
  try {
    return normaliseHost(new URL(repoUrl).host)
  } catch {
    // `git@github.com:owner/repo.git` is not a URL, so match the scp-like form too.
    const scp = /^[^@]+@([^:]+):/.exec(repoUrl)
    return scp?.[1] ? normaliseHost(scp[1]) : undefined
  }
}

/** `owner` and `repo` from a repository URL, for scoping an installation token. */
function repoPathOf(repoUrl: string): { owner: string; repo: string } | undefined {
  const path = (() => {
    try {
      return new URL(repoUrl).pathname
    } catch {
      // `git@github.com:owner/repo.git`
      return /^[^@]+@[^:]+:(.+)$/.exec(repoUrl)?.[1]
    }
  })()
  const parts = (path ?? '')
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .split('/')
  return parts.length >= 2 && parts[0] && parts[1] ? { owner: parts[0], repo: parts[1] } : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '')
}
