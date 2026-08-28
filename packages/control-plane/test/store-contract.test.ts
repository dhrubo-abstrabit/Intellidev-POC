import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AgentEvent } from '@intellidev/shared'
import { InMemoryStore } from '../src/store/memory.js'
import { PostgresStore } from '../src/store/postgres.js'
import { unsafeToWipeReason } from './guard.js'
import type { Store } from '../src/store/types.js'

/**
 * One suite, both implementations.
 *
 * This is what makes "the same API tests pass against Postgres" — B1's done-condition —
 * a proven claim rather than an intention. Every behaviour the control plane relies on is
 * asserted against each store, so a divergence is a failing test rather than a bug that
 * only appears once deployed.
 *
 * The Postgres half is skipped when no connection string is configured, so the suite stays
 * runnable offline and in CI without secrets. It is **not** skipped silently in a way that
 * could hide a regression: the describe block reports as skipped, by name.
 */

function connectionString(): string | undefined {
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    const line = env
      .split('\n')
      .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
    return line
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

/**
 * A minimal valid event.
 *
 * Fixed to `run.provisioning` rather than parameterised by type: each event type has its
 * own required payload, so a generic helper that swapped the type while keeping one `data`
 * shape produced schema failures that looked like store bugs.
 */
/** Waits for a predicate, since backfill is asynchronous in both implementations. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function event(runId: string, seq: number): AgentEvent {
  return AgentEvent.parse({
    seq,
    runId,
    ts: new Date(1700000000000 + seq * 1000).toISOString(),
    stage: null,
    type: 'run.provisioning',
    data: { message: `event ${seq}` },
  })
}

const TASK = {
  title: 'contract',
  description: 'shared by both stores',
  acceptanceCriteria: ['behaves identically'],
  harness: 'claude-code' as const,
  repoUrl: 'https://example.test/repo.git',
  baseBranch: 'main',
  mcpServerIds: ['github'],
}

/**
 * Every behaviour the control plane depends on, run against whichever store is given.
 *
 * `reset` matters more than it looks. The in-memory store is isolated because each test
 * gets a fresh instance; a database is not, and without truncation between tests one
 * test's rows are another's — `findRunByHandle('container-xyz')` finding a *previous*
 * test's run is exactly the false failure that shows up first. One store instance for the
 * whole suite, emptied between tests, also avoids opening a connection pool per test.
 */
function contract(
  name: string,
  store: Store,
  hooks: { reset?: () => Promise<void>; dispose?: () => Promise<void> } = {},
) {
  describe(name, () => {
    beforeEach(async () => {
      if (hooks.reset) await hooks.reset()
    })
    afterAll(async () => {
      if (hooks.dispose) await hooks.dispose()
    })

    describe('tasks', () => {
      it('round-trips every field, including the optional ones', async () => {
        const created = await store.createTask({ ...TASK, details: 'extra context' })
        const fetched = await store.getTask(created.id)
        expect(fetched).toMatchObject({
          title: TASK.title,
          acceptanceCriteria: TASK.acceptanceCriteria,
          mcpServerIds: TASK.mcpServerIds,
          details: 'extra context',
          status: 'not_started',
        })
        // ISO strings both sides, so the UI contract does not depend on which store is live.
        expect(fetched?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      })

      it('omits an absent optional rather than returning null', async () => {
        // A `details: null` would reach the UI as a rendered "null"; absence must stay absence.
        const created = await store.createTask(TASK)
        expect(await store.getTask(created.id)).not.toHaveProperty('details')
      })

      it('returns undefined for a task that does not exist', async () => {
        expect(await store.getTask('task_missing')).toBeUndefined()
      })

      it('enforces the status machine, refusing an illegal jump', async () => {
        const task = await store.createTask(TASK)
        await expect(store.setTaskStatus(task.id, 'in_review')).rejects.toThrow(/cannot move/)
        expect((await store.getTask(task.id))?.status).toBe('not_started')
      })

      it('allows the legal path', async () => {
        const task = await store.createTask(TASK)
        await store.setTaskStatus(task.id, 'dispatched')
        await store.setTaskStatus(task.id, 'running')
        expect((await store.setTaskStatus(task.id, 'in_review')).status).toBe('in_review')
      })

      it('treats setting the current status as a no-op, not a violation', async () => {
        const task = await store.createTask(TASK)
        expect((await store.setTaskStatus(task.id, 'not_started')).status).toBe('not_started')
      })
    })

    describe('runs', () => {
      it('starts queued with seqHwm -1, so seq 0 is acceptable', async () => {
        // `0 <= 0` would reject the very first event if this were 0.
        const task = await store.createTask(TASK)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        expect(run.status).toBe('queued')
        expect(run.seqHwm).toBe(-1)
        expect(run.records).toEqual([])
      })

      it('applies a partial patch without disturbing other fields', async () => {
        const task = await store.createTask(TASK)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        await store.updateRun(run.id, { handle: 'arn:aws:ecs:::task/abc' })
        await store.updateRun(run.id, { status: 'running' })
        const after = await store.getRun(run.id)
        expect(after?.handle).toBe('arn:aws:ecs:::task/abc')
        expect(after?.status).toBe('running')
        expect(after?.branch).toBe('feat/x')
      })

      it('finds a run by its runtime handle', async () => {
        const task = await store.createTask(TASK)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        await store.updateRun(run.id, { handle: 'container-xyz' })
        expect((await store.findRunByHandle('container-xyz'))?.id).toBe(run.id)
        expect(await store.findRunByHandle('nothing')).toBeUndefined()
      })

      it('lists unsettled runs across every non-terminal status but parked', async () => {
        // The reconciler sweeps exactly this set. `parked` waits on a human, not a container.
        const task = await store.createTask(TASK)
        const ids: Record<string, string> = {}
        for (const status of [
          'queued',
          'provisioning',
          'running',
          'parked',
          'succeeded',
        ] as const) {
          const run = await store.createRun(task.id, 'claude-code', `feat/${status}`)
          await store.updateRun(run.id, { status })
          ids[status] = run.id
        }
        const unsettled = (await store.listUnsettledRuns()).map((r) => r.id).sort()
        expect(unsettled).toEqual([ids['queued']!, ids['provisioning']!, ids['running']!].sort())
      })

      it('scopes listRuns by task', async () => {
        const a = await store.createTask(TASK)
        const b = await store.createTask(TASK)
        await store.createRun(a.id, 'claude-code', 'feat/a')
        await store.createRun(b.id, 'claude-code', 'feat/b')
        expect(await store.listRuns(a.id)).toHaveLength(1)
        expect((await store.listRuns()).length).toBeGreaterThanOrEqual(2)
      })

      it('rejects a patch to a run that does not exist', async () => {
        await expect(store.updateRun('run_missing', { status: 'failed' })).rejects.toThrow(
          /no such run/,
        )
      })

      it('persists stage records as structured data', async () => {
        const task = await store.createTask(TASK)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        const records = [
          {
            stage: 'design' as const,
            attempt: 1,
            status: 'passed' as const,
            resumeToken: null,
            gatePassed: true,
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        ]
        await store.updateRun(run.id, { records })
        expect((await store.getRun(run.id))?.records).toEqual(records)
      })
    })

    describe('events', () => {
      async function runFixture(): Promise<string> {
        const task = await store.createTask(TASK)
        return (await store.createRun(task.id, 'claude-code', 'feat/x')).id
      }

      it('accepts seq 0 as the first event', async () => {
        const runId = await runFixture()
        expect(await store.appendEvent(event(runId, 0))).toBe(true)
        expect((await store.getRun(runId))?.seqHwm).toBe(0)
      })

      it('drops a duplicate, so a replay is not a second row', async () => {
        // The adapter re-sends everything unacknowledged on every reconnect by design.
        const runId = await runFixture()
        expect(await store.appendEvent(event(runId, 0))).toBe(true)
        expect(await store.appendEvent(event(runId, 0))).toBe(false)
        expect(await store.eventsSince(runId, -1)).toHaveLength(1)
      })

      it('accepts a late event that fills a gap, and never lowers the watermark', async () => {
        // The corrected contract, and the contract suite is what caught the old one being
        // wrong. Rejecting `seq <= seqHwm` would refuse a replay of seq 3 after 5 arrived
        // and make that hole permanent — the opposite of the gapless guarantee.
        const runId = await runFixture()
        await store.appendEvent(event(runId, 5))
        expect(await store.appendEvent(event(runId, 3))).toBe(true)
        expect((await store.getRun(runId))?.seqHwm).toBe(5)
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([3, 5])
      })

      it('still refuses an exact duplicate', async () => {
        const runId = await runFixture()
        await store.appendEvent(event(runId, 5))
        expect(await store.appendEvent(event(runId, 5))).toBe(false)
        expect(await store.eventsSince(runId, -1)).toHaveLength(1)
      })

      it('backfills only what is after `since`, which is what SSE needs', async () => {
        const runId = await runFixture()
        for (const seq of [0, 1, 2, 3]) await store.appendEvent(event(runId, seq))
        expect((await store.eventsSince(runId, 1)).map((e) => e.seq)).toEqual([2, 3])
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([0, 1, 2, 3])
      })

      it('returns events in seq order even when they arrived out of order', async () => {
        const runId = await runFixture()
        await store.appendEvents([event(runId, 0), event(runId, 1), event(runId, 2)])
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([0, 1, 2])
      })

      it('counts only genuinely new events in a batch', async () => {
        const runId = await runFixture()
        expect(await store.appendEvents([event(runId, 0), event(runId, 1)])).toBe(2)
        // A replayed batch overlapping what is stored: 2 was new, the rest were not.
        expect(await store.appendEvents([event(runId, 0), event(runId, 1), event(runId, 2)])).toBe(
          1,
        )
        expect(await store.eventsSince(runId, -1)).toHaveLength(3)
      })

      it('treats an empty batch as a no-op', async () => {
        expect(await store.appendEvents([])).toBe(0)
      })

      it('keeps the whole event body, so the log is replayable', async () => {
        const runId = await runFixture()
        // A stage-stamped event with a non-trivial payload, so the assertion covers more
        // than the two columns that are also stored separately.
        const original = AgentEvent.parse({
          seq: 0,
          runId,
          ts: '2026-01-01T00:00:00.000Z',
          stage: 'design',
          type: 'stage.entered',
          data: { attempt: 2 },
        })
        await store.appendEvent(original)
        expect((await store.eventsSince(runId, -1))[0]).toEqual(original)
      })

      it('isolates one run from another', async () => {
        const a = await runFixture()
        const b = await runFixture()
        await store.appendEvent(event(a, 0))
        expect(await store.eventsSince(b, -1)).toHaveLength(0)
      })
    })

    describe('subscription', () => {
      it('backfills from `since`, so there is no separate read to race', async () => {
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1, 2]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: 0 })
        await until(() => seen.length >= 2)
        // Exclusive: `since: 0` means "after seq 0".
        expect(seen).toEqual([1, 2])
        unsubscribe()
      })

      it('delivers the whole log for `since: -1`', async () => {
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await until(() => seen.length >= 2)
        expect(seen).toEqual([0, 1])
        unsubscribe()
      })

      it('gives two subscribers of one run their own backlog', async () => {
        // A shared watermark let whoever subscribed first starve the second of its history.
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1, 2]) await store.appendEvent(event(runId, seq))

        const first: number[] = []
        const second: number[] = []
        const un1 = store.subscribe(runId, (e) => first.push(e.seq), { since: -1 })
        await until(() => first.length >= 3)
        const un2 = store.subscribe(runId, (e) => second.push(e.seq), { since: -1 })
        await until(() => second.length >= 3)

        expect(first).toEqual([0, 1, 2])
        expect(second).toEqual([0, 1, 2])
        un1()
        un2()
      })

      it('delivers only what follows a mid-log `since`', async () => {
        // Replaces a test for an "omitted since" mode that no longer exists: reading the
        // run's current position asynchronously could return a watermark that already
        // included the event the subscriber was meant to see, skipping it with nothing to
        // retry. `since` is required now, so the caller states where it is.
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: 1 })
        await store.appendEvent(event(runId, 2))
        await until(() => seen.length >= 1)
        await new Promise((resolve) => setTimeout(resolve, 250))

        expect(seen).toEqual([2])
        unsubscribe()
      })

      it('delivers new events to a listener and stops on unsubscribe', async () => {
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await store.appendEvent(event(runId, 0))
        await store.appendEvent(event(runId, 1))
        await until(() => seen.length >= 2)
        unsubscribe()
        await store.appendEvent(event(runId, 2))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(seen).toEqual([0, 1])
      })

      it('does not re-deliver a replayed duplicate', async () => {
        // Otherwise a reconnect would make the UI re-render events it already showed.
        const task = await store.createTask(TASK)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await store.appendEvent(event(runId, 0))
        await store.appendEvent(event(runId, 0))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(seen).toEqual([0])
        unsubscribe()
      })
    })
  })
}

// A fresh in-memory store per test is what isolation means here, so `reset` swaps it.
let memory = new InMemoryStore()
contract(
  'InMemoryStore',
  new Proxy({} as Store, {
    get: (_target, prop) => Reflect.get(memory as object, prop, memory),
  }),
  {
    reset: async () => {
      memory = new InMemoryStore()
    },
  },
)

const dsn = connectionString()
// Checked before a store is even constructed: these tests truncate, and the guard's whole
// point is that nothing destructive runs against a database holding someone else's data.
const unsafe = dsn ? await unsafeToWipeReason(dsn) : undefined
if (dsn && !unsafe) {
  const live = new PostgresStore({ connectionString: dsn })
  contract('PostgresStore', live, {
    // `tasks` cascades to runs and run_events, so one statement empties all three — and it
    // is one round trip rather than three against a database 85 ms away.
    reset: async () => {
      await live.truncateAll()
    },
    dispose: async () => {
      await live.truncateAll()
      await live.close()
    },
  })
} else {
  const why = unsafe ?? 'no SUPABASE_CONNECTION_STRING_SESSION configured'
  describe.skip(`PostgresStore (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
}
