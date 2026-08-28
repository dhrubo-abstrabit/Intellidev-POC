import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PostgresStore } from '../src/store/postgres.js'
import { InMemoryRunTokens, RunTokenRegistry } from '../src/runs/tokens.js'
import { allowTestRepo, TEST_TASK } from './fixtures.js'

/**
 * Run tokens must survive a process, because behind a load balancer they have to.
 *
 * The registry was two in-process Maps. That is correct for exactly one control plane: a token
 * minted while dispatching on instance A is unverifiable on instance B, so a container's broker
 * calls fail on roughly half of them — and *which* half depends on routing, which makes it the
 * kind of fault that only appears in the deployment you cannot debug easily.
 *
 * Two separate registries over one database stand in for two instances. That is the same device
 * the cross-instance fan-out tests use, and for the same reason: separate objects with separate
 * connections behave as separate processes for everything that matters here.
 */
function connectionString(): string | undefined {
  const explicit = process.env['SUPABASE_CONNECTION_STRING_SESSION']
  if (explicit) return explicit
  try {
    return readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const dsn = connectionString()
/**
 * The project the tests own, which is not the one anyone dispatches into.
 *
 * These suites call `truncateAll()`, which deletes every task in their project. Pointing that at
 * the development project destroyed a live Fargate run mid-flight — the run finished and opened
 * its PR, and the row describing it was gone. `pnpm dev:seed` creates this second project for
 * exactly that reason.
 */
const liveProjectId = process.env['INTELLIDEV_TEST_PROJECT_ID']

if (!dsn || !liveProjectId) {
  const why = !dsn ? 'no SUPABASE_CONNECTION_STRING_SESSION' : 'no INTELLIDEV_TEST_PROJECT_ID'
  describe.skip(`durable run tokens (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
} else {
  describe('durable run tokens', () => {
    /**
     * A real run, because `runner.run_tokens.run_id` is a foreign key.
     *
     * That constraint is deliberate — a token for a run that does not exist is meaningless —
     * so there is nothing to fake and the fixture has to be genuine.
     */
    async function seedRun(store: PostgresStore): Promise<string> {
      const found = await store.findProject(liveProjectId!)
      if (!found) throw new Error(`project ${liveProjectId} is not in this database`)
      await allowTestRepo(store, found)
      const task = await store.createTask(TEST_TASK, found)
      return (await store.createRun(task.id, 'claude-code', 'feat/x')).id
    }

    /**
     * Leaves the shared database as it was found.
     *
     * `truncateAll` clears tasks and everything cascading from them, but not the allowlist —
     * and this runs against the project the product team can see, where a stray `acme/widget`
     * surfaces later as a repository nobody remembers adding.
     */
    async function cleanUp(store: PostgresStore): Promise<void> {
      await store.truncateAll()
      const found = await store.findProject(liveProjectId!)
      if (found) await store.removeProjectRepo(found, 'acme', 'widget')
    }

    it('verifies on a second instance a token the first one minted', async () => {
      const minting = new PostgresStore({ connectionString: dsn })
      const verifying = new PostgresStore({ connectionString: dsn })
      try {
        const runId = await seedRun(minting)
        const { token } = await new RunTokenRegistry({ store: minting }).mint(runId)

        // The instance the load balancer happens to route the container's broker call to.
        expect(await new RunTokenRegistry({ store: verifying }).verify(token)).toBe(runId)
      } finally {
        await cleanUp(minting)
        await minting.close()
        await verifying.close()
      }
    })

    it('does not verify on a second instance when the store is only in memory', async () => {
      // The bug this phase fixes, stated as a test: with per-process storage the second
      // instance has never heard of the token.
      const runId = randomUUID()
      const { token } = await new RunTokenRegistry({ store: new InMemoryRunTokens() }).mint(runId)
      expect(await new RunTokenRegistry({ store: new InMemoryRunTokens() }).verify(token)).toBe(
        undefined,
      )
    })

    it('revokes across instances, so settling on one kills the token everywhere', async () => {
      const settling = new PostgresStore({ connectionString: dsn })
      const other = new PostgresStore({ connectionString: dsn })
      try {
        const runId = await seedRun(settling)
        const { token } = await new RunTokenRegistry({ store: settling }).mint(runId)
        await new RunTokenRegistry({ store: settling }).revoke(runId)

        expect(await new RunTokenRegistry({ store: other }).verify(token)).toBeUndefined()
      } finally {
        await cleanUp(settling)
        await settling.close()
        await other.close()
      }
    })

    it('refuses an expired token even though the row is still there', async () => {
      // Expiry is enforced by the registry as well as by the query, so a store returning a
      // stale row cannot extend a token's life.
      const store = new PostgresStore({ connectionString: dsn })
      try {
        const runId = await seedRun(store)
        let now = 1_000
        const registry = new RunTokenRegistry({ store, ttlMs: 100, now: () => now })
        const { token } = await registry.mint(runId)
        expect(await registry.verify(token)).toBe(runId)
        now += 101
        expect(await registry.verify(token)).toBeUndefined()
      } finally {
        await cleanUp(store)
        await store.close()
      }
    })
  })
}
