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
