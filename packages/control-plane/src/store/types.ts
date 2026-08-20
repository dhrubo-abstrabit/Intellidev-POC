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

export type Listener = (event: AgentEvent) => void

export interface Store {
  createTask(input: Omit<TaskRow, 'id' | 'status' | 'createdAt'>): Promise<TaskRow>
  listTasks(): Promise<TaskRow[]>
  getTask(id: string): Promise<TaskRow | undefined>
  setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow>

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
