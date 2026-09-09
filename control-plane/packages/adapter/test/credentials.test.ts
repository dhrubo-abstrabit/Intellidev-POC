import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvSpec, type StageId } from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialBroker, type BrokerOptions } from '../src/credentials/broker.js'
import { BrokerClient, fetchGitCredential } from '../src/credentials/client.js'
import { CredentialCache } from '../src/credentials/cache.js'
import { ControlPlaneProvider } from '../src/credentials/control-plane.js'
import {
  GITHUB_APP_USERNAME,
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  shouldAnswer,
} from '../src/credentials/git-helper.js'
import { runCredHelper } from '../src/cli/cred.js'
import { materialiseStageEnv, writeDotenv } from '../src/credentials/stage-env.js'
import type { CredentialProvider } from '../src/credentials/types.js'

// --- helpers ---------------------------------------------------------------

const iso = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString()

class FakeProvider implements CredentialProvider {
  gitCalls = 0
  seatCalls = 0
  constructor(
    private readonly gitTtlSec = 3600,
    private readonly secretValues: Record<string, string> = {},
    private readonly unresolved: string[] = [],
  ) {}
  async gitCredential() {
    this.gitCalls++
    return {
      username: GITHUB_APP_USERNAME,
      password: `ghs_token_${this.gitCalls}`,
      expiresAt: iso(this.gitTtlSec),
    }
  }
  async seatCredential(harness: string) {
    this.seatCalls++
    return { harness, material: { oauth: 'seat-material' }, expiresAt: iso(3600) }
  }
  async mcpToken(serverId: string) {
    return { token: `mcp_${serverId}`, expiresAt: iso(3600) }
  }
  async secrets() {
    return { values: this.secretValues, unresolved: this.unresolved }
  }
}

// --- protocol --------------------------------------------------------------

describe('git credential protocol', () => {
  it('parses the key=value block git writes', () => {
    const request = parseGitCredentialRequest(
      'protocol=https\nhost=github.com\npath=acme/web.git\n\n',
    )
    expect(request.protocol).toBe('https')
    expect(request.host).toBe('github.com')
    expect(request.path).toBe('acme/web.git')
  })

  it('joins repeated keys instead of overwriting them', () => {
    const request = parseGitCredentialRequest('wwwauth[]=Basic\nwwwauth[]=Bearer\n')
    expect(request.extra['wwwauth[]']).toBe('Basic\nBearer')
  })

  it('skips junk lines rather than throwing', () => {
    // A helper that dies on unexpected input turns a push into an unexplained failure.
    const request = parseGitCredentialRequest('garbage\n=novalue\nhost=github.com\n')
    expect(request.host).toBe('github.com')
  })

  it('formats a response git can read back', () => {
    expect(formatGitCredentialResponse({ username: 'x-access-token', password: 'p' })).toBe(
      'username=x-access-token\npassword=p\n\n',
    )
  })

  it('answers only for allowed https hosts', () => {
    const hosts = ['github.com']
    expect(shouldAnswer({ protocol: 'https', host: 'github.com', extra: {} }, hosts)).toBe(true)
    // Handing a GitHub token to whoever asks is the failure this prevents.
    expect(shouldAnswer({ protocol: 'https', host: 'evil.test', extra: {} }, hosts)).toBe(false)
    expect(shouldAnswer({ protocol: 'http', host: 'github.com', extra: {} }, hosts)).toBe(false)
    expect(shouldAnswer({ extra: {} }, hosts)).toBe(false)
  })
})

// --- cache -----------------------------------------------------------------

describe('CredentialCache', () => {
  it('serves a cached value without refetching', async () => {
    const cache = new CredentialCache(60, () => 1_000_000)
    let calls = 0
    const fetch = async () => {
      calls++
      return { v: calls, expiresAt: new Date(1_000_000 + 3_600_000).toISOString() }
    }
    await cache.get('k', fetch, (v) => v.expiresAt)
    await cache.get('k', fetch, (v) => v.expiresAt)
    expect(calls).toBe(1)
  })

  it('refreshes before expiry, not after', async () => {
    // The whole point: a token that expires mid-request has already failed.
    let now = 1_000_000
    const cache = new CredentialCache(60, () => now)
    let calls = 0
    const expiresAt = new Date(now + 100_000).toISOString()
    const fetch = async () => {
      calls++
      return { expiresAt }
    }
    await cache.get('k', fetch, (v) => v.expiresAt)
    now += 39_000 // 61s of life left, outside the 60s skew
    await cache.get('k', fetch, (v) => v.expiresAt)
    expect(calls).toBe(1)
    now += 2_000 // 59s left, inside the skew
    await cache.get('k', fetch, (v) => v.expiresAt)
    expect(calls).toBe(2)
  })

  it('shares one fetch between concurrent callers', async () => {
    const cache = new CredentialCache()
    let calls = 0
    const fetch = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return { expiresAt: iso(3600) }
    }
    // Four git operations starting at once must not mint four tokens.
    await Promise.all([
      cache.get('k', fetch, (v) => v.expiresAt),
      cache.get('k', fetch, (v) => v.expiresAt),
      cache.get('k', fetch, (v) => v.expiresAt),
      cache.get('k', fetch, (v) => v.expiresAt),
    ])
    expect(calls).toBe(1)
  })

  it('treats an unparseable expiry as already stale', async () => {
    const cache = new CredentialCache()
    let calls = 0
    const fetch = async () => {
      calls++
      return { expiresAt: 'not a date' }
    }
    await cache.get('k', fetch, (v) => v.expiresAt)
    await cache.get('k', fetch, (v) => v.expiresAt)
    // Re-fetching costs a round trip; trusting a bad date costs the run.
    expect(calls).toBe(2)
  })

  it('does not leave a poisoned pending promise after a failure', async () => {
    const cache = new CredentialCache()
    let calls = 0
    const fetch = async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return { expiresAt: iso(3600) }
    }
    await expect(cache.get('k', fetch, (v) => v.expiresAt)).rejects.toThrow('boom')
    await expect(cache.get('k', fetch, (v) => v.expiresAt)).resolves.toBeDefined()
  })
})

// --- broker over a real socket ---------------------------------------------

describe('CredentialBroker', () => {
  let dir: string
  let socketPath: string
  let broker: CredentialBroker | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intellidev-broker-'))
    socketPath = join(dir, 'broker.sock')
  })

  afterEach(async () => {
    await broker?.stop()
    broker = null
    await rm(dir, { recursive: true, force: true })
  })

  async function start(
    provider: CredentialProvider,
    opts: Partial<BrokerOptions> = {},
    stage: StageId | null = 'code',
  ) {
    broker = new CredentialBroker({
      socketPath,
      provider,
      currentStage: () => stage,
      ...opts,
    })
    await broker.start()
    return { broker, client: new BrokerClient(socketPath) }
  }

  it('creates the socket owner-only, which is what makes it a boundary', async () => {
    const { client } = await start(new FakeProvider())
    expect(await client.healthy()).toBe(true)
    const mode = (await stat(socketPath)).mode & 0o777
    // The harness runs as a different uid and so cannot open this.
    expect(mode).toBe(0o600)
  })

  it('answers a git credential request in git protocol form', async () => {
    const provider = new FakeProvider()
    const { client } = await start(provider)
    const cred = await fetchGitCredential(client, 'github.com')
    expect(cred?.username).toBe(GITHUB_APP_USERNAME)
    expect(cred?.password).toBe('ghs_token_1')
  })

  it('serves a second request from cache, without minting again', async () => {
    const provider = new FakeProvider()
    const { client, broker: b } = await start(provider)
    await fetchGitCredential(client, 'github.com')
    await fetchGitCredential(client, 'github.com')
    expect(provider.gitCalls).toBe(1)
    expect(b.refreshCount).toBe(1)
  })

  it('refreshes transparently when the token is about to expire', async () => {
    // T5 acceptance: a run outliving its token still pushes. 30s TTL is inside the
    // cache's 60s skew, so every request refreshes.
    const provider = new FakeProvider(30)
    const { client } = await start(provider)
    const first = await fetchGitCredential(client, 'github.com')
    const second = await fetchGitCredential(client, 'github.com')
    expect(provider.gitCalls).toBe(2)
    expect(first?.password).not.toBe(second?.password)
  })

  it('returns nothing for a host that is not ours', async () => {
    const { client, broker: b } = await start(new FakeProvider())
    const response = await client.gitCredential('protocol=https\nhost=evil.test\n\n')
    expect(response.trim()).toBe('')
    const refusal = b.log.find((a) => !a.granted)
    expect(refusal?.reason).toBe('host not allowed')
  })

  it('records every credential use, including refusals', async () => {
    const { client, broker: b } = await start(new FakeProvider())
    await fetchGitCredential(client, 'github.com')
    await client.seatCredential('opencode')
    await client.gitCredential('protocol=https\nhost=evil.test\n\n')
    expect(b.log.map((a) => `${a.kind}:${a.granted}`)).toEqual([
      'git:true',
      'seat:true',
      'git:false',
    ])
    // An injected environment variable leaves no trace like this.
    expect(b.log.every((a) => typeof a.at === 'string')).toBe(true)
  })

  it('serves seat material and mcp tokens', async () => {
    const { client } = await start(new FakeProvider())
    expect((await client.seatCredential('opencode')).material).toEqual({ oauth: 'seat-material' })
    expect((await client.mcpToken('sentry')).token).toBe('mcp_sentry')
  })

  it('refuses secrets to a stage that has no business with them', async () => {
    const { client, broker: b } = await start(
      new FakeProvider(3600, { DATABASE_URL: 'postgres://x' }),
      { secretStages: ['test', 'verify'] },
      'design',
    )
    await expect(client.secrets()).rejects.toThrow(/403/)
    const refusal = b.log.find((a) => a.kind === 'secrets')
    // Refusing by stage is the one thing an env var can never do.
    expect(refusal?.granted).toBe(false)
    expect(refusal?.reason).toBe('stage not permitted')
  })

  it('serves secrets to a permitted stage', async () => {
    const { client } = await start(
      new FakeProvider(3600, { DATABASE_URL: 'postgres://x' }),
      { secretStages: ['test'] },
      'test',
    )
    expect((await client.secrets()).values).toEqual({ DATABASE_URL: 'postgres://x' })
  })

  it('404s an unknown credential kind', async () => {
    await start(new FakeProvider())
    const client = new BrokerClient(socketPath)
    await expect(client.mcpToken('')).rejects.toThrow()
  })
})

// --- the helper CLI --------------------------------------------------------

describe('intellidev-cred', () => {
  let dir: string
  let socketPath: string
  let broker: CredentialBroker | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intellidev-cred-'))
    socketPath = join(dir, 'broker.sock')
  })
  afterEach(async () => {
    await broker?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  function io(stdin: string) {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      handle: {
        stdin: async () => stdin,
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
        socketPath,
      },
    }
  }

  it('writes a credential for get', async () => {
    broker = new CredentialBroker({ socketPath, provider: new FakeProvider() })
    await broker.start()
    const { out, handle } = io('protocol=https\nhost=github.com\n\n')
    expect(await runCredHelper(['git', 'get'], handle)).toBe(0)
    expect(out.join('')).toContain('password=ghs_token_1')
  })

  it('accepts store and erase silently', async () => {
    const { out, handle } = io('')
    // We hold nothing, and printing on every push would be noise.
    expect(await runCredHelper(['git', 'store'], handle)).toBe(0)
    expect(await runCredHelper(['git', 'erase'], handle)).toBe(0)
    expect(out.join('')).toBe('')
  })

  it('exits 0 with no output when the broker is unreachable', async () => {
    // Non-zero makes git abort with a helper error; empty output lets git report the
    // auth failure it actually hit, which is diagnosable.
    const { out, err, handle } = io('protocol=https\nhost=github.com\n\n')
    expect(await runCredHelper(['git', 'get'], handle)).toBe(0)
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('intellidev-cred')
  })

  it('rejects an unknown subject', async () => {
    const { handle } = io('')
    expect(await runCredHelper(['svn', 'get'], handle)).toBe(2)
  })
})

// --- stage env -------------------------------------------------------------

describe('materialiseStageEnv', () => {
  let dir: string
  let socketPath: string
  let broker: CredentialBroker | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intellidev-env-'))
    socketPath = join(dir, 'broker.sock')
  })
  afterEach(async () => {
    await broker?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  const spec = (secrets: unknown[]) =>
    EnvSpec.parse({ vars: { NODE_ENV: 'test', DATABASE_URL: 'placeholder' }, secrets })

  async function client(values: Record<string, string>, unresolved: string[] = []) {
    broker = new CredentialBroker({
      socketPath,
      provider: new FakeProvider(3600, values, unresolved),
      currentStage: () => 'test',
    })
    await broker.start()
    return new BrokerClient(socketPath)
  }

  it('skips the broker entirely when a stage has no secrets in scope', async () => {
    const c = await client({})
    const result = await materialiseStageEnv({
      envSpec: spec([
        {
          name: 'DATABASE_URL',
          source: 'aws-ssm',
          ref: '/db',
          stages: ['test'],
          sandboxAttested: true,
        },
      ]),
      stage: 'design',
      client: c,
    })
    expect(result.env).toEqual({ NODE_ENV: 'test', DATABASE_URL: 'placeholder' })
    expect(result.redactor.count()).toBe(0)
  })

  it('lets a resolved secret override the manifest placeholder', async () => {
    const c = await client({ DATABASE_URL: 'postgres://real:pw@host/db' })
    const result = await materialiseStageEnv({
      envSpec: spec([
        { name: 'DATABASE_URL', source: 'aws-ssm', ref: '/db', sandboxAttested: true },
      ]),
      stage: 'test',
      client: c,
    })
    expect(result.env['DATABASE_URL']).toBe('postgres://real:pw@host/db')
    expect(result.env['NODE_ENV']).toBe('test')
  })

  it('builds a redactor from the resolved values', async () => {
    const c = await client({ DATABASE_URL: 'postgres://real:pw@host/db' })
    const result = await materialiseStageEnv({
      envSpec: spec([
        { name: 'DATABASE_URL', source: 'aws-ssm', ref: '/db', sandboxAttested: true },
      ]),
      stage: 'test',
      client: c,
    })
    expect(result.redactor('connected to postgres://real:pw@host/db')).toBe(
      'connected to [redacted:DATABASE_URL]',
    )
  })

  it('ignores values the stage was not scoped for, even if the broker sends them', async () => {
    // A broker bug must not widen a stage's access.
    const c = await client({ DATABASE_URL: 'db', OTHER_SECRET: 'leak' })
    const result = await materialiseStageEnv({
      envSpec: spec([
        { name: 'DATABASE_URL', source: 'aws-ssm', ref: '/db', sandboxAttested: true },
      ]),
      stage: 'test',
      client: c,
    })
    expect(result.env['OTHER_SECRET']).toBeUndefined()
  })

  it('reports declared secrets that did not resolve', async () => {
    const c = await client({}, ['STRIPE_KEY'])
    const result = await materialiseStageEnv({
      envSpec: spec([
        { name: 'STRIPE_KEY', source: 'aws-secrets', ref: 'arn:x', sandboxAttested: true },
      ]),
      stage: 'test',
      client: c,
    })
    expect(result.unresolved).toEqual(['STRIPE_KEY'])
  })

  it('refuses to run when the project overrides a name the adapter owns', async () => {
    const c = await client({})
    await expect(
      materialiseStageEnv({
        envSpec: EnvSpec.parse({ vars: { GITHUB_TOKEN: 'nope' } }),
        stage: 'test',
        client: c,
      }),
    ).rejects.toThrow(/names the adapter owns/)
  })
})

describe('writeDotenv', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intellidev-dotenv-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the file owner-only', async () => {
    const target = await writeDotenv({ worktree: dir, dotenvPath: '.env', env: { A: 'b' } })
    expect(await readFile(target, 'utf8')).toBe('A=b\n')
    expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('quotes values that would otherwise break a dotenv parser', async () => {
    const target = await writeDotenv({
      worktree: dir,
      dotenvPath: '.env',
      env: { URL: 'postgres://u:p w@h/db', PLAIN: 'simple' },
    })
    const body = await readFile(target, 'utf8')
    expect(body).toContain('URL="postgres://u:p w@h/db"')
    expect(body).toContain('PLAIN=simple')
  })

  it('excludes the file via .git/info/exclude, not the tracked .gitignore', async () => {
    // Editing a tracked file would put our plumbing in the PR diff.
    await writeDotenv({ worktree: dir, dotenvPath: '.env', env: { A: 'b' } })
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.env')
    // The repo's own .gitignore must be untouched, or our plumbing shows up in review.
    await expect(readFile(join(dir, '.gitignore'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('does not duplicate the exclude entry on a second run', async () => {
    await writeDotenv({ worktree: dir, dotenvPath: '.env', env: { A: 'b' } })
    await writeDotenv({ worktree: dir, dotenvPath: '.env', env: { A: 'c' } })
    const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((l) => l.trim() === '.env')).toHaveLength(1)
  })
})

// --- control plane provider -----------------------------------------------

describe('ControlPlaneProvider', () => {
  it('sends the run id and bearer, and returns the credential', async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = []
    const provider = new ControlPlaneProvider({
      baseUrl: 'https://cp.test',
      runId: 'run_1',
      runAuth: 'run-bearer',
      fetchImpl: (async (url: URL, init: RequestInit) => {
        seen.push({
          url: String(url),
          auth: (init.headers as Record<string, string>)['authorization'] ?? null,
          body: JSON.parse(String(init.body)),
        })
        return new Response(
          JSON.stringify({ username: 'x-access-token', password: 'p', expiresAt: iso(3600) }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })
    const cred = await provider.gitCredential('github.com')
    expect(cred.password).toBe('p')
    expect(seen[0]?.url).toBe('https://cp.test/internal/creds/git')
    expect(seen[0]?.auth).toBe('Bearer run-bearer')
    expect(seen[0]?.body).toEqual({ runId: 'run_1', host: 'github.com' })
  })

  it('retries a 5xx, because a refresh failing at minute 90 wastes the run', async () => {
    let calls = 0
    const provider = new ControlPlaneProvider({
      baseUrl: 'https://cp.test',
      runId: 'run_1',
      runAuth: 'b',
      retryDelayMs: 1,
      fetchImpl: (async () => {
        calls++
        if (calls < 3) return new Response('upstream sad', { status: 503 })
        return new Response(JSON.stringify({ token: 't', expiresAt: iso(60) }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect((await provider.mcpToken('sentry')).token).toBe('t')
    expect(calls).toBe(3)
  })

  it('does not retry a 4xx, which will not improve', async () => {
    let calls = 0
    const provider = new ControlPlaneProvider({
      baseUrl: 'https://cp.test',
      runId: 'run_1',
      runAuth: 'b',
      retryDelayMs: 1,
      fetchImpl: (async () => {
        calls++
        return new Response('nope', { status: 403 })
      }) as unknown as typeof fetch,
    })
    await expect(provider.gitCredential('github.com')).rejects.toThrow(/403/)
    expect(calls).toBe(1)
  })
})
