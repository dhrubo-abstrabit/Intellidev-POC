import type { HarnessId, StageId } from '@intellidev/shared'
import type { HarnessAccounts } from '../harness/accounts.js'
import type { Store } from '../store/types.js'
import type { RunTokenRegistry } from './tokens.js'

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
  readonly accounts: HarnessAccounts
  /** Resolves an upstream MCP server's current token, refreshing if needed. */
  readonly mcpToken: (serverId: string) => Promise<string | undefined>
  /** The control plane's own GitHub credential. Never leaves this process as-is. */
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
    const runId = token ? this.opts.tokens.verify(token) : undefined
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

    if (!this.opts.githubToken) {
      this.record(runId, 'git', host, false, 'control plane holds no github token')
      throw new CredentialRefused(404, 'the control plane has no GitHub credential configured')
    }

    this.record(runId, 'git', host, true)
    // `x-access-token` works for both App installation tokens and PATs, so the shape does
    // not change when the App key replaces the PAT.
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

    const material = this.opts.accounts.materialFor(task.harness as HarnessId)
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

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '')
}
