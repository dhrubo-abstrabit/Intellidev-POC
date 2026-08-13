import { readFile } from 'node:fs/promises'
import { RunSpec, type StageId } from '@intellidev/shared'
import type {
  CredentialProvider,
  GitCredential,
  ResolvedSecrets,
  SeatCredential,
} from '../credentials/types.js'

/**
 * Where a run gets its spec and its credentials.
 *
 * Two implementations of each: the control plane, and a **local** one for developing and
 * testing the adapter without any of it. The local ones are deliberately separate classes
 * rather than flags, so nothing about them can be reached accidentally in production.
 */

export interface SpecProvider {
  load(): Promise<RunSpec>
}

/** Reads a spec from a file. For local runs and for tests. */
export class LocalSpecProvider implements SpecProvider {
  constructor(private readonly path: string) {}

  async load(): Promise<RunSpec> {
    const raw = await readFile(this.path, 'utf8')
    // Parsed, not cast: a hand-edited spec is exactly where a typo hides, and failing
    // here with a field name beats failing six stages later with `undefined`.
    return RunSpec.parse(JSON.parse(raw))
  }
}

/** Fetches the spec with the single-use RUN_TOKEN, as a real dispatch does. */
export class ControlPlaneSpecProvider implements SpecProvider {
  constructor(
    private readonly opts: {
      baseUrl: string
      runId: string
      runToken: string
      fetchImpl?: typeof fetch
    },
  ) {}

  async load(): Promise<RunSpec> {
    const impl = this.opts.fetchImpl ?? fetch
    const res = await impl(new URL(`/internal/runs/${this.opts.runId}/spec`, this.opts.baseUrl), {
      headers: { authorization: `Bearer ${this.opts.runToken}` },
    })
    if (!res.ok) {
      throw new Error(`spec fetch failed: ${res.status} ${await res.text().catch(() => '')}`)
    }
    return RunSpec.parse(await res.json())
  }
}

/**
 * Credentials from the local environment, for running the adapter on a workstation.
 *
 * NOT FOR PRODUCTION, and structured so that is hard to forget: there is no GitHub App,
 * the token is whatever is in the environment, and every credential is reported with a
 * short expiry so the refresh path still gets exercised rather than being bypassed by an
 * effectively-infinite TTL.
 */
export class LocalCredentialProvider implements CredentialProvider {
  constructor(
    private readonly opts: {
      /** A PAT with `repo` scope. In production this is an App installation token. */
      githubToken?: string
      /** Values for the project's declared secrets. */
      secrets?: Record<string, string>
      /** Deliberately short, so the cache's refresh path is exercised locally. */
      ttlSec?: number
    } = {},
  ) {}

  private expiry(): string {
    return new Date(Date.now() + (this.opts.ttlSec ?? 900) * 1000).toISOString()
  }

  async gitCredential(host: string): Promise<GitCredential> {
    const token = this.opts.githubToken ?? process.env['INTELLIDEV_GITHUB_TOKEN'] ?? ''
    if (!token) {
      throw new Error(
        `no local GitHub token for ${host}: set INTELLIDEV_GITHUB_TOKEN to push and open PRs`,
      )
    }
    // `x-access-token` works for both App tokens and PATs, so the local path uses the
    // same username as production rather than a special case.
    return { username: 'x-access-token', password: token, expiresAt: this.expiry() }
  }

  async seatCredential(harness: string): Promise<SeatCredential> {
    // Locally the harness CLIs use their own logins, so there is nothing to inject.
    return { harness, material: {}, expiresAt: this.expiry() }
  }

  async mcpToken(serverId: string): Promise<{ token: string; expiresAt: string }> {
    const token = process.env[`INTELLIDEV_MCP_TOKEN_${serverId.toUpperCase()}`] ?? ''
    if (!token) throw new Error(`no local token for MCP server "${serverId}"`)
    return { token, expiresAt: this.expiry() }
  }

  async secrets(_stage: StageId): Promise<ResolvedSecrets> {
    // Scoping by stage is the broker's job; this only resolves values.
    return { values: { ...this.opts.secrets }, unresolved: [] }
  }
}
