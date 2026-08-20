import { describe, expect, it } from 'vitest'
import { LifecycleReconciler, stoppedReason } from '../src/lifecycle/reconciler.js'
import { InMemoryStore } from '../src/store.js'

const ARN = 'arn:aws:ecs:ap-south-1:1:task/intellidev-dev-runners/abc'

/** A store with one dispatched run whose handle is a task ARN. */
async function storeWithRun(handle = ARN) {
  const store = new InMemoryStore()
  const task = await store.createTask({
    title: 't',
    description: 'd',
    acceptanceCriteria: ['a'],
    harness: 'claude-code',
    repoUrl: 'https://example.test/r.git',
    baseBranch: 'main',
    mcpServerIds: [],
  })
  // Walked through the real transitions rather than forced: a dispatched run's task is
  // `running`, and settling from `not_started` would be refused by the state machine — so
  // a fixture that skipped this would test a state that cannot exist.
  await store.setTaskStatus(task.id, 'dispatched')
  await store.setTaskStatus(task.id, 'running')
  const run = await store.createRun(task.id, 'claude-code', 'feat/x')
  await store.updateRun(run.id, { handle, status: 'running' })
  return { store, runId: run.id, taskId: task.id }
}

function reconciler(opts: {
  store: InMemoryStore
  tasks?: unknown[]
  messages?: unknown[]
  onSend?: (input: Record<string, unknown>) => void
}) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    instance: new LifecycleReconciler({
      store: opts.store,
      clusterName: 'intellidev-dev-runners',
      queueUrl: 'https://sqs/q',
      region: 'ap-south-1',
      ecs: {
        send: async (c: { input: Record<string, unknown> }) => {
          sent.push(c.input)
          return { tasks: opts.tasks ?? [] }
        },
      } as never,
      sqs: {
        send: async (c: { input: Record<string, unknown> }) => {
          sent.push(c.input)
          opts.onSend?.(c.input)
          return { Messages: opts.messages ?? [] }
        },
      } as never,
    }),
  }
}

describe('the sweep', () => {
  it('settles a run whose task ECS has forgotten', async () => {
    // ECS keeps a stopped task queryable for about an hour, then forgets it. A run still
    // marked running with no task is the exact leak this whole mechanism exists for.
    const { store, runId } = await storeWithRun()
    const settled = await reconciler({ store, tasks: [] }).instance.sweep()
    expect(settled).toHaveLength(1)
    expect(settled[0]?.reason).toMatch(/no longer known to ECS/)
    expect((await store.getRun(runId))?.status).toBe('failed')
  })

  it('settles a stopped task with the reason a human can act on', async () => {
    const { store, runId } = await storeWithRun()
    const settled = await reconciler({
      store,
      tasks: [
        {
          taskArn: ARN,
          lastStatus: 'STOPPED',
          stoppedReason: 'Essential container in task exited',
          containers: [{ name: 'adapter', exitCode: 137, reason: 'OutOfMemoryError' }],
        },
      ],
    }).instance.sweep()
    expect(settled).toHaveLength(1)
    // "Essential container in task exited" is true and useless; the OOM is the fact.
    expect((await store.getRun(runId))?.failureReason).toMatch(/OutOfMemoryError/)
    expect((await store.getRun(runId))?.status).toBe('failed')
  })

  it('leaves a still-running task alone', async () => {
    const { store, runId } = await storeWithRun()
    const settled = await reconciler({
      store,
      tasks: [{ taskArn: ARN, lastStatus: 'RUNNING' }],
    }).instance.sweep()
    expect(settled).toEqual([])
    expect((await store.getRun(runId))?.status).toBe('running')
  })

  it('reports success only when a container actually exited 0', async () => {
    const { store, runId } = await storeWithRun()
    await reconciler({
      store,
      tasks: [
        { taskArn: ARN, lastStatus: 'STOPPED', containers: [{ name: 'adapter', exitCode: 0 }] },
      ],
    }).instance.sweep()
    expect((await store.getRun(runId))?.status).toBe('succeeded')
  })

  it('does not call ECS when nothing is running', async () => {
    const store = new InMemoryStore()
    const r = reconciler({ store })
    expect(await r.instance.sweep()).toEqual([])
    expect(r.sent).toHaveLength(0)
  })

  it('ignores runs whose handle is a container name, not a task ARN', async () => {
    // Docker-mode runs are observed by the runner's own child process; sweeping them
    // against ECS would settle every local run as "not known to ECS".
    const { store, runId } = await storeWithRun('intellidev-run_abc-1a2b3c')
    expect(await reconciler({ store }).instance.sweep()).toEqual([])
    expect((await store.getRun(runId))?.status).toBe('running')
  })
})

describe('idempotency across the three paths', () => {
  it('does not overwrite a run the runner already settled', async () => {
    // The runner's observed outcome, the queue and the sweep all race by design. Whichever
    // is first wins; the reconciler's generic "task is gone" must not replace a real cause.
    const { store, runId, taskId } = await storeWithRun()
    await store.updateRun(runId, { status: 'succeeded', failureReason: undefined })
    void taskId
    const settled = await reconciler({ store, tasks: [] }).instance.sweep()
    expect(settled).toEqual([])
    expect((await store.getRun(runId))?.status).toBe('succeeded')
  })

  it('settles once when the sweep runs twice', async () => {
    const { store } = await storeWithRun()
    const r = reconciler({
      store,
      tasks: [
        { taskArn: ARN, lastStatus: 'STOPPED', containers: [{ name: 'adapter', exitCode: 1 }] },
      ],
    })
    expect(await r.instance.sweep()).toHaveLength(1)
    expect(await r.instance.sweep()).toHaveLength(0)
  })
})

describe('stoppedReason', () => {
  it('puts the container reason first, since that is the actionable part', () => {
    expect(
      stoppedReason({
        stoppedReason: 'Essential container in task exited',
        containers: [{ name: 'adapter', exitCode: 137, reason: 'OutOfMemoryError' }],
      }),
    ).toMatch(/^OutOfMemoryError/)
  })

  it('surfaces a failed image pull, which has no exit code at all', () => {
    const reason = stoppedReason({
      stopCode: 'TaskFailedToStart',
      containers: [{ name: 'adapter', reason: 'CannotPullContainerError: not found' }],
    })
    expect(reason).toMatch(/CannotPullContainerError/)
    expect(reason).toMatch(/TaskFailedToStart/)
  })

  it('says so plainly when ECS gave nothing', () => {
    // Better than an empty string on the run row, which reads like a missing field.
    expect(stoppedReason({})).toMatch(/no reason given/)
  })
})

describe('the queue path', () => {
  const event = (detail: Record<string, unknown>) =>
    JSON.stringify({ source: 'aws.ecs', 'detail-type': 'ECS Task State Change', detail })

  it('settles a run from an ECS task-state-change event', async () => {
    const { store, runId } = await storeWithRun()
    const handled = await reconciler({ store }).instance.handleMessage(
      event({
        taskArn: ARN,
        lastStatus: 'STOPPED',
        stopCode: 'TaskFailedToStart',
        containers: [{ name: 'adapter', reason: 'CannotPullContainerError: manifest unknown' }],
      }),
    )
    expect(handled).toBe(true)
    expect((await store.getRun(runId))?.status).toBe('failed')
    // A failed image pull has no exit code at all, which is why exitCode alone is not
    // enough to explain a run.
    expect((await store.getRun(runId))?.failureReason).toMatch(/CannotPullContainerError/)
  })

  it('deletes an event for a task that is not one of our runs', async () => {
    // The egress probe and the pull probe run in the same cluster. Not an error, and
    // leaving the message would cycle it into the DLQ three redeliveries later.
    const { store } = await storeWithRun()
    const handled = await reconciler({ store }).instance.handleMessage(
      event({
        taskArn: 'arn:aws:ecs:ap-south-1:1:task/intellidev-dev-runners/probe',
        lastStatus: 'STOPPED',
      }),
    )
    expect(handled).toBe(true)
  })

  it('deletes an unparseable message rather than retrying it three times', async () => {
    const { store } = await storeWithRun()
    expect(await reconciler({ store }).instance.handleMessage('not json at all')).toBe(true)
  })

  it('ignores a non-terminal transition', async () => {
    const { store, runId } = await storeWithRun()
    await reconciler({ store }).instance.handleMessage(
      event({ taskArn: ARN, lastStatus: 'RUNNING' }),
    )
    expect((await store.getRun(runId))?.status).toBe('running')
  })
})

describe('every non-terminal status is sweepable', () => {
  // The bug this covers was found by a live test, not by these tests: a task killed while
  // still PROVISIONING leaves its run in `provisioning`, and an earlier guard of
  // `status !== 'running'` made it permanently invisible to the reconciler.
  for (const status of ['queued', 'provisioning', 'running'] as const) {
    it(`settles a run left in ${status}`, async () => {
      const { store, runId } = await storeWithRun()
      await store.updateRun(runId, { status })
      const settled = await reconciler({ store, tasks: [] }).instance.sweep()
      expect(settled, `a ${status} run must not be invisible to the sweep`).toHaveLength(1)
      expect((await store.getRun(runId))?.status).toBe('failed')
    })
  }

  it('leaves a parked run alone', async () => {
    // Non-terminal, but waiting on a human rather than a container: finding no task for it
    // is expected, not evidence of a death.
    const { store, runId } = await storeWithRun()
    await store.updateRun(runId, { status: 'parked' })
    expect(await reconciler({ store, tasks: [] }).instance.sweep()).toEqual([])
    expect((await store.getRun(runId))?.status).toBe('parked')
  })

  for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
    it(`does not re-settle a ${status} run`, async () => {
      const { store, runId } = await storeWithRun()
      await store.updateRun(runId, { status })
      expect(await reconciler({ store, tasks: [] }).instance.sweep()).toEqual([])
      expect((await store.getRun(runId))?.status).toBe(status)
    })
  }
})
