import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentEvent } from '@intellidev/shared'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store.js'
import { RunTokenRegistry } from '../src/runs/tokens.js'
import { HarnessAccounts } from '../src/harness/accounts.js'
import { McpRegistry } from '../src/mcp/registry.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Exercises the real endpoint over a real socket.
 *
 * The sink's own tests use a double, which proves the replay logic but says nothing about
 * whether the server authenticates correctly, acks in the right order, or refuses a token
 * belonging to another run. Those are the parts that fail in production, so they are tested
 * against a listening server.
 */
let app: FastifyInstance
let store: InMemoryStore
let tokens: RunTokenRegistry
let baseUrl: string

async function scaffold() {
  const work = await mkdtemp(join(tmpdir(), 'evt-'))
  store = new InMemoryStore()
  tokens = new RunTokenRegistry()
  app = await buildServer({
    store,
    tokens,
    dispatch: {
      mode: 'inline',
      bundleRoot: work,
      image: 'x',
      workRoot: work,
      projectId: 'local',
      publicUrl: 'http://127.0.0.1:0',
    },
    mcp: await McpRegistry.open(join(work, 'mcp.json')),
    accounts: await HarnessAccounts.open(join(work, 'accounts.json')),
    publicDir: work,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `ws://127.0.0.1:${port}`
}

/** A run in the store, plus a token for it. */
async function seedRun(): Promise<{ runId: string; token: string }> {
  const task = await store.createTask({
    title: 't',
    description: 'd',
    acceptanceCriteria: ['a'],
    harness: 'claude-code',
    repoUrl: 'https://example.test/r.git',
    baseBranch: 'main',
    mcpServerIds: [],
  })
  const run = await store.createRun(task.id, 'claude-code', 'feat/x')
  return { runId: run.id, token: tokens.mint(run.id).token }
}

function event(runId: string, seq: number): AgentEvent {
  return AgentEvent.parse({
    seq,
    runId,
    ts: new Date(1700000000000 + seq).toISOString(),
    stage: null,
    type: 'run.provisioning',
    data: { message: `event ${seq}` },
  })
}

/** Opens a socket and collects acks until `settle` resolves. */
function connect(url: string) {
  const socket = new WebSocket(url)
  const acks: number[] = []
  let closeCode: number | undefined
  socket.onmessage = (message) => {
    const parsed = JSON.parse(String(message.data)) as { type?: string; seq?: number }
    if (parsed.type === 'ack' && typeof parsed.seq === 'number') acks.push(parsed.seq)
  }
  socket.onclose = (e) => {
    closeCode = (e as CloseEvent).code
  }
  return {
    socket,
    acks,
    get closeCode() {
      return closeCode
    },
    opened: new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => resolve() // a refused handshake resolves; assertions cover it
      setTimeout(() => reject(new Error('socket never settled')), 4000)
    }),
    send: (e: AgentEvent) => socket.send(JSON.stringify({ type: 'event', event: e })),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150))

beforeEach(scaffold)
afterEach(async () => {
  await app.close()
})

describe('authentication', () => {
  it('accepts a run presenting its own token', async () => {
    const { runId, token } = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    client.send(event(runId, 0))
    await settle()
    expect(client.acks).toEqual([0])
    expect(await store.eventsSince(runId, -1)).toHaveLength(1)
    client.socket.close()
  })

  it('refuses a missing token', async () => {
    const { runId } = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${runId}/events`)
    await client.opened
    await settle()
    expect(client.closeCode).toBe(4401)
  })

  it('refuses a revoked token, so a settled run cannot keep writing', async () => {
    const { runId, token } = await seedRun()
    tokens.revoke(runId)
    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    await settle()
    expect(client.closeCode).toBe(4401)
  })

  it("refuses a valid token used against another run's path", async () => {
    // The attack this closes: a legitimate token for run A writing events into run B, which
    // would let one run forge another's history.
    const a = await seedRun()
    const b = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${b.runId}/events?token=${a.token}`)
    await client.opened
    await settle()
    expect(client.closeCode).toBe(4403)
    expect(await store.eventsSince(b.runId, -1)).toHaveLength(0)
  })

  it("ignores an event whose own runId is another run's", async () => {
    // Belt and braces: the path matched, but the payload claims a different run. The
    // event's own runId is authoritative and must agree.
    const a = await seedRun()
    const b = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${a.runId}/events?token=${a.token}`)
    await client.opened
    client.send(event(b.runId, 0))
    await settle()
    expect(await store.eventsSince(b.runId, -1)).toHaveLength(0)
    expect(client.acks).toEqual([])
    client.socket.close()
  })
})

describe('acknowledgement', () => {
  it('acks each event by seq, in order', async () => {
    const { runId, token } = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    for (const seq of [0, 1, 2]) client.send(event(runId, seq))
    await settle()
    expect(client.acks).toEqual([0, 1, 2])
    client.socket.close()
  })

  it('is idempotent under replay, which is what makes reconnect safe', async () => {
    // The adapter re-sends everything unacknowledged on every reconnect by design, so a
    // duplicate must not become a duplicate row.
    const { runId, token } = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    client.send(event(runId, 0))
    client.send(event(runId, 1))
    await settle()
    client.send(event(runId, 0))
    client.send(event(runId, 1))
    await settle()
    expect(await store.eventsSince(runId, -1)).toHaveLength(2)
    client.socket.close()
  })

  it('survives a reconnect and keeps the log gapless', async () => {
    const { runId, token } = await seedRun()
    const url = `${baseUrl}/internal/runs/${runId}/events?token=${token}`

    const first = connect(url)
    await first.opened
    first.send(event(runId, 0))
    await settle()
    first.socket.close()
    await settle()

    // The same token works again: it belongs to the run, not to a connection.
    const second = connect(url)
    await second.opened
    for (const seq of [1, 2]) second.send(event(runId, seq))
    await settle()

    expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([0, 1, 2])
    second.socket.close()
  })

  it('drops a malformed frame without killing the socket', async () => {
    // Killing it would make the run replay everything, which is worse than losing one bad
    // frame.
    const { runId, token } = await seedRun()
    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    client.socket.send('not json')
    client.socket.send(JSON.stringify({ type: 'event', event: { nonsense: true } }))
    client.send(event(runId, 0))
    await settle()
    expect(client.acks).toEqual([0])
    client.socket.close()
  })
})

describe('fan-out to the UI', () => {
  it('makes an event arriving on the socket visible to SSE subscribers', async () => {
    // The point of the whole path: the adapter dials out, and a browser attached to SSE
    // sees it without either knowing about the other.
    const { runId, token } = await seedRun()
    const seen: number[] = []
    const unsubscribe = store.subscribe(runId, (e) => seen.push((e as AgentEvent).seq))

    const client = connect(`${baseUrl}/internal/runs/${runId}/events?token=${token}`)
    await client.opened
    for (const seq of [0, 1]) client.send(event(runId, seq))
    await settle()

    expect(seen).toEqual([0, 1])
    unsubscribe()
    client.socket.close()
  })
})
