import { randomBytes } from 'node:crypto'
import {
  canTransitionTask,
  type AgentEvent,
  type HarnessId,
  type RunStatus,
  type TaskStatus,
} from '@intellidev/shared'
import type { Listener, RunRow, Store, TaskRow } from './types.js'

/**
 * In-memory store, for local development and for tests.
 *
 * Not a fallback and not deprecated: it is what makes the test suite fast and what lets the
 * UI be clicked without a database. What it cannot do is survive a restart or offer
 * `FOR UPDATE SKIP LOCKED`, so seat admission (D2) and the reconciler's restart-survival
 * both need the Postgres implementation.
 *
 * Every method is `async` purely to match the interface. That is the cost of having one
 * contract both implementations satisfy, and it is cheaper than a synchronous interface
 * Postgres could never meet.
 */

export class InMemoryStore implements Store {
  private readonly tasks = new Map<string, TaskRow>()
  private readonly runs = new Map<string, RunRow>()
  private readonly events = new Map<string, AgentEvent[]>()
  private readonly listeners = new Map<string, Set<Listener>>()

  // --- tasks ---------------------------------------------------------------

  async createTask(input: Omit<TaskRow, 'id' | 'status' | 'createdAt'>): Promise<TaskRow> {
    const task: TaskRow = {
      ...input,
      id: `task_${randomBytes(5).toString('hex')}`,
      status: 'not_started',
      createdAt: new Date().toISOString(),
    }
    this.tasks.set(task.id, task)
    return task
  }

  async listTasks(): Promise<TaskRow[]> {
    // Newest first: a dispatch board is read from the top.
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    return this.tasks.get(id)
  }

  /**
   * Move a task's status, refusing transitions the state machine does not allow.
   *
   * Enforced server-side because the UI renders status and must never infer it — a client
   * that could set any status would make the board lie.
   */
  async setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow> {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`no such task ${id}`)
    if (task.status !== status && !canTransitionTask(task.status, status)) {
      throw new Error(`cannot move task ${id} from ${task.status} to ${status}`)
    }
    task.status = status
    return task
  }

  // --- runs ----------------------------------------------------------------

  async createRun(taskId: string, harness: HarnessId, branch: string): Promise<RunRow> {
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

  async getRun(id: string): Promise<RunRow | undefined> {
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
  async findRunByHandle(handle: string): Promise<RunRow | undefined> {
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
  async listUnsettledRuns(): Promise<RunRow[]> {
    const live: readonly RunStatus[] = ['queued', 'provisioning', 'running']
    return [...this.runs.values()].filter((run) => live.includes(run.status))
  }

  async listRuns(taskId?: string): Promise<RunRow[]> {
    const all = [...this.runs.values()]
    const filtered = taskId ? all.filter((r) => r.taskId === taskId) : all
    return filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<RunRow> {
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
  /**
   * Appends one event, rejecting only an exact duplicate.
   *
   * **Not `seq <= seqHwm`**, which is what this used to do. That conflates "I already have
   * this event" with "this event is older than my newest", and those differ precisely when
   * there is a gap: if seq 3 is lost while 4 and 5 arrive, the watermark is 5, and the
   * adapter's replay of 3 would be refused — making the hole permanent. A gapless log is
   * the whole guarantee the sequence numbers exist for, so a late event must be able to
   * fill its own hole. Postgres gets this right for free through the (run, seq) primary
   * key; this is the same rule stated explicitly.
   *
   * `seqHwm` stays the highest seq seen, because that is what SSE's `since` and the UI's
   * "where am I" need — it is a position, not a dedup key.
   */
  async appendEvent(event: AgentEvent): Promise<boolean> {
    const log = this.events.get(event.runId)
    if (!log) return false
    if (log.some((existing) => existing.seq === event.seq)) return false

    log.push(event)
    // Kept in seq order so `eventsSince` needs no sort, matching what SQL returns.
    log.sort((a, b) => a.seq - b.seq)

    const run = this.runs.get(event.runId)
    if (run) run.seqHwm = Math.max(run.seqHwm, event.seq)

    for (const listener of this.listeners.get(event.runId) ?? []) listener(event)
    return true
  }

  /** Everything after `since`. `-1` returns the whole log. */
  async eventsSince(runId: string, since = -1): Promise<AgentEvent[]> {
    return (this.events.get(runId) ?? []).filter((event) => event.seq > since)
  }

  /**
   * Appends a batch, returning how many were new.
   *
   * Trivial here — there is no round trip to save — but it exists so both implementations
   * satisfy one interface and the contract suite can prove they agree.
   */
  async appendEvents(events: readonly AgentEvent[]): Promise<number> {
    let inserted = 0
    for (const event of events) {
      if (await this.appendEvent(event)) inserted += 1
    }
    return inserted
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set()
    set.add(listener)
    this.listeners.set(runId, set)
    return () => set.delete(listener)
  }

  /** Nothing to release. Present so callers need not know which implementation they hold. */
  async close(): Promise<void> {}
}
