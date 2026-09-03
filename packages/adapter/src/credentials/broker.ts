import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { StageId } from '@intellidev/shared'
import { CredentialCache } from './cache.js'
import {
  GITHUB_APP_USERNAME,
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  shouldAnswer,
} from './git-helper.js'
import type { BrokerAccess, CredentialProvider } from './types.js'

/**
 * The credential broker.
 *
 * HTTP over a unix socket rather than a bespoke line protocol: the git helper is a
 * short-lived subprocess, and `http.request({ socketPath })` is already in Node with
 * no framing to get wrong.
 *
 * Three properties this buys, in order of importance:
 *
 *  1. **Pull, not push.** Nothing long-lived sits in the environment, and a run that
 *     outlives a one-hour token keeps working because the next request refreshes it.
 *  2. **An audit trail.** Every credential use is a recorded request, including the
 *     refusals. Injected environment variables leave no such trace.
 *  3. **Stage scoping.** A request can be refused because the stage asking has no
 *     business with it — the design stage does not need database credentials.
 *
 * The socket is created 0600 and owned by the adapter's uid. That is what makes it a
 * boundary: the harness runs as a different uid and cannot open it.
 */
export interface BrokerOptions {
  socketPath: string
  provider: CredentialProvider
  /** Hosts we will answer git credential requests for. */
  allowedGitHosts?: readonly string[]
  /** Which stage is running now, so requests can be scoped to it. */
  currentStage?: () => StageId | null
  /** Stages allowed to ask for project secrets. Empty means all. */
  secretStages?: readonly StageId[]
  onAccess?: (access: BrokerAccess) => void
  now?: () => Date
}

export class CredentialBroker {
  private server: Server | null = null
  private readonly cache: CredentialCache
  private readonly accesses: BrokerAccess[] = []

  constructor(private readonly opts: BrokerOptions) {
    this.cache = new CredentialCache()
  }

  /** Every request seen, newest last. The audit trail for this run. */
  get log(): readonly BrokerAccess[] {
    return this.accesses
  }

  get refreshCount(): number {
    return this.cache.refreshCount
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.opts.socketPath), { recursive: true })
    // A stale socket from a crashed previous process would make listen() fail.
    await unlink(this.opts.socketPath).catch(() => {})

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('broker error')
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.opts.socketPath, resolve)
    })
    // Owner-only. With the harness on a different uid this is the actual boundary.
    await chmod(this.opts.socketPath, 0o600)
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await unlink(this.opts.socketPath).catch(() => {})
    this.server = null
  }

  private record(access: Omit<BrokerAccess, 'at'>): void {
    const entry: BrokerAccess = {
      ...access,
      at: (this.opts.now?.() ?? new Date()).toISOString(),
    }
    this.accesses.push(entry)
    this.opts.onAccess?.(entry)
  }

  private stage(): StageId | null {
    return this.opts.currentStage?.() ?? null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://broker.local')
    const body = await readBody(req)

    switch (url.pathname) {
      case '/git-credential':
        return this.gitCredential(body, res)
      case '/seat':
        return this.seat(url, res)
      case '/seat-rotation':
        return this.seatRotation(body, res)
      case '/mcp-token':
        return this.mcpToken(url, res)
      case '/secrets':
        return this.secrets(res)
      case '/healthz':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      default:
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('no such credential')
    }
  }

  private async gitCredential(body: string, res: ServerResponse): Promise<void> {
    const request = parseGitCredentialRequest(body)
    const hosts = this.opts.allowedGitHosts ?? ['github.com']

    if (!shouldAnswer(request, hosts)) {
      this.record({
        kind: 'git',
        detail: request.host ?? '<none>',
        stage: this.stage(),
        granted: false,
        reason: 'host not allowed',
      })
      // Empty body, not an error: git reads this as "no credential available" and
      // moves on, which is what we want for a host that is not ours.
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('')
      return
    }

    const host = request.host as string
    const cred = await this.cache.get(
      `git:${host}`,
      () => this.opts.provider.gitCredential(host),
      (value) => value.expiresAt,
    )
    this.record({ kind: 'git', detail: host, stage: this.stage(), granted: true })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      formatGitCredentialResponse({
        username: cred.username || GITHUB_APP_USERNAME,
        password: cred.password,
      }),
    )
  }

  private async seat(url: URL, res: ServerResponse): Promise<void> {
    const harness = url.searchParams.get('harness') ?? ''
    if (!harness) {
      this.record({
        kind: 'seat',
        detail: '<none>',
        stage: this.stage(),
        granted: false,
        reason: 'harness missing',
      })
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'harness required' }))
      return
    }
    const cred = await this.cache.get(
      `seat:${harness}`,
      () => this.opts.provider.seatCredential(harness),
      (value) => value.expiresAt,
    )
    this.record({ kind: 'seat', detail: harness, stage: this.stage(), granted: true })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(cred))
  }

  /**
   * A credential the harness rotated for itself, passed upstream.
   *
   * Deliberately forgiving: a provider that cannot store rotations answers 200 and does
   * nothing, because a local run keeps its credential on disk where it already belongs. Failing
   * here would turn a housekeeping detail into a run-ending error.
   */
  private async seatRotation(body: string, res: ServerResponse): Promise<void> {
    try {
      const parsed = JSON.parse(body || '{}') as {
        harness?: string
        files?: Array<{ path: string; contents: string }>
      }
      await this.opts.provider.reportSeat?.(parsed.harness ?? '', parsed.files ?? [])
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    } catch (error) {
      // Recorded, not raised. The run is unaffected either way: the container still holds a
      // working credential; only the stored copy misses an update.
      this.record({
        kind: 'seat',
        detail: `rotation not stored: ${error instanceof Error ? error.message : String(error)}`,
        stage: this.stage(),
        granted: false,
      })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
  }

  private async mcpToken(url: URL, res: ServerResponse): Promise<void> {
    const serverId = url.searchParams.get('server') ?? ''
    if (!serverId) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'server required' }))
      return
    }
    const token = await this.cache.get(
      `mcp:${serverId}`,
      () => this.opts.provider.mcpToken(serverId),
      (value) => value.expiresAt,
    )
    this.record({ kind: 'mcp', detail: serverId, stage: this.stage(), granted: true })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(token))
  }

  private async secrets(res: ServerResponse): Promise<void> {
    const stage = this.stage()
    const allowed = this.opts.secretStages

    // Refusing by stage is the one thing an injected environment variable can never do.
    if (allowed && allowed.length > 0 && (!stage || !allowed.includes(stage))) {
      this.record({
        kind: 'secrets',
        detail: stage ?? '<none>',
        stage,
        granted: false,
        reason: 'stage not permitted',
      })
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'secrets not available to this stage' }))
      return
    }

    if (!stage) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no stage in progress' }))
      return
    }

    const resolved = await this.opts.provider.secrets(stage)
    this.record({
      kind: 'secrets',
      detail: `${Object.keys(resolved.values).length} values`,
      stage,
      granted: true,
      ...(resolved.unresolved.length > 0
        ? { reason: `unresolved: ${resolved.unresolved.join(',')}` }
        : {}),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(resolved))
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      // A credential request is a handful of lines; anything larger is not one.
      if (body.length > 64_000) reject(new Error('request too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
