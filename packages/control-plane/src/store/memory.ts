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
  type TaskArtifactRow,
  type ArtifactKind,
  type ArtifactStorage,
  type TaskArtifactSummary,
  type TaskArtifactInput,
  type TaskArtifactContent,
  type TaskArtifactVersionRow,
} from './types.js'
import {
  BlobStoreUnavailable,
  chooseStorage,
  defaultContentType,
  sha256Hex,
  type ArtifactBlobs,
} from './artifact-blobs.js'

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
  private readonly artifacts = new Map<string, MemoryArtifact>()
  /** Where non-text artifact bytes go. See `PostgresStore.useArtifactBlobs`. */
  private blobs: ArtifactBlobs | undefined

  useArtifactBlobs(blobs: ArtifactBlobs | undefined): void {
    this.blobs = blobs
  }
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

  async saveStageTemplate(input: StageTemplateInput): Promise<StageTemplateRow> {
    /**
     * A name is a natural key within its scope, so saving over one is an edit.
     *
     * Postgres enforces that with a partial unique index; this store has to be told, or the two
     * would disagree — and the disagreement would show up as a test that passes here and a 500
     * in production, which is exactly how this was found.
     */
    const existing = [...this.stageTemplates.values()].find(
      (t) =>
        t.clientSpaceId === input.clientSpaceId &&
        (t.projectId ?? null) === (input.projectId ?? null) &&
        t.name === input.name,
    )
    const id = input.id ?? existing?.id ?? randomUUID()
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

  // --- task artifacts ------------------------------------------------------

  /** Kept per artifact, matching the Postgres store so the contract tests cover both. */
  private artifactVersionsKept = 20

  /** Set by a test that wants to prove pruning without writing twenty rows. */
  useArtifactVersionsKept(kept: number): void {
    this.artifactVersionsKept = kept
  }

  async listTaskArtifacts(taskId: string): Promise<TaskArtifactSummary[]> {
    return [...this.artifacts.values()]
      .filter((a) => a.taskId === taskId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => withoutBody(this.currentRow(a)))
  }

  async listProjectArtifacts(scope: ProjectScope, limit = 100): Promise<TaskArtifactSummary[]> {
    return [...this.artifacts.values()]
      .filter((a) => a.projectId === scope.projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((a) => withoutBody(this.currentRow(a)))
  }

  async getTaskArtifact(id: string): Promise<TaskArtifactRow | undefined> {
    const artifact = this.artifacts.get(id)
    return artifact ? this.currentRow(artifact) : undefined
  }

  async findTaskArtifact(taskId: string, name: string): Promise<TaskArtifactRow | undefined> {
    const artifact = [...this.artifacts.values()].find(
      (a) => a.taskId === taskId && a.name === name,
    )
    return artifact ? this.currentRow(artifact) : undefined
  }

  async listTaskArtifactVersions(id: string): Promise<TaskArtifactVersionRow[]> {
    const artifact = this.artifacts.get(id)
    if (!artifact) return []
    return [...artifact.versions]
      .sort((a, b) => b.version - a.version)
      .map((v) => ({
        version: v.version,
        kind: v.kind,
        contentType: v.contentType,
        ...(v.title ? { title: v.title } : {}),
        storage: v.storage,
        sha256: v.sha256,
        bytes: v.bytes,
        ...(v.runId ? { runId: v.runId } : {}),
        ...(v.stage ? { stage: v.stage } : {}),
        createdAt: v.createdAt,
        isCurrent: v.version === artifact.currentVersion,
      }))
  }

  async setCurrentArtifactVersion(
    id: string,
    version: number,
  ): Promise<TaskArtifactRow | undefined> {
    const artifact = this.artifacts.get(id)
    if (!artifact?.versions.some((v) => v.version === version)) return undefined
    artifact.currentVersion = version
    artifact.updatedAt = new Date().toISOString()
    return this.currentRow(artifact)
  }

  async saveTaskArtifact(scope: ProjectScope, input: TaskArtifactInput): Promise<TaskArtifactRow> {
    const bytes = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8')
    const contentType = input.contentType ?? defaultContentType(input.kind)
    if (!contentType) {
      throw new Error(`a ${input.kind} artifact must say what its content type is`)
    }
    const storage = chooseStorage(input.kind, bytes.byteLength)
    // The same refusal Postgres gives, so a test that never touches a bucket still proves the
    // deployment-without-one case behaves.
    if (storage === 's3' && !this.blobs) throw new BlobStoreUnavailable(input.kind)

    /**
     * A name that already exists gains a version rather than becoming a second artifact.
     *
     * Postgres enforces the name's uniqueness with an index and this store has to be told, or
     * the two disagree — and the disagreement shows up as a test that passes here and a 500 in
     * production, which is exactly how the stage editor came to fail on every second save.
     */
    const existing = [...this.artifacts.values()].find(
      (a) => a.taskId === input.taskId && a.name === input.name,
    )
    const now = new Date().toISOString()
    const artifact: MemoryArtifact =
      existing ??
      ({
        id: randomUUID(),
        clientSpaceId: scope.clientSpaceId,
        projectId: scope.projectId,
        taskId: input.taskId,
        name: input.name,
        currentVersion: 0,
        versions: [],
        createdAt: now,
        updatedAt: now,
      } satisfies MemoryArtifact)

    const version = Math.max(0, ...artifact.versions.map((v) => v.version)) + 1

    let storageKey: string | undefined
    if (storage === 's3') {
      // The version is in the name, so a revision is a new object rather than a mutation of
      // bytes an earlier version still claims.
      storageKey = await this.blobs!.put({
        projectId: scope.projectId,
        taskId: input.taskId,
        artifactId: artifact.id,
        name: `v${version}-${input.name}`,
        contentType,
        bytes,
      })
    }

    artifact.versions.push({
      version,
      kind: input.kind,
      contentType,
      ...(input.title ? { title: input.title } : {}),
      storage,
      ...(storage === 'inline' ? { body: bytes.toString('utf8') } : {}),
      ...(storageKey ? { storageKey } : {}),
      sha256: sha256Hex(bytes),
      // Bytes, not characters, matching the column's `octet_length` constraint.
      bytes: bytes.byteLength,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      createdAt: now,
    })
    artifact.currentVersion = version
    artifact.updatedAt = now
    this.artifacts.set(artifact.id, artifact)

    // Oldest first, and never the current one: someone may switch back to v1 and keep working
    // from it, and the pointer must not be left dangling.
    const overBy = artifact.versions.length - this.artifactVersionsKept
    if (overBy > 0) {
      const doomed = [...artifact.versions]
        .sort((a, b) => a.version - b.version)
        .filter((v) => v.version !== artifact.currentVersion)
        .slice(0, overBy)
      for (const v of doomed) {
        if (v.storageKey) await this.blobs?.delete(v.storageKey).catch(() => undefined)
      }
      artifact.versions = artifact.versions.filter((v) => !doomed.includes(v))
    }

    return this.currentRow(artifact)
  }

  async readTaskArtifactContent(
    id: string,
    version?: number,
  ): Promise<TaskArtifactContent | undefined> {
    const artifact = this.artifacts.get(id)
    if (!artifact) return undefined
    const v = artifact.versions.find(
      (candidate) => candidate.version === (version ?? artifact.currentVersion),
    )
    if (!v) return undefined
    if (v.storage === 'inline') {
      return v.body === undefined
        ? undefined
        : { contentType: v.contentType, bytes: Buffer.from(v.body, 'utf8'), sha256: v.sha256 }
    }
    if (!v.storageKey || !this.blobs) return undefined
    const bytes = await this.blobs.get(v.storageKey)
    return bytes ? { contentType: v.contentType, bytes, sha256: v.sha256 } : undefined
  }

  async deleteTaskArtifact(id: string): Promise<boolean> {
    // Every version's object goes with the artifact, as in the Postgres store — so a contract
    // test covers both.
    const artifact = this.artifacts.get(id)
    const removed = this.artifacts.delete(id)
    for (const v of artifact?.versions ?? []) {
      if (v.storageKey) await this.blobs?.delete(v.storageKey).catch(() => undefined)
    }
    return removed
  }

  /** The identity joined to the version it currently shows, which is what a read returns. */
  private currentRow(artifact: MemoryArtifact): TaskArtifactRow {
    const v = artifact.versions.find((candidate) => candidate.version === artifact.currentVersion)
    if (!v) throw new Error(`artifact ${artifact.id} has no version ${artifact.currentVersion}`)
    return {
      id: artifact.id,
      clientSpaceId: artifact.clientSpaceId,
      projectId: artifact.projectId,
      taskId: artifact.taskId,
      name: artifact.name,
      version: v.version,
      versionCount: artifact.versions.length,
      kind: v.kind,
      ...(v.title ? { title: v.title } : {}),
      ...(v.body === undefined ? {} : { body: v.body }),
      contentType: v.contentType,
      storage: v.storage,
      ...(v.storageKey ? { storageKey: v.storageKey } : {}),
      sha256: v.sha256,
      bytes: v.bytes,
      ...(v.runId ? { runId: v.runId } : {}),
      ...(v.stage ? { stage: v.stage } : {}),
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    }
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
  async setTaskStages(taskId: string, stages: unknown[] | null): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`no such task ${taskId}`)
    // Deleted rather than set to null, so `stages` being absent means the same thing in both
    // stores: this task follows its template.
    if (stages === null) delete task.stages
    else task.stages = stages
  }

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

/**
 * Drop the body for a list.
 *
 * The same distinction the Postgres store draws by naming columns: a list is read far more often
 * than a body, and one artifact may be most of a megabyte.
 */
function withoutBody(row: TaskArtifactRow): TaskArtifactSummary {
  const { body: _body, ...summary } = row
  return summary
}

/**
 * How an artifact is held in memory: an identity with its versions.
 *
 * Mirrors the two tables rather than the row a read returns, because the shape is what the
 * behaviour turns on — a name gaining a version instead of becoming a second artifact, and a
 * switch being a change of pointer. Flattening it here would let this store pass tests that
 * Postgres fails.
 */
interface MemoryArtifactVersion {
  version: number
  kind: ArtifactKind
  contentType: string
  title?: string
  storage: ArtifactStorage
  body?: string
  storageKey?: string
  sha256: string
  bytes: number
  runId?: string
  stage?: string
  createdAt: string
}

interface MemoryArtifact {
  id: string
  clientSpaceId: string
  projectId: string
  taskId: string
  name: string
  currentVersion: number
  versions: MemoryArtifactVersion[]
  createdAt: string
  updatedAt: string
}
