import { describe, expect, it } from 'vitest'
import { projectRunEvent } from '../src/dispatch.js'
import { InMemoryStore } from '../src/store/memory.js'
import { allowTestRepo, TEST_SCOPE, TEST_TASK } from './fixtures.js'
import type { AgentEvent } from '@intellidev/shared'

/**
 * What a run looks like afterwards, derived from its event stream.
 *
 * FOUND BY RUNNING IT. This projection lived inside dispatch's own sink, which the inline and
 * docker paths feed by tailing an events file. On Fargate there is no file — the container dials
 * out over a WebSocket and the server appends straight to the store — so none of it ran. A real
 * Fargate run finished `succeeded` with zero stage records and a null `pr_url` while its PR sat
 * open on GitHub: the run worked, and everything a person would look at afterwards was missing.
 *
 * The tests are about *what gets recorded*, not about which transport delivered the event, which
 * is the distinction the bug turned on.
 */
describe('projecting a run from its events', () => {
  async function seed() {
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const task = await store.createTask(TEST_TASK, TEST_SCOPE)
    await store.setTaskStatus(task.id, 'dispatched')
    const run = await store.createRun(task.id, 'claude-code', 'feat/x')
    return { store, task, run }
  }

  /** `stage` is a top-level field on the canonical event, not part of `data`. */
  const event = (
    type: string,
    seq: number,
    data: Record<string, unknown> = {},
    stage?: string,
  ): AgentEvent =>
    ({
      runId: 'r',
      seq,
      ts: new Date().toISOString(),
      type,
      ...(stage ? { stage } : {}),
      data,
    }) as unknown as AgentEvent

  it('records the PR url, which is the most useful thing a run produces', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(
      store,
      run.id,
      task.id,
      event('pr.opened', 1, {
        url: 'https://github.com/acme/widget/pull/3',
        base: 'main',
        head: 'feat/x',
        number: 3,
      }),
    )
    expect((await store.getRun(run.id))?.prUrl).toBe('https://github.com/acme/widget/pull/3')
  })

  it('moves the run and the task when the run starts', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(store, run.id, task.id, event('run.started', 0))
    expect((await store.getRun(run.id))?.status).toBe('running')
    // The task has to move too: `dispatched → in_review` is not a legal transition, so without
    // this the task would be stuck on `dispatched` while its run reported success.
    expect((await store.getTask(task.id))?.status).toBe('running')
  })

  it('rebuilds stage records, so a container run does not show an empty stage list', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(
      store,
      run.id,
      task.id,
      event('stage.entered', 0, { attempt: 1 }, 'design'),
    )
    const records = (await store.getRun(run.id))?.records ?? []
    expect(records).toMatchObject([{ stage: 'design', attempt: 1, status: 'running' }])

    // And the exit closes the same record rather than appending a second one.
    await projectRunEvent(
      store,
      run.id,
      task.id,
      event('stage.exited', 1, { attempt: 1, outcome: 'passed' }, 'design'),
    )
    expect((await store.getRun(run.id))?.records).toMatchObject([
      { stage: 'design', attempt: 1, status: 'passed' },
    ])
  })
})

/**
 * The projection must be reachable from both event paths.
 *
 * A source-level check, because the failure is an absence: the WebSocket handler simply did not
 * call it, and every test passed while Fargate runs lost their stage records and PR links. There
 * is no assertion about behaviour that fails when a call site is missing — only this.
 */
describe('both event paths project', () => {
  it('is applied on the websocket path, not only in dispatch', async () => {
    const { readFileSync } = await import('node:fs')
    const server = readFileSync(new URL('../src/server.ts', import.meta.url).pathname, 'utf8')
    expect(server).toContain('projectRunEvent(')
    // Specifically after the append: projecting before it would record state for an event that
    // then failed to store.
    const appendAt = server.indexOf('await store.appendEvent(parsed.data)')
    const projectAt = server.indexOf('projectRunEvent(', appendAt)
    expect(appendAt).toBeGreaterThan(-1)
    expect(projectAt).toBeGreaterThan(appendAt)
  })
})

describe('a run says how it ended, and that is what settles it', () => {
  /**
   * FOUND ON A RUN THAT PARKED AND WAS REPORTED SUCCEEDED. Nothing projected `run.finished`, so
   * for a container run the only settler was the reconciler reading the ECS stop reason — which
   * knows how the task stopped and nothing about why.
   *
   * A run that parked for approval therefore looked like whatever its exit code said: `failed`
   * while the adapter exited 1, then `succeeded` once it exited 0 — which marked the task ready
   * for review with the approval still outstanding. Both readings were wrong, and the second
   * silently granted the gate.
   */
  async function seed(status = 'running') {
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const task = await store.createTask(TEST_TASK, TEST_SCOPE)
    await store.setTaskStatus(task.id, 'dispatched')
    await store.setTaskStatus(task.id, 'running')
    const run = await store.createRun(task.id, 'claude-code', 'feat/x')
    await store.updateRun(run.id, { status: status as never })
    return { store, task, run }
  }

  const finished = (outcome: string, reason?: string): AgentEvent =>
    ({
      runId: 'r',
      seq: 9,
      ts: new Date().toISOString(),
      type: 'run.finished',
      data: { outcome, ...(reason ? { reason } : {}) },
    }) as unknown as AgentEvent

  it('parks the run, and leaves the task running', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(store, run.id, task.id, finished('parked', 'awaiting approval'))

    expect((await store.getRun(run.id))?.status).toBe('parked')
    /**
     * The task must not move. `failed` was the else branch of "succeeded", so a run waiting for
     * a person showed FAILED in the task list — a warning at the one moment somebody is being
     * invited to look.
     */
    expect((await store.getTask(task.id))?.status).toBe('running')
    // And no failure reason: a parked run carrying one is what made a working pipeline look
    // broken.
    expect((await store.getRun(run.id))?.failureReason).toBeUndefined()
  })

  it('settles a failure with the reason the run gave, not the one ECS would', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(store, run.id, task.id, finished('failed', 'the test stage failed twice'))

    const settled = await store.getRun(run.id)
    expect(settled?.status).toBe('failed')
    // The point of projecting this at all: the run knows why, and "Essential container in task
    // exited" does not.
    expect(settled?.failureReason).toBe('the test stage failed twice')
    expect((await store.getTask(task.id))?.status).toBe('failed')
  })

  it('settles a success and moves the task to review', async () => {
    const { store, task, run } = await seed()
    await projectRunEvent(store, run.id, task.id, finished('succeeded'))

    expect((await store.getRun(run.id))?.status).toBe('succeeded')
    expect((await store.getTask(task.id))?.status).toBe('in_review')
  })

  it('revokes the run token once the run is settled', async () => {
    // The credential outlives nothing. Passed through rather than revoked in the projection,
    // because settling is the moment it stops being needed and two owners is how one forgets.
    const { store, task, run } = await seed()
    const revoked: string[] = []
    await projectRunEvent(store, run.id, task.id, finished('succeeded'), {
      async revoke(id: string) {
        revoked.push(id)
      },
    })
    // Not awaited inside settle, so give the microtask a turn.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revoked).toEqual([run.id])
  })

  it('does not re-settle a run that already reported', async () => {
    // The reconciler settles the same run from the ECS stop event. Whichever arrives first
    // wins; the rest must be no-ops, or the specific cause is replaced by "the task is gone".
    const { store, task, run } = await seed()
    await projectRunEvent(store, run.id, task.id, finished('failed', 'the real reason'))
    await projectRunEvent(store, run.id, task.id, finished('failed', 'a later, vaguer reason'))

    expect((await store.getRun(run.id))?.failureReason).toBe('the real reason')
  })
})
