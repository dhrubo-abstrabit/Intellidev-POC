import { beforeEach, describe, expect, it } from 'vitest'
import {
  ControlPlaneCredentialBroker,
  CredentialRefused,
  type CredentialGrant,
} from '../src/runs/credentials.js'
import { InMemoryStore } from '../src/store/memory.js'
import { RunTokenRegistry } from '../src/runs/tokens.js'
import type { SeatStore } from '../src/harness/seat-store.js'
import { allowRepoFor, TEST_SCOPE } from './fixtures.js'

/**
 * The broker's job is refusing, as much as granting.
 *
 * Every one of these is a way one run could reach a credential that is not its own — which
 * is the whole reason B3 replaced "put it in the environment" with "come and ask".
 */

let store: InMemoryStore
let tokens: RunTokenRegistry
let grants: CredentialGrant[]

/** A stand-in for the UI's stored harness accounts. */
function accountsWith(material: Record<string, unknown> | undefined): SeatStore {
  // Only `material` is exercised here; the broker never lists or connects.
  return { material: async () => material } as unknown as SeatStore
}

function broker(opts: {
  githubToken?: string
  mcpToken?: string
  material?: Record<string, unknown>
}) {
  return new ControlPlaneCredentialBroker({
    store,
    tokens,
    accounts: accountsWith(opts.material),
    mcpToken: async () => opts.mcpToken,
    ...(opts.githubToken ? { githubToken: opts.githubToken } : {}),
    onGrant: (grant) => grants.push(grant),
  })
}

/** A dispatched run, with the token its container would hold. */
async function seedRun(
  over: {
    repoUrl?: string
    harness?: 'claude-code' | 'codex' | 'opencode'
    mcpServerIds?: string[]
  } = {},
) {
  const repoUrl = over.repoUrl ?? 'https://github.com/acme/widget.git'
  // Allowlisted from the URL under test, so a case that deliberately uses another host or
  // path keeps testing that rather than being forced onto a fixed repository.
  await allowRepoFor(store, repoUrl)
  const task = await store.createTask(
    {
      title: 't',
      description: 'd',
      acceptanceCriteria: ['a'],
      harness: over.harness ?? 'claude-code',
      repoUrl,
      baseBranch: 'main',
      mcpServerIds: over.mcpServerIds ?? [],
    },
    TEST_SCOPE,
  )
  await store.setTaskStatus(task.id, 'dispatched')
  const run = await store.createRun(task.id, over.harness ?? 'claude-code', 'feat/x')
  return { runId: run.id, token: (await tokens.mint(run.id)).token }
}

beforeEach(() => {
  store = new InMemoryStore()
  tokens = new RunTokenRegistry()
  grants = []
})

describe('authentication', () => {
  it('resolves a bearer to the run it belongs to', async () => {
    const { runId, token } = await seedRun()
    expect(await broker({}).authenticate(`Bearer ${token}`)).toBe(runId)
  })

  it('accepts the raw token as well as a Bearer prefix', async () => {
    const { runId, token } = await seedRun()
    expect(await broker({}).authenticate(token)).toBe(runId)
  })

  it('refuses a missing, unknown or revoked token with 401', async () => {
    const { runId, token } = await seedRun()
    const b = broker({})
    await expect(b.authenticate(undefined)).rejects.toThrow(CredentialRefused)
    await expect(b.authenticate('Bearer nonsense')).rejects.toThrow(/invalid or expired/)
    await tokens.revoke(runId)
    await expect(b.authenticate(`Bearer ${token}`)).rejects.toThrow(/invalid or expired/)
  })
})

describe('git', () => {
  it('grants a credential for the run own repository host', async () => {
    const { runId } = await seedRun()
    const cred = await broker({ githubToken: 'ghp_live' }).git(runId, 'github.com')
    expect(cred).toMatchObject({ username: 'x-access-token', password: 'ghp_live' })
    expect(cred.expiresAt).toMatch(/^\d{4}-/)
  })

  it('refuses a host the run was never pointed at', async () => {
    // The exfiltration case: a run asking for credentials to somewhere it has no business.
    const { runId } = await seedRun({ repoUrl: 'https://github.com/acme/widget.git' })
    await expect(broker({ githubToken: 'ghp_live' }).git(runId, 'evil.example')).rejects.toThrow(
      /repository is elsewhere/,
    )
    expect(grants.at(-1)).toMatchObject({ kind: 'git', granted: false })
  })

  it('understands the scp-like remote form', async () => {
    // `git@github.com:acme/widget.git` is not a URL, and treating it as unparseable would
    // refuse a legitimate run.
    const { runId } = await seedRun({ repoUrl: 'git@github.com:acme/widget.git' })
    await expect(
      broker({ githubToken: 'ghp_live' }).git(runId, 'github.com'),
    ).resolves.toBeDefined()
  })

  it('ignores a port when comparing hosts', async () => {
    const { runId } = await seedRun({ repoUrl: 'https://git.internal:8443/acme/widget.git' })
    await expect(
      broker({ githubToken: 'ghp_live' }).git(runId, 'git.internal:8443'),
    ).resolves.toBeDefined()
  })

  it('says so when the control plane holds no credential', async () => {
    const { runId } = await seedRun()
    await expect(broker({}).git(runId, 'github.com')).rejects.toThrow(/no GitHub credential/)
  })
})

describe('seat', () => {
  it('grants the material the UI login stored', async () => {
    const { runId } = await seedRun({ harness: 'claude-code' })
    const seat = await broker({ material: { files: { '.claude/x': '{}' } } }).seat(
      runId,
      'claude-code',
    )
    expect(seat.material).toEqual({ files: { '.claude/x': '{}' } })
  })

  it('refuses a harness the run was not dispatched for', async () => {
    const { runId } = await seedRun({ harness: 'claude-code' })
    await expect(broker({ material: {} }).seat(runId, 'codex')).rejects.toThrow(
      /only request its own/,
    )
  })

  it('returns empty material rather than failing when nothing is connected', async () => {
    // opencode's free tier needs no login, and a harness that does need one complains far
    // more clearly than a boot failure would.
    const { runId } = await seedRun({ harness: 'opencode' })
    const seat = await broker({}).seat(runId, 'opencode')
    expect(seat.material).toEqual({})
    expect(grants.at(-1)).toMatchObject({ granted: true, reason: 'no account connected' })
  })
})

describe('mcp', () => {
  it('grants a token for an attached server', async () => {
    const { runId } = await seedRun({ mcpServerIds: ['github'] })
    expect(await broker({ mcpToken: 'mcp_live' }).mcp(runId, 'github')).toMatchObject({
      token: 'mcp_live',
    })
  })

  it('refuses a server the task never attached', async () => {
    // These are third-party OAuth credentials, so handing one over would leak access to an
    // unrelated system entirely.
    const { runId } = await seedRun({ mcpServerIds: ['github'] })
    await expect(broker({ mcpToken: 'mcp_live' }).mcp(runId, 'stripe')).rejects.toThrow(
      /not attached/,
    )
    expect(grants.at(-1)).toMatchObject({ kind: 'mcp', granted: false })
  })

  it('refuses when the server is attached but has no token', async () => {
    const { runId } = await seedRun({ mcpServerIds: ['github'] })
    await expect(broker({}).mcp(runId, 'github')).rejects.toThrow(/no token/)
  })
})

describe('isolation between runs', () => {
  it("will not serve one run's token against another run's data", async () => {
    // The attack the design turns on: the run id comes from the token, never the request.
    const a = await seedRun({ repoUrl: 'https://github.com/acme/a.git' })
    const b = await seedRun({ repoUrl: 'https://gitlab.example/other/b.git' })
    const authed = await broker({ githubToken: 'ghp_live' }).authenticate(`Bearer ${a.token}`)

    expect(authed).toBe(a.runId)
    expect(authed).not.toBe(b.runId)
    // Authenticated as A, so B's host is refused even though B is a legitimate run.
    await expect(broker({ githubToken: 'ghp_live' }).git(authed, 'gitlab.example')).rejects.toThrow(
      /elsewhere/,
    )
  })
})

describe('secrets', () => {
  it('returns an empty set rather than a 404 while there is no vault', async () => {
    // A 404 would read like a broker fault; empty lets the run say what it lacked.
    const { runId } = await seedRun()
    expect(await broker({}).secrets(runId, 'code')).toEqual({ values: {}, unresolved: [] })
  })
})

describe('audit', () => {
  it('records every grant and refusal without the secret in it', async () => {
    const { runId } = await seedRun({ mcpServerIds: ['github'] })
    const b = broker({ githubToken: 'ghp_live', mcpToken: 'mcp_live', material: {} })
    await b.git(runId, 'github.com')
    await b.mcp(runId, 'github')
    await b.git(runId, 'evil.example').catch(() => undefined)

    expect(grants.map((g) => `${g.kind}:${g.granted}`)).toEqual([
      'git:true',
      'mcp:true',
      'git:false',
    ])
    const rendered = JSON.stringify(grants)
    expect(rendered).not.toContain('ghp_live')
    expect(rendered).not.toContain('mcp_live')
  })
})
