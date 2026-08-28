import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AgentEvent } from '@intellidev/shared'
import { PostgresStore } from '../src/store/postgres.js'
import { allowRepoFor, TEST_REPO_URL } from './fixtures.js'

/**
 * C6, proven the only way it can be: **two independent store instances**.
 *
 * A single-instance test cannot show anything here — in-process fan-out already works, and
 * that is precisely why this bug ships unnoticed. The failure only appears when the writer
 * and the subscriber are different processes, which is the normal case behind a load
 * balancer: the adapter's socket lands on one instance and the browser's SSE on another.
 *
 * Skipped without a connection string, by name, so the suite stays runnable offline.
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
  title: 'fan-out',
  description: 'two instances',
  acceptanceCriteria: ['delivered across instances'],
  harness: 'claude-code' as const,
  repoUrl: TEST_REPO_URL,
  baseBranch: 'main',
  mcpServerIds: [],
}

/** Waits for a predicate, so the test does not depend on a fixed sleep. */
async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const dsn = connectionString()
/**
 * A real project is required, not a placeholder.
 *
 * `runner.runs` carries composite foreign keys onto the product's tenancy, so there is nothing
 * to invent here — a made-up project id is rejected by the database. `pnpm dev:seed` creates one
 * and prints the ids to set.
 */
const liveProjectId = process.env['INTELLIDEV_PROJECT_ID']

if (!dsn || !liveProjectId) {
  const why = !dsn ? 'no SUPABASE_CONNECTION_STRING_SESSION' : 'no INTELLIDEV_PROJECT_ID'
  describe.skip(`cross-instance fan-out (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
} else {
  describe('cross-instance fan-out', () => {
    // `writer` stands for the instance the adapter's socket landed on; `reader` for the one
    // serving the browser. Separate objects, separate connections, as separate processes.
    const writer = new PostgresStore({ connectionString: dsn, crossInstanceFanOut: true })
    const reader = new PostgresStore({ connectionString: dsn, crossInstanceFanOut: true })

    beforeEach(async () => {
      await writer.truncateAll()
    })

    /** Resolved from the database, because the run's tenancy has to be real. */
    async function scope() {
      const found = await writer.findProject(liveProjectId!)
      if (!found) throw new Error(`project ${liveProjectId} is not in this database`)
      return found
    }

    afterAll(async () => {
      await writer.truncateAll()
      // Leaves the shared database as it was found.
      await writer.removeProjectRepo(await scope(), 'acme', 'widget')
      await writer.close()
      await reader.close()
    })

    async function seedRun(): Promise<string> {
      const where = await scope()
      await allowRepoFor(writer, TEST_REPO_URL, where)
      const task = await writer.createTask(TASK, where)
      return (await writer.createRun(task.id, 'claude-code', 'feat/x')).id
    }

    it('delivers an event written on one instance to a subscriber on another', async () => {
      await writer.start()
      await reader.start()
      const runId = await seedRun()

      const seen: number[] = []
      const unsubscribe = reader.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })

      await writer.appendEvent(event(runId, 0))
      await until(() => seen.length >= 1)

      expect(seen).toEqual([0])
      unsubscribe()
    })

    it('delivers a whole batch, in seq order', async () => {
      await writer.start()
      await reader.start()
      const runId = await seedRun()

      const seen: number[] = []
      const unsubscribe = reader.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })

      await writer.appendEvents([event(runId, 0), event(runId, 1), event(runId, 2)])
      await until(() => seen.length >= 3)

      // Order matters: the UI renders a timeline, and one notification covers a batch.
      expect(seen).toEqual([0, 1, 2])
      unsubscribe()
    })

    it('does not deliver twice on the instance that wrote it', async () => {
      // The writer fans out in process *and* notifies. Without the seq watermark its own
      // notification would re-deliver everything it just sent.
      await writer.start()
      const runId = await seedRun()

      const seen: number[] = []
      const unsubscribe = writer.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })

      await writer.appendEvents([event(runId, 0), event(runId, 1)])
      // Long enough for its own notification to arrive and be processed.
      await new Promise((resolve) => setTimeout(resolve, 1500))

      expect(seen).toEqual([0, 1])
      unsubscribe()
    })

    it('does not deliver a replayed duplicate to another instance', async () => {
      await writer.start()
      await reader.start()
      const runId = await seedRun()

      const seen: number[] = []
      const unsubscribe = reader.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })

      await writer.appendEvent(event(runId, 0))
      await until(() => seen.length >= 1)
      // The adapter replays everything unacknowledged on reconnect; the row is unchanged, so
      // the subscriber must not see it again.
      await writer.appendEvent(event(runId, 0))
      await new Promise((resolve) => setTimeout(resolve, 1200))

      expect(seen).toEqual([0])
      unsubscribe()
    })

    it('delivers nothing for a run this instance is not watching', async () => {
      await writer.start()
      await reader.start()
      const watched = await seedRun()
      const other = await seedRun()

      const seen: number[] = []
      const unsubscribe = reader.subscribe(watched, (e) => seen.push(e.seq), { since: -1 })

      await writer.appendEvent(event(other, 0))
      await new Promise((resolve) => setTimeout(resolve, 1200))

      expect(seen).toEqual([])
      unsubscribe()
    })

    it('stops delivering after unsubscribe', async () => {
      await writer.start()
      await reader.start()
      const runId = await seedRun()

      const seen: number[] = []
      const unsubscribe = reader.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
      await writer.appendEvent(event(runId, 0))
      await until(() => seen.length >= 1)

      unsubscribe()
      await writer.appendEvent(event(runId, 1))
      await new Promise((resolve) => setTimeout(resolve, 1200))

      expect(seen).toEqual([0])
    })
  })
}
