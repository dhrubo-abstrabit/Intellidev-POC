import type { StageTemplate } from '@intellidev/shared'
import type { AgentEvent, HarnessId, RunStatus, StageRecord, TaskStatus } from '@intellidev/shared'

/**
 * The store contract, shared by the in-memory and Postgres implementations.
 *
 * **Asynchronous, which the in-memory version does not need.** That is deliberate: a
 * synchronous interface is the one shape Postgres cannot satisfy, so keeping it would have
 * meant either a write-through cache — and the stale-read bugs that come with one — or
 * discovering the problem at the call sites later. Every method returns a promise so the
 * two implementations are genuinely interchangeable and one contract suite can prove it.
 *
 * `subscribe` stays synchronous because it registers a listener rather than touching data.
 * It fans out **in process** in both implementations; C6 replaces that with Postgres
 * `LISTEN`/`NOTIFY`, which is what allows a second control-plane instance.
 */

/**
 * Which project a piece of work belongs to, and the tenancy above it.
 *
 * Passed in rather than fixed on the store, because a hosted control plane serves many
 * projects from one process: the scope belongs to a request, not to a connection. Until login
 * lands it is resolved once at boot from configuration, which is the same shape with one value.
 *
 * `workspaceId` is here because `public.tasks.workspace_id` is NOT NULL. It is derivable from
 * the project, but deriving it per insert would cost a round trip on the write path for a value
 * that cannot change while a project exists.
 */
export interface ProjectScope {
  readonly projectId: string
  readonly clientSpaceId: string
  readonly workspaceId: string
}

/**
 * A repository a project is allowed to act on.
 *
 * The allowlist exists because the GitHub App is installed at *space* level and may cover an
 * entire organisation. Without it, any project in a space could dispatch a run against any
 * repository in that org — the broker checks that a run's requested host matches its task, but
 * nothing constrained which repositories a project is entitled to.
 */
/**
 * A saved set of stages, at one of two scopes.
 *
 * `projectId` absent means the client space's own — shared by every project in it. Present means
 * a project's, which overrides the space's. Mirrors how integrations are scoped, because it is
 * the same question: is this shared by the space, or does this project do it differently.
 */
export interface StageTemplateRow {
  id: string
  clientSpaceId: string
  /** Absent for a space-level template. */
  projectId?: string
  name: string
  description?: string
  /**
   * The stages, in order.
   *
   * Typed as the shared `StageTemplate['stages']` rather than `unknown[]`, so a row that would
   * not run cannot be written — the parse happens at the edge and everything downstream can
   * rely on it.
   */
  stages: StageTemplate['stages']
  /** What a new task in this scope picks up without anyone choosing. */
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A template on the way in.
 *
 * `id` optional because the same call creates and replaces: a UI editing a template has one, a
 * UI creating one does not, and two methods for that would differ only in whether the caller
 * remembered which case they were in.
 *
 * Written as its own type rather than `Omit<…> & { id?: string }`, which does not do what it
 * looks like — the Omit still requires `id`, and the intersection cannot take it back.
 */
/**
 * What a stage drew, kept for the stages after it and for the person reviewing.
 *
 * `kind` is a closed set rather than a content type: the preview renders exactly three things,
 * and a content-type string admits a hundred values meaning the same thing and several meaning
 * "execute this".
 */
export type ArtifactKind = 'html' | 'markdown' | 'mermaid'

export interface TaskArtifactRow {
  id: string
  clientSpaceId: string
  projectId: string
  taskId: string
  /** The run and stage that wrote it. Absent once the run is pruned, or if a person added it. */
  runId?: string
  stage?: string
  /** How a later stage refers to it, and what makes a re-render an overwrite. */
  name: string
  kind: ArtifactKind
  title?: string
  body: string
  bytes: number
  createdAt: string
  updatedAt: string
}

/**
 * A row without its body.
 *
 * Lists are read far more often than bodies, and a project with a hundred artifacts would
 * otherwise send a megabyte of markdown to render a sidebar.
 */
export type TaskArtifactSummary = Omit<TaskArtifactRow, 'body'>

export type TaskArtifactInput = Omit<
  TaskArtifactRow,
  'id' | 'createdAt' | 'updatedAt' | 'bytes' | 'clientSpaceId' | 'projectId'
>

export type StageTemplateInput = Omit<StageTemplateRow, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
}

export interface ProjectRepoRow {
  id: string
  projectId: string
  clientSpaceId: string
  owner: string
  repo: string
  /** The GitHub installation this repository is reached through. */
  installationRef: string
  defaultBranch?: string
}

export interface TaskRow {
  id: string
  /** The project this task belongs to. Never absent for a runnable task. */
  projectId: string
  clientSpaceId: string
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
  /**
   * A saved template this task follows, if it chose one.
   *
   * Following means later edits to that template apply. A task that wanted the stages frozen
   * carries `stages` instead.
   */
  stageTemplateId?: string
  /**
   * Stages pinned to this task, overriding every template.
   *
   * Typed loosely because it is validated at dispatch, not here: an array read from JSONB has
   * whatever shape the writer gave it, and pretending otherwise in the row type would move the
   * lie rather than remove it.
   */
  stages?: unknown[]
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
  /**
   * Runtime handle: container name locally, task ARN on Fargate.
   *
   * The *current* container, so it is cleared when that container is gone. `null` in a patch
   * clears it; `undefined` leaves it alone, like every other field here.
   */
  handle?: string | null
  /**
   * The stage engine's state, as the container last wrote it.
   *
   * Opaque here on purpose: its shape belongs to the adapter, and the control plane's business
   * with it is to store it, hand it back, and — when someone approves — record a decision inside
   * it. Typing it here would put the engine's internals in two packages.
   */
  engineState?: Record<string, unknown>
}

export type Listener = (event: AgentEvent) => void

/**
 * Raised when a task names a repository its project is not allowed to touch.
 *
 * A distinct type because it is a 4xx and not a fault: the GitHub App is installed at space
 * level and may cover an entire organisation, so "this repo exists and we can reach it" is not
 * the same question as "this project may act on it". The answer has to be a refusal the UI can
 * render, not a 500.
 */
export class RepoNotAllowed extends Error {
  constructor(
    readonly repoUrl: string,
    readonly projectId: string,
  ) {
    super(
      `this project is not allowed to act on ${repoUrl}. Add it to the project's ` +
        `repositories first.`,
    )
  }
}

export interface Store {
  /**
   * Adds a repository to a project's allowlist, or returns the existing row.
   *
   * Idempotent because connecting a repository is a UI action a person may repeat, and the
   * second click should not be an error.
   */
  addProjectRepo(
    scope: ProjectScope,
    input: { owner: string; repo: string; installationRef: string; defaultBranch?: string },
  ): Promise<ProjectRepoRow>
  listProjectRepos(scope: ProjectScope): Promise<ProjectRepoRow[]>

  /**
   * Both scopes at once: the space's templates and this project's.
   *
   * One query rather than two, because every caller wants both — the UI lists what a project
   * could use, and resolution needs to see a project override sitting next to the space default
   * it replaces.
   */
  listStageTemplates(scope: ProjectScope): Promise<StageTemplateRow[]>
  getStageTemplate(id: string): Promise<StageTemplateRow | undefined>
  /**
   * Creates or replaces one, by id.
   *
   * Marking a template default clears the flag on its siblings in the same scope. Done inside
   * the write rather than left to a caller: the database refuses two defaults per scope, so a
   * caller that forgot would get a constraint error instead of the obvious behaviour.
   */
  saveStageTemplate(input: StageTemplateInput): Promise<StageTemplateRow>
  deleteStageTemplate(id: string): Promise<boolean>

  /**
   * Artifacts a task's stages produced.
   *
   * Summaries, not bodies: this feeds a list, and one artifact may be most of a megabyte.
   */
  listTaskArtifacts(taskId: string): Promise<TaskArtifactSummary[]>
  /**
   * The project's artifacts, newest first.
   *
   * The other half of what was asked for: attached to a task, but visible for the project — you
   * read one task's diagram while reviewing it, and the project's when you want to know what has
   * already been decided.
   */
  listProjectArtifacts(scope: ProjectScope, limit?: number): Promise<TaskArtifactSummary[]>
  /** With the body, for a preview or for a later stage to read. */
  getTaskArtifact(id: string): Promise<TaskArtifactRow | undefined>
  /** By the name a stage refers to it by, within one task. */
  findTaskArtifact(taskId: string, name: string): Promise<TaskArtifactRow | undefined>
  /**
   * Write one, replacing any artifact of the same name on the same task.
   *
   * An overwrite rather than a second row, because a stage that re-renders its diagram means to
   * replace it — and two rows with one name leave nothing to say which is current.
   */
  saveTaskArtifact(scope: ProjectScope, input: TaskArtifactInput): Promise<TaskArtifactRow>
  deleteTaskArtifact(id: string): Promise<boolean>
  /**
   * Removes a repository from a project's allowlist.
   *
   * Exists mainly so tests can undo themselves: they run against the same shared database the
   * product team uses, and an allowlist entry is not cleared by `truncateAll` — which deletes
   * tasks. A test that leaves rows behind shows up later as a repository nobody added.
   */
  removeProjectRepo(scope: ProjectScope, owner: string, repo: string): Promise<boolean>

  /**
   * Creates a task and its runner spec.
   *
   * `repoUrl` stays in the input even though the row stores a repository *id*: callers know a
   * URL, and resolving it here is what enforces the project's allowlist at the only point
   * where it matters. An unlisted repository raises `RepoNotAllowed`.
   */
  createTask(
    input: Omit<TaskRow, 'id' | 'status' | 'createdAt' | 'projectId' | 'clientSpaceId'>,
    scope: ProjectScope,
  ): Promise<TaskRow>
  /** Tasks in one project. Scoped because a hosted instance serves many. */
  listTasks(scope: ProjectScope): Promise<TaskRow[]>
  getTask(id: string): Promise<TaskRow | undefined>
  setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow>
  /**
   * Pin stages to one task, or `null` to go back to following its template.
   *
   * Copy on write: until this is called a task follows whatever resolution finds, so a fix to
   * the project's stages reaches every task that has not run yet. The first edit makes that task
   * its own — which is what editing one task's stages should mean — and passing `null` undoes
   * it, because an edit with no way back is a trap rather than a feature.
   */
  setTaskStages(taskId: string, stages: unknown[] | null): Promise<void>

  createRun(taskId: string, harness: HarnessId, branch: string): Promise<RunRow>
  getRun(id: string): Promise<RunRow | undefined>
  /**
   * Finds a run by its runtime handle — a container name locally, a task ARN on Fargate.
   *
   * Matching on the handle rather than a tag is deliberate: an ECS task-state-change event
   * does not reliably carry task tags, and the handle is recorded at dispatch precisely so a
   * run can be found from the outside.
   */
  findRunByHandle(handle: string): Promise<RunRow | undefined>
  /**
   * Runs that should have a live task behind them. What the reconciler sweeps.
   *
   * Not just `running`: a task killed while still PROVISIONING leaves its run in
   * `provisioning`, and filtering on `running` alone would make it invisible for ever.
   * `parked` is excluded — non-terminal, but waiting on a human rather than a container.
   */
  listUnsettledRuns(): Promise<RunRow[]>
  listRuns(taskId?: string): Promise<RunRow[]>
  updateRun(id: string, patch: Partial<RunRow>): Promise<RunRow>

  /**
   * Append one event. Returns false only for an **exact duplicate** of a stored seq.
   *
   * Not "older than the newest seen", which is a different thing and was the original bug:
   * if seq 3 is lost while 4 and 5 arrive, refusing 3 on its replay would make that hole
   * permanent. A late event must be able to fill its own gap, because a gapless log is what
   * the sequence numbers exist for. The adapter replays everything unacknowledged on every
   * reconnect, so duplicates are expected traffic and must not become duplicate rows.
   */
  appendEvent(event: AgentEvent): Promise<boolean>
  /**
   * Append a batch, returning how many were new.
   *
   * Exists because of round-trip cost: against a database ~70 ms away, thirteen events
   * written one at a time is most of a second, and a chatty stage would fall behind the run
   * producing it. One statement is one round trip regardless of how many rows it carries.
   */
  appendEvents(events: readonly AgentEvent[]): Promise<number>
  eventsSince(runId: string, since?: number): Promise<AgentEvent[]>

  /**
   * Watches a run, optionally from a point in its history.
   *
   * **Backfill is part of subscribing, not a separate step.** The caller used to read
   * `eventsSince(since)` and then subscribe, which had two defects: an event landing between
   * the read and the registration was missed, and with cross-instance fan-out the
   * subscription re-delivered from the start — producing a stream like 0,1,2,3,4,0,1,2,3,4.
   * One watermark per subscription removes both.
   *
   * `since` is **required and exclusive**: `-1` means the whole log, `5` means everything
   * after seq 5. It is not optional on purpose. An "everything from now on" mode would have
   * to learn the run's current position, and reading that asynchronously is racy in the one
   * direction that matters — the read can return a watermark that already includes the event
   * the subscriber was meant to receive, which is then skipped with nothing to retry it. A
   * caller always knows where it is, so it says.
   *
   * Delivery of the backlog is asynchronous, so events may arrive shortly after this
   * returns — in `seq` order, which is what a timeline needs.
   */
  subscribe(runId: string, listener: Listener, opts: { since: number }): () => void

  /** Releases connections. A no-op in memory. */
  close(): Promise<void>
}
