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

/**
 * Reads a spec from a presigned URL.
 *
 * How a Fargate run gets its spec: the control plane writes the spec to S3 at dispatch and
 * presigns a GET for that one object. The run therefore holds no S3 permission at all —
 * which matters because one task definition serves every run, so any S3 grant on the task
 * role would be a grant over every other run's spec.
 *
 * Retries, because a 500 from S3 during a dispatch would otherwise waste the whole run;
 * a 403 is not retried, since an expired or unauthorised URL will not become valid.
 */
export class UrlSpecProvider implements SpecProvider {
  constructor(
    private readonly opts: {
      url: string
      fetchImpl?: typeof fetch
      maxAttempts?: number
      timeoutMs?: number
    },
  ) {}

  async load(): Promise<RunSpec> {
    const impl = this.opts.fetchImpl ?? fetch
    const maxAttempts = this.opts.maxAttempts ?? 3
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000)
      try {
        const res = await impl(this.opts.url, { signal: controller.signal })
        if (res.status === 403) {
          throw new Error(
            'spec fetch was refused (403): the presigned URL has expired or was not ' +
              'authorised. This is a dispatch-latency problem, not a bad spec.',
          )
        }
        if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`)
        // Parsed, not cast: failing here with a field name beats failing six stages later
        // with `undefined`.
        return RunSpec.parse(await res.json())
      } catch (error) {
        lastError = error
        if (error instanceof Error && error.message.includes('403')) throw error
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
        }
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(
      `spec fetch failed after ${maxAttempts} attempts: ` +
        (lastError instanceof Error ? lastError.message : String(lastError)),
    )
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
      /**
       * Per-server MCP tokens, keyed by server id.
       *
       * Passed in rather than only read from the environment, because inline mode runs in
       * the control plane's own process and should not have to mutate `process.env` to hand
       * a token to one run.
       */
      mcpTokens?: Record<string, string>
      /**
       * Harness subscription material, keyed by harness id.
       *
       * Read from `INTELLIDEV_SEAT_MATERIAL` when not passed, which is how it crosses into a
       * container: the material is a credential, so it travels in the environment rather than
       * in the run spec, which is written to a shared directory.
       */
      seatMaterial?: Record<string, Record<string, unknown>>
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
    const material = this.opts.seatMaterial?.[harness] ?? seatMaterialFromEnv()[harness]
    // Empty material is a valid answer, not an error: opencode's free tier needs no login, and
    // a harness that does need one reports it far more clearly than a bootstrap failure would.
    return { harness, material: material ?? {}, expiresAt: this.expiry() }
  }

  async mcpToken(serverId: string): Promise<{ token: string; expiresAt: string }> {
    const token =
      this.opts.mcpTokens?.[serverId] ??
      process.env[`INTELLIDEV_MCP_TOKEN_${serverId.toUpperCase()}`] ??
      ''
    if (!token) throw new Error(`no local token for MCP server "${serverId}"`)
    return { token, expiresAt: this.expiry() }
  }

  async secrets(_stage: StageId): Promise<ResolvedSecrets> {
    // Scoping by stage is the broker's job; this only resolves values.
    return { values: { ...this.opts.secrets }, unresolved: [] }
  }
}

/**
 * Seat material handed in through the environment.
 *
 * Parsed lazily and tolerantly: a malformed value should leave the harness unauthenticated with a
 * clear complaint from the harness itself, not stop the run from booting.
 */
function seatMaterialFromEnv(): Record<string, Record<string, unknown>> {
  const raw = process.env['INTELLIDEV_SEAT_MATERIAL']
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}
