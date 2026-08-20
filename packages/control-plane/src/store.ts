import { randomBytes } from 'node:crypto'
import {
  canTransitionTask,
  type AgentEvent,
  type HarnessId,
  type RunStatus,
  type StageRecord,
  type TaskStatus,
} from '@intellidev/shared'

/**
 * In-memory store.
 *
 * NOT the real thing. `docs/stack.md` commits to Postgres + Drizzle, and this exists so a
 * UI can be clicked before that lands. Two consequences worth stating rather than
 * discovering: everything is lost on restart, and there is no `FOR UPDATE SKIP LOCKED`, so
 * seat admission (M3) cannot be built on it.
 *
 * The shapes deliberately match the tables in `docs/architecture.md §10`, so replacing this
 * with Drizzle is a swap behind the same methods.
 */
export interface TaskRow {
  id: string
  title: string
  description: string
  details?: string
  acceptanceCriteria: string[]
  harness: HarnessId
  status: TaskStatus
  createdAt: string
  repoUrl: string
  baseBranch: string
  /**
   * Which connected servers this task uses, by id.
   *
   * Ids, not inline config: a server is connected once in the UI and reused, so a task holds
   * a reference and never a credential.
   */
  mcpServerIds: string[]
}

export interface RunRow {
  id: string
  taskId: string
  status: RunStatus
  harness: HarnessId
  branch: string
  startedAt: string
  endedAt?: string
  /** Highest sequence number seen, so a reconnecting client knows where it is. */
  seqHwm: number
  records: StageRecord[]
  prUrl?: string
  failureReason?: string
  /** Runtime handle: container name locally, task ARN on Fargate. */
  handle?: string
}

type Listener = (event: AgentEvent) => void

export class Store {
  private readonly tasks = new Map<string, TaskRow>()
  private readonly runs = new Map<string, RunRow>()
  private readonly events = new Map<string, AgentEvent[]>()
  private readonly listeners = new Map<string, Set<Listener>>()

  // --- tasks ---------------------------------------------------------------

  createTask(input: Omit<TaskRow, 'id' | 'status' | 'createdAt'>): TaskRow {
    const task: TaskRow = {
      ...input,
      id: `task_${randomBytes(5).toString('hex')}`,
      status: 'not_started',
      createdAt: new Date().toISOString(),
    }
    this.tasks.set(task.id, task)
    return task
  }

  listTasks(): TaskRow[] {
    // Newest first: a dispatch board is read from the top.
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getTask(id: string): TaskRow | undefined {
    return this.tasks.get(id)
  }

  /**
   * Move a task's status, refusing transitions the state machine does not allow.
   *
   * Enforced server-side because the UI renders status and must never infer it — a client
   * that could set any status would make the board lie.
   */
  setTaskStatus(id: string, status: TaskStatus): TaskRow {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`no such task ${id}`)
    if (task.status !== status && !canTransitionTask(task.status, status)) {
      throw new Error(`cannot move task ${id} from ${task.status} to ${status}`)
    }
    task.status = status
    return task
  }

  // --- runs ----------------------------------------------------------------

  createRun(taskId: string, harness: HarnessId, branch: string): RunRow {
    const run: RunRow = {
      id: `run_${randomBytes(5).toString('hex')}`,
      taskId,
      status: 'queued',
      harness,
      branch,
      startedAt: new Date().toISOString(),
      seqHwm: -1,
      records: [],
    }
    this.runs.set(run.id, run)
    this.events.set(run.id, [])
    return run
  }

  getRun(id: string): RunRow | undefined {
    return this.runs.get(id)
  }

  /**
   * Finds a run by its runtime handle — a container name locally, a task ARN on Fargate.
   *
   * The lifecycle reconciler and the ECS task-state consumer both start from a task ARN and
   * need the run it belongs to. Matching on the handle rather than a tag is deliberate: an
   * ECS task-state-change event does not reliably carry task tags, and the handle is
   * already recorded at dispatch precisely so a run can be found from the outside.
   */
  findRunByHandle(handle: string): RunRow | undefined {
    for (const run of this.runs.values()) {
      if (run.handle === handle) return run
    }
    return undefined
  }

  /**
   * Runs that should have a live task behind them. What the reconciler sweeps.
   *
   * Not just `running`: a task killed while still PROVISIONING leaves its run in
   * `provisioning`, and filtering on `running` alone would make it invisible to the sweep
   * for ever — the exact leak the reconciler exists to close.
   *
   * `parked` is excluded deliberately. It is non-terminal but intentionally paused, waiting
   * on a human rather than on a container, so a sweep finding no task for it is expected
   * rather than evidence of a death.
   */
  listUnsettledRuns(): RunRow[] {
    const live: readonly RunStatus[] = ['queued', 'provisioning', 'running']
    return [...this.runs.values()].filter((run) => live.includes(run.status))
  }

  listRuns(taskId?: string): RunRow[] {
    const all = [...this.runs.values()]
    const filtered = taskId ? all.filter((r) => r.taskId === taskId) : all
    return filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  updateRun(id: string, patch: Partial<RunRow>): RunRow {
    const run = this.runs.get(id)
    if (!run) throw new Error(`no such run ${id}`)
    Object.assign(run, patch)
    return run
  }

  // --- events --------------------------------------------------------------

  /**
   * Append an event and fan it out to live listeners.
   *
   * Out-of-order or duplicate sequence numbers are dropped rather than stored: the adapter
   * replays from its last acked seq after a reconnect, so a duplicate is expected traffic
   * and must not become a duplicate row.
   */
  appendEvent(event: AgentEvent): boolean {
    const log = this.events.get(event.runId)
    if (!log) return false
    const run = this.runs.get(event.runId)
    if (run && event.seq <= run.seqHwm) return false

    log.push(event)
    if (run) run.seqHwm = event.seq

    for (const listener of this.listeners.get(event.runId) ?? []) listener(event)
    return true
  }

  /** Everything after `since`. `-1` returns the whole log. */
  eventsSince(runId: string, since = -1): AgentEvent[] {
    return (this.events.get(runId) ?? []).filter((event) => event.seq > since)
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set()
    set.add(listener)
    this.listeners.set(runId, set)
    return () => set.delete(listener)
  }
}
