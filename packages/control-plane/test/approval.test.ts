import { describe, expect, it } from 'vitest'
import { ApprovalRefused, decideRun, settle } from '../src/dispatch.js'
import { InMemoryStore } from '../src/store/memory.js'
import { allowTestRepo, TEST_SCOPE, TEST_REPO_URL } from './fixtures.js'
import type { Store } from '../src/store/types.js'

/**
 * Deciding a run that stopped for approval.
 *
 * The engine parks *after* a stage succeeds, with its cursor already past it — so approving is
 * starting a container that loads what the previous one wrote, and nothing re-runs. These tests
 * are about the decision itself, which is enforced here rather than in the engine: a container is
 * the thing being controlled, so a check inside it would be advice.
 */
async function parkedRun(store: Store, engineState?: Record<string, unknown>) {
  await allowTestRepo(store)
  const task = await store.createTask(
    {
      title: 't',
      description: 'd',
      acceptanceCriteria: ['a'],
      harness: 'claude-code',
      repoUrl: TEST_REPO_URL,
      baseBranch: 'main',
      mcpServerIds: [],
    },
    TEST_SCOPE,
  )
  await store.setTaskStatus(task.id, 'dispatched')
  await store.setTaskStatus(task.id, 'running')
  const run = await store.createRun(task.id, 'claude-code', 'feat/x')
  await store.updateRun(run.id, {
    status: 'parked',
    engineState: engineState ?? {
      cursor: 2,
      status: 'parked',
      records: [{ stage: 'design' }, { stage: 'code' }],
    },
  })
  return { task, runId: run.id }
}

/**
 * Enough of the collaborators for a decision.
 *
 * Typed as the parameters they are rather than cast wholesale: `as never` on the object compiled
 * and then made it unspreadable, which is a cast doing what casts do — moving the problem one
 * line down. The stubs inside are cast individually, because a decision touches none of them.
 */
const deps: Pick<Parameters<typeof decideRun>[0], 'config' | 'mcp' | 'accounts'> = {
  config: {
    mode: 'inline' as const,
    bundleRoot: '/tmp',
    image: 'x',
    projectId: TEST_SCOPE.projectId,
    publicUrl: 'http://127.0.0.1:4000',
    workRoot: '/tmp',
  },
  // Cast individually: a decision touches neither, and standing up a whole McpStore and McpOAuth
  // to prove that would be a fixture larger than the thing under test.
  mcp: { registry: {} as never, oauth: {} as never },
  accounts: {
    async material() {
      return undefined
    },
  } as never,
}

describe('deciding a parked run', () => {
  it('refuses a run that is not waiting for anything', async () => {
    /**
     * The obvious client bug is approving twice. A second approval of a *running* run would start
     * a second container for the same run — two containers sharing one worktree and one branch,
     * which is far worse than a refusal.
     */
    const store = new InMemoryStore()
    const { runId } = await parkedRun(store)
    await store.updateRun(runId, { status: 'running' })

    await expect(decideRun({ store, runId, decision: 'approved', ...deps })).rejects.toThrow(
      ApprovalRefused,
    )
  })

  it('refuses a run that does not exist', async () => {
    const store = new InMemoryStore()
    await expect(
      decideRun({ store, runId: 'nope', decision: 'approved', ...deps }),
    ).rejects.toThrow(ApprovalRefused)
  })

  it('cancels on rejection rather than deleting anything', async () => {
    // "This was rejected" is a different fact from "this never happened", and only one is true.
    const store = new InMemoryStore()
    const { runId, task } = await parkedRun(store)

    const outcome = await decideRun({ store, runId, decision: 'rejected', ...deps })

    expect(outcome.status).toBe('cancelled')
    const after = await store.getRun(runId)
    expect(after?.status).toBe('cancelled')
    expect(after?.failureReason).toMatch(/rejected/)
    // The engine state survives, so what happened stays answerable.
    expect(after?.engineState?.['cursor']).toBe(2)
    expect((await store.getTask(task.id))?.status).toBe('failed')
  })

  it('records the approval against the stage that actually parked', async () => {
    /**
     * Taken from the state, never from the request. A caller naming its own stage could approve
     * one that never asked — the last record is the stage that parked, because parking happens
     * immediately after recording it.
     */
    const store = new InMemoryStore()
    const { runId } = await parkedRun(store)

    await decideRun({ store, runId, decision: 'approved', ...deps })

    const after = await store.getRun(runId)
    expect(after?.engineState?.['approvals']).toEqual({ code: 'approved' })
  })

  it('returns the state to running, or the resumed container would do nothing', async () => {
    /**
     * The engine refuses to re-run a template whose state is already settled, and `parked` is one
     * of those. A container started against unchanged state would load it, decide the run was
     * over, and exit having done nothing at all.
     */
    const store = new InMemoryStore()
    const { runId } = await parkedRun(store)

    await decideRun({ store, runId, decision: 'approved', ...deps })

    const after = await store.getRun(runId)
    expect(after?.engineState?.['status']).toBe('running')
    // And the cursor is untouched: resuming continues where it stopped.
    expect(after?.engineState?.['cursor']).toBe(2)
  })

  it('keeps the same run and branch when it resumes', async () => {
    /**
     * A resume is the same run continuing, not a new attempt. A new run id would split one task's
     * event stream in two; a new branch would strand the commits the approved stages made.
     */
    const store = new InMemoryStore()
    const { runId } = await parkedRun(store)
    const before = await store.getRun(runId)

    const outcome = await decideRun({ store, runId, decision: 'approved', ...deps })

    expect(outcome.runId).toBe(runId)
    expect((await store.getRun(runId))?.branch).toBe(before?.branch)
  })
})

describe('stages pinned to one task', () => {
  /**
   * Copy on write, which is the whole point. A task follows its template until somebody edits
   * it — so improving a project's stages improves every task that has not run — and the first
   * edit makes that task its own without touching the template or any other task.
   */
  async function taskIn(store: Store) {
    await allowTestRepo(store)
    return await store.createTask(
      {
        title: 't',
        description: 'd',
        acceptanceCriteria: ['a'],
        harness: 'claude-code',
        repoUrl: TEST_REPO_URL,
        baseBranch: 'main',
        mcpServerIds: [],
      },
      TEST_SCOPE,
    )
  }

  it('starts out following, with nothing pinned', async () => {
    const store = new InMemoryStore()
    const task = await taskIn(store)
    // Absent, not empty: an empty array would mean "run no stages", which is a different thing.
    expect((await store.getTask(task.id))?.stages).toBeUndefined()
  })

  it('pins on the first edit and leaves everything else alone', async () => {
    const store = new InMemoryStore()
    const a = await taskIn(store)
    const b = await taskIn(store)

    await store.setTaskStages(a.id, [{ id: 'only-code', kind: 'agent', prompt: 'x' }])

    expect((await store.getTask(a.id))?.stages).toHaveLength(1)
    // The other task is untouched, which is what "for this task only" has to mean.
    expect((await store.getTask(b.id))?.stages).toBeUndefined()
  })

  it('can be unpinned, so an edit is not a one-way door', async () => {
    const store = new InMemoryStore()
    const task = await taskIn(store)
    await store.setTaskStages(task.id, [{ id: 'x', kind: 'agent', prompt: 'x' }])

    await store.setTaskStages(task.id, null)

    // Back to following: absent means the same thing it meant before anyone edited.
    expect((await store.getTask(task.id))?.stages).toBeUndefined()
  })
})

describe('a stopped container cannot decide a parked run', () => {
  /**
   * FOUND ON A RUN THAT WORKED. A pipeline gated on `code` ran design, branch and code, changed
   * a file, and parked — and the UI showed "Essential container in task exited · adapter exited
   * 1". Every stage had passed.
   *
   * Parking stops the container on purpose: that is how waiting for a person costs nothing. So
   * ECS reports `EssentialContainerExited`, the reconciler treats a stopped task as a finished
   * run, and `parked` is not terminal — so it was overwritten.
   *
   * Both directions are asserted. Making the adapter exit 0 fixed the message and made the
   * outcome worse: a clean exit reads as `succeeded`, which would mark the task `in_review` and
   * silently grant the approval nobody had given.
   */
  it('does not let a failed container exit overwrite parked', async () => {
    const store = new InMemoryStore()
    const { runId, task } = await parkedRun(store)

    const settled = await settle(store, runId, task.id, 'failed', [], undefined, 'adapter exited 1')

    expect(settled).toBe(false)
    const run = await store.getRun(runId)
    expect(run?.status).toBe('parked')
    // And no reason is written either: a parked run carrying a failure message is what made a
    // working pipeline look broken.
    expect(run?.failureReason).toBeUndefined()
  })

  it('does not let a clean container exit mark parked as succeeded', async () => {
    const store = new InMemoryStore()
    const { runId, task } = await parkedRun(store)

    const settled = await settle(store, runId, task.id, 'succeeded', [])

    expect(settled).toBe(false)
    expect((await store.getRun(runId))?.status).toBe('parked')
    // The task must not advance. `in_review` here would mean the approval had been granted by a
    // container stopping, which is the opposite of what a gate is for.
    expect((await store.getTask(task.id))?.status).toBe('running')
  })

  it('still lets the engine park a running run', async () => {
    // The guard must not block the transition that creates the parked state in the first place.
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const task = await store.createTask(
      {
        title: 't',
        description: 'd',
        acceptanceCriteria: ['a'],
        harness: 'claude-code',
        repoUrl: TEST_REPO_URL,
        baseBranch: 'main',
        mcpServerIds: [],
      },
      TEST_SCOPE,
    )
    await store.setTaskStatus(task.id, 'dispatched')
    await store.setTaskStatus(task.id, 'running')
    const run = await store.createRun(task.id, 'claude-code', 'feat/x')

    expect(await settle(store, run.id, task.id, 'parked', [])).toBe(true)
    expect((await store.getRun(run.id))?.status).toBe('parked')
  })

  it('still settles a run that is merely running when its container dies', async () => {
    // The reconciler's actual job. Declining for `parked` must not decline for everything.
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const task = await store.createTask(
      {
        title: 't',
        description: 'd',
        acceptanceCriteria: ['a'],
        harness: 'claude-code',
        repoUrl: TEST_REPO_URL,
        baseBranch: 'main',
        mcpServerIds: [],
      },
      TEST_SCOPE,
    )
    await store.setTaskStatus(task.id, 'dispatched')
    await store.setTaskStatus(task.id, 'running')
    const run = await store.createRun(task.id, 'claude-code', 'feat/x')

    expect(await settle(store, run.id, task.id, 'failed', [], undefined, 'task vanished')).toBe(
      true,
    )
    const settledRun = await store.getRun(run.id)
    expect(settledRun?.status).toBe('failed')
    expect(settledRun?.failureReason).toBe('task vanished')
  })
})
