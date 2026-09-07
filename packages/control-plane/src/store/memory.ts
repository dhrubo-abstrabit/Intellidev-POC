import { randomUUID } from 'node:crypto'
import {
  canTransitionTask,
  type AgentEvent,
  type HarnessId,
  type RunStatus,
  type TaskStatus,
} from '@intellidev/shared'
import { DeliveryCursor } from './delivery.js'
import {
  RepoNotAllowed,
  type Listener,
  type StageTemplateRow,
  type ProjectRepoRow,
  type ProjectScope,
  type RunRow,
  type Store,
  type TaskRow,
  type StageTemplateInput,
} from './types.js'

interface Subscription {
  readonly listener: Listener
  /**
   * What this subscriber has been given.
   *
   * A cursor rather than a number, because a watermark cannot express "delivered 5, 6 and 7 but
   * not 4" — the state reached when batches arrive out of order, which silently dropped events
   * from live streams. See `DeliveryCursor`.
   */
  readonly cursor: DeliveryCursor
}

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
  private readonly stageTemplates = new Map<string, StageTemplateRow>()
  private readonly tasks = new Map<string, TaskRow>()
  private readonly runs = new Map<string, RunRow>()
  private readonly events = new Map<string, AgentEvent[]>()
  /**
   * One record per subscription, each with its own watermark.
   *
   * Per-subscription rather than per-run: two watchers of the same run join at different
   * points, and a shared watermark would mean whichever subscribed first silently starved
   * the second of its backlog.
   */
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  /**
   * The repository allowlist, modelled here too.
   *
   * Not a convenience: the Postgres store refuses a task whose repository is not listed for its
   * project, and an in-memory store that allowed anything would be a *different* store. The
   * contract suite runs one set of tests against both precisely to catch that kind of drift, so
   * the rule has to live in both.
   */
  private readonly repos = new Map<string, ProjectRepoRow>()

  // --- project repositories ------------------------------------------------

  async addProjectRepo(
    scope: ProjectScope,
    input: { owner: string; repo: string; installationRef: string; defaultBranch?: string },
  ): Promise<ProjectRepoRow> {
    const existing = [...this.repos.values()].find(
      (r) => r.projectId === scope.projectId && r.owner === input.owner && r.repo === input.repo,
    )
    if (existing) return existing
    const row: ProjectRepoRow = {
      id: randomUUID(),
      projectId: scope.projectId,
      clientSpaceId: scope.clientSpaceId,
      owner: input.owner,
      repo: input.repo,
      installationRef: input.installationRef,
      ...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
    }
    this.repos.set(row.id, row)
    return row
  }

  // --- stage templates -----------------------------------------------------

  async listStageTemplates(scope: ProjectScope): Promise<StageTemplateRow[]> {
    return (
      [...this.stageTemplates.values()]
        .filter(
          (t) =>
            t.clientSpaceId === scope.clientSpaceId &&
            (t.projectId === undefined || t.projectId === scope.projectId),
        )
        // A project's own first, matching Postgres — resolution relies on finding an override
        // before the space default it replaces.
        .sort((a, b) => {
          if (Boolean(a.projectId) !== Boolean(b.projectId)) return a.projectId ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    )
  }

  async getStageTemplate(id: string): Promise<StageTemplateRow | undefined> {
    return this.stageTemplates.get(id)
  }

  async saveStageTemplate(
    input: StageTemplateInput,
  ): Promise<StageTemplateRow> {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()

    if (input.isDefault) {
      // Scoped as the Postgres partial index is: a project's default is independent of the
      // space's, so clearing must not reach across that line.
      for (const [key, existing] of this.stageTemplates) {
        if (key === id) continue
        if (existing.clientSpaceId !== input.clientSpaceId) continue
        if ((existing.projectId ?? null) !== (input.projectId ?? null)) continue
        if (existing.isDefault) this.stageTemplates.set(key, { ...existing, isDefault: false })
      }
    }

    const row: StageTemplateRow = {
      id,
      clientSpaceId: input.clientSpaceId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      stages: input.stages,
      isDefault: input.isDefault,
      createdAt: this.stageTemplates.get(id)?.createdAt ?? now,
      updatedAt: now,
    }
    this.stageTemplates.set(id, row)
    return row
  }

  async deleteStageTemplate(id: string): Promise<boolean> {
    return this.stageTemplates.delete(id)
  }

  async listProjectRepos(scope: ProjectScope): Promise<ProjectRepoRow[]> {
    return [...this.repos.values()].filter((r) => r.projectId === scope.projectId)
  }

  async removeProjectRepo(scope: ProjectScope, owner: string, repo: string): Promise<boolean> {
    const found = [...this.repos.values()].find(
      (r) => r.projectId === scope.projectId && r.owner === owner && r.repo === repo,
    )
    if (!found) return false
    this.repos.delete(found.id)
    return true
  }

  // --- tasks ---------------------------------------------------------------

  async createTask(
    input: Omit<TaskRow, 'id' | 'status' | 'createdAt' | 'projectId' | 'clientSpaceId'>,
    scope: ProjectScope,
  ): Promise<TaskRow> {
    const target = parseRepoUrl(input.repoUrl)
    const allowed = target
      ? [...this.repos.values()].find(
          (r) =>
            r.projectId === scope.projectId && r.owner === target.owner && r.repo === target.repo,
        )
      : undefined
    if (!allowed) throw new RepoNotAllowed(input.repoUrl, scope.projectId)

    const task: TaskRow = {
      ...input,
      id: randomUUID(),
      projectId: scope.projectId,
      clientSpaceId: scope.clientSpaceId,
      status: 'not_started',
      createdAt: new Date().toISOString(),
    }
    this.tasks.set(task.id, task)
    return task
  }

  async listTasks(scope: ProjectScope): Promise<TaskRow[]> {
    // Newest first: a dispatch board is read from the top.
    return [...this.tasks.values()]
      .filter((t) => t.projectId === scope.projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`no such task ${taskId}`)
    const run: RunRow = {
      id: randomUUID(),
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

    this.fanOut(event.runId)
    return true
  }

  /** Delivers to every subscription of a run whatever it has not seen, in seq order. */
  private fanOut(runId: string): void {
    const log = this.events.get(runId) ?? []
    for (const subscription of this.subscriptions.get(runId) ?? []) {
      for (const event of log) {
        if (!subscription.cursor.record(event.seq)) continue
        subscription.listener(event)
      }
    }
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

  subscribe(runId: string, listener: Listener, opts: { since?: number } = {}): () => void {
    const log = this.events.get(runId) ?? []
    const subscription: Subscription = {
      listener,
      // Omitting `since` means "only what arrives from now on", so the cursor starts at the
      // newest event rather than at -1.
      cursor: new DeliveryCursor(opts.since === undefined ? (log.at(-1)?.seq ?? -1) : opts.since),
    }
    const set = this.subscriptions.get(runId) ?? new Set()
    set.add(subscription)
    this.subscriptions.set(runId, set)

    // Backfill on the next tick, matching Postgres, where the read is a round trip. Doing it
    // synchronously here would make the two implementations differ in observable timing and
    // let a test pass against one and fail against the other.
    if (opts.since !== undefined) queueMicrotask(() => this.fanOut(runId))

    return () => set.delete(subscription)
  }

  /** Nothing to release. Present so callers need not know which implementation they hold. */
  async close(): Promise<void> {}
}

/**
 * `owner` and `repo` from a clone URL. Mirrors the Postgres store's parser.
 *
 * Duplicated rather than shared because it is three lines and the alternative is a module both
 * stores import for one regex — but if a third caller ever needs it, that is the moment to
 * extract it rather than now.
 */
function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | undefined {
  const path = (() => {
    try {
      return new URL(repoUrl).pathname
    } catch {
      return /^[^@]+@[^:]+:(.+)$/.exec(repoUrl)?.[1]
    }
  })()
  const parts = (path ?? '')
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .split('/')
  return parts.length >= 2 && parts[0] && parts[1] ? { owner: parts[0], repo: parts[1] } : undefined
}
