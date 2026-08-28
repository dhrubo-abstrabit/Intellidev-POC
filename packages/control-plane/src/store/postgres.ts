import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import {
  canTransitionTask,
  AgentEvent,
  type HarnessId,
  type RunStatus,
  type StageRecord,
  type TaskStatus,
} from '@intellidev/shared'
import { DeliveryCursor } from './delivery.js'
import {
  RepoNotAllowed,
  type Listener,
  type ProjectRepoRow,
  type ProjectScope,
  type RunRow,
  type Store,
  type TaskRow,
} from './types.js'
import { productTasks, projectRepos, runEvents, runTokens, runs, taskSpecs } from './schema.js'
import { NotifyListener, RUN_EVENTS_CHANNEL, type NotifyClient } from './notify.js'
import { PostgresSeatStore } from '../harness/postgres-seats.js'
import { PostgresMcpStore } from '../mcp/postgres-mcp.js'
import { ProjectAccessChecker } from '../auth/access.js'
import type { SecretCipher } from '../secrets/cipher.js'

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
 * Postgres-backed store.
 *
 * **Session-mode pooler, not transaction mode**, and that is measured rather than assumed:
 * with a long-lived listener on one connection and a notifier on another — the actual C6
 * shape — session mode delivered 3/3 notifications and transaction mode delivered 0/3.
 * Both measure the same round-trip time, so there is nothing to trade away. A weaker probe
 * that listened and notified on one connection reported transaction mode as working, which
 * is exactly how this ships unnoticed and later presents as "the run looks stalled".
 *
 * The other thing shaping this file is distance. The database is ~85 ms away, so the cost
 * of a method is dominated by how many round trips it makes, not by how much SQL it runs.
 * That is why `appendEvents` exists and why nothing here reads before it writes.
 */

export interface PostgresStoreOptions {
  readonly connectionString: string
  /**
   * Connections this store may hold. Small on purpose.
   *
   * Supabase's session-mode pooler allows **15 clients per project**, and that is the whole
   * budget: every control-plane instance spends from it, plus one more each for the
   * `LISTEN`/`NOTIFY` connection cross-instance fan-out needs.
   *
   * The default was 10, which one instance plus its listener turns into 11 of 15 — leaving no
   * room for a second instance, a migration, or a psql session. It surfaced as
   * `(EMAXCONNSESSION) max clients reached in session mode` from the test suite while a server
   * was running, which reads like a code fault and is not one.
   *
   * Five leaves room for two instances (12 with listeners) and a person with a shell. Raise the
   * pooler's limit in the Supabase dashboard before raising this.
   */
  readonly maxConnections?: number
  readonly onDiagnostic?: (message: string) => void
  /**
   * Turns on cross-instance fan-out.
   *
   * Off by default so a single instance — and every test — behaves exactly as before,
   * without opening a second connection nothing needs. `main` enables it.
   */
  readonly crossInstanceFanOut?: boolean
  /** Injected in tests, so the listener can be driven without a database. */
  readonly createNotifyClient?: (connectionString: string) => NotifyClient
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool
  private readonly db: NodePgDatabase
  /**
   * One record per subscription, each with its own watermark.
   *
   * The watermark is what makes cross-instance delivery duplicate-free without an instance
   * id in the payload: whoever delivered an event advances past it, so a notification for
   * work already delivered finds nothing. Per *subscription* rather than per run, because a
   * shared watermark let the first subscriber starve the second of its backlog — and, with
   * SSE backfilling separately, produced a stream of 0,1,2,3,4,0,1,2,3,4.
   */
  private readonly subscriptions = new Map<string, Set<Subscription>>()
  private notify: NotifyListener | undefined

  constructor(private readonly opts: PostgresStoreOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 5,
      // Supabase terminates TLS with a certificate chain node does not ship a root for.
      // The connection is still encrypted; what is not verified is the peer's identity,
      // which is a real if small gap and worth naming rather than hiding behind a flag.
      ssl: { rejectUnauthorized: false },
      // A connection that cannot be established in 15 s over an 85 ms link is not slow, it
      // is broken; failing fast beats a request hanging until something else times out.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
    })
    this.pool.on('error', (error) => {
      // A pool error on an idle client must not become an unhandled rejection that takes
      // the control plane down; the next acquisition will make a fresh connection.
      opts.onDiagnostic?.(`postgres pool error: ${error.message}`)
    })
    this.db = drizzle(this.pool)

    if (opts.crossInstanceFanOut) {
      this.notify = new NotifyListener({
        connectionString: opts.connectionString,
        onRunChanged: (runId) => {
          // `.catch`, not `void`: a rejected drain would be an unhandled rejection, and
          // Node ends the process on those.
          this.drain(runId).catch((error: unknown) => {
            opts.onDiagnostic?.(`fan-out drain failed for ${runId}: ${String(error)}`)
          })
        },
        // Everything that happened while the connection was down was never delivered, and
        // only a re-read closes that gap.
        onReconnected: () => {
          for (const runId of this.subscriptions.keys()) {
            this.drain(runId).catch((error: unknown) => {
              opts.onDiagnostic?.(`fan-out drain failed for ${runId}: ${String(error)}`)
            })
          }
        },
        ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
        ...(opts.createNotifyClient ? { createClient: opts.createNotifyClient } : {}),
      })
    }
  }

  /** Starts the listener, if cross-instance fan-out was asked for. */
  async start(): Promise<void> {
    await this.notify?.start()
  }

  /**
   * Delivers whatever a run has that local listeners have not seen.
   *
   * Reads rather than trusting a payload, which is what makes a lost notification
   * recoverable: it asks for everything after what it has delivered, not for one event.
   */
  private async drain(runId: string): Promise<void> {
    const set = this.subscriptions.get(runId)
    if (!set || set.size === 0) return

    // One query for every subscriber, from the furthest-behind watermark, then filtered per
    // subscription. Querying per subscriber would multiply round trips on a link where a
    // round trip is the dominant cost.
    // The furthest-behind *gapless* point across subscribers. Using each cursor's resume
    // point rather than its highest delivered seq is what lets a straggler still be fetched:
    // a subscriber holding 5,6,7 with 4 missing resumes from 3, so 4 is in this read.
    const lowest = Math.min(...[...set].map((s) => s.cursor.resumeFrom))
    let fresh: AgentEvent[]
    try {
      fresh = await this.eventsSince(runId, lowest)
    } catch (error) {
      // A failed read must not kill the listener: the next notification retries, and a
      // reconnect drains from the same watermarks.
      this.opts.onDiagnostic?.(`fan-out read failed for ${runId}: ${String(error)}`)
      return
    }
    if (fresh.length === 0) return

    for (const subscription of set) {
      for (const event of fresh) {
        if (!subscription.cursor.record(event.seq)) continue
        subscription.listener(event)
      }
    }
  }

  /** Delivers what is already in hand, without a read. Used on the write path. */
  private deliverLocally(runId: string, events: readonly AgentEvent[]): void {
    for (const subscription of this.subscriptions.get(runId) ?? []) {
      for (const event of events) {
        // record() is the gate: it returns false only for a genuine duplicate, so an
        // out-of-order straggler is delivered instead of being swallowed by a watermark.
        if (!subscription.cursor.record(event.seq)) continue
        subscription.listener(event)
      }
    }
  }

  /**
   * A seat store sharing this connection pool.
   *
   * A factory rather than exposing `db`, for the same reason run tokens live on this class:
   * Supavisor has a connection ceiling that the event stream also spends from, and a second
   * pool for a handful of small queries competes with the thing that matters. The cipher is a
   * parameter because which one is right depends on the deployment, not on the store.
   */
  seats(cipher: SecretCipher): PostgresSeatStore {
    return new PostgresSeatStore(this.db, cipher)
  }

  /**
   * Looks a user up by email.
   *
   * Only used by tests and operator scripts — the request path takes the user's id from a
   * verified token and never from an address, because an email is something a caller can claim
   * and a signature is not.
   */
  async findUserByEmail(email: string): Promise<{ id: string } | undefined> {
    const [row] = await this.db
      .select({ id: sql<string>`u.id` })
      .from(sql`public.users u`)
      .where(sql`lower(u.email::text) = lower(${email})`)
      .limit(1)
    return row
  }

  /**
   * The project-access checker, sharing this pool.
   *
   * It asks the product's own `current_project_ids()` and `manageable_project_ids()` with the
   * caller's claims installed, so authorization stays one definition rather than two.
   */
  projectAccess(): ProjectAccessChecker {
    return new ProjectAccessChecker(this.db)
  }

  /** An MCP store sharing this connection pool, for the same reason `seats` does. */
  mcp(cipher: SecretCipher): PostgresMcpStore {
    return new PostgresMcpStore(this.db, cipher)
  }

  // --- run tokens -----------------------------------------------------------
  //
  // Implemented here rather than in a store of its own so it shares this pool. Supavisor has a
  // connection ceiling, and a second pool for four small queries would spend from the same
  // budget the event stream needs.
  //
  // Structurally satisfies `RunTokenStore`, which is what lets `RunTokenRegistry` take either
  // this or the in-memory one without either knowing about the other.

  async putRunToken(fingerprint: string, runId: string, expiresAt: number): Promise<void> {
    await this.db
      .insert(runTokens)
      .values({ fingerprint, runId, expiresAt: new Date(expiresAt) })
      // A retried dispatch mints again for the same run; the fingerprint differs, so this
      // conflict only fires on the vanishingly unlikely repeat of 32 random bytes. Handled
      // anyway, because an insert that can throw on a dispatch path is worth not having.
      .onConflictDoUpdate({
        target: runTokens.fingerprint,
        set: { runId, expiresAt: new Date(expiresAt), revokedAt: null },
      })
  }

  async getRunToken(
    fingerprint: string,
  ): Promise<{ runId: string; expiresAt: number } | undefined> {
    const [row] = await this.db
      .select()
      .from(runTokens)
      .where(and(eq(runTokens.fingerprint, fingerprint), isNull(runTokens.revokedAt)))
      .limit(1)
    // Expiry is left to the caller so both stores answer the same question: this returns what
    // is stored, and the registry decides whether it is still good.
    return row ? { runId: row.runId, expiresAt: row.expiresAt.getTime() } : undefined
  }

  /**
   * Revokes by run, marking rather than deleting.
   *
   * A soft revoke keeps the row, so "which run held this token, and when was it killed" stays
   * answerable after the fact — the audit question you only have when something has gone wrong.
   * The fingerprint is all that is stored, so a kept row is not a kept credential.
   */
  async revokeRunTokens(runId: string): Promise<void> {
    await this.db
      .update(runTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(runTokens.runId, runId), isNull(runTokens.revokedAt)))
  }

  async pruneRunTokens(now: number): Promise<number> {
    const rows = await this.db
      .delete(runTokens)
      .where(lt(runTokens.expiresAt, new Date(now)))
      .returning({ fingerprint: runTokens.fingerprint })
    return rows.length
  }

  // --- projects -------------------------------------------------------------

  /**
   * Resolves a project to the tenancy above it.
   *
   * Not on the `Store` interface: it reads the product's tables, which the in-memory store has
   * no equivalent of, and it is needed once at boot rather than on any request path. Putting it
   * on the interface would force a meaningless implementation in memory.
   */
  async findProject(projectId: string): Promise<ProjectScope | undefined> {
    const [row] = await this.db
      .select({
        projectId: sql<string>`p.id`,
        clientSpaceId: sql<string>`p.client_space_id`,
        workspaceId: sql<string>`p.workspace_id`,
      })
      .from(sql`public.projects p`)
      .where(sql`p.id = ${projectId}`)
      .limit(1)
    return row
  }

  // --- project repositories ------------------------------------------------

  async addProjectRepo(
    scope: ProjectScope,
    input: { owner: string; repo: string; installationRef: string; defaultBranch?: string },
  ): Promise<ProjectRepoRow> {
    const [row] = await this.db
      .insert(projectRepos)
      .values({
        clientSpaceId: scope.clientSpaceId,
        projectId: scope.projectId,
        owner: input.owner,
        repo: input.repo,
        installationRef: input.installationRef,
        defaultBranch: input.defaultBranch ?? null,
      })
      // Idempotent on the natural key, so a repeated UI action is not an error. `DO UPDATE`
      // rather than `DO NOTHING` because the row has to come back either way, and
      // `DO NOTHING` returns nothing when it conflicts.
      .onConflictDoUpdate({
        target: [projectRepos.projectId, projectRepos.owner, projectRepos.repo],
        // The default branch too, not just the installation. Re-adding a repository is how a
        // person fixes a stale entry, and leaving the branch untouched meant a row seeded
        // before the App could be asked kept a null default for ever.
        set: {
          installationRef: input.installationRef,
          defaultBranch: input.defaultBranch ?? null,
        },
      })
      .returning()
    return toProjectRepo(row!)
  }

  async listProjectRepos(scope: ProjectScope): Promise<ProjectRepoRow[]> {
    const rows = await this.db
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, scope.projectId))
      .orderBy(asc(projectRepos.owner), asc(projectRepos.repo))
    return rows.map(toProjectRepo)
  }

  async removeProjectRepo(scope: ProjectScope, owner: string, repo: string): Promise<boolean> {
    const rows = await this.db
      .delete(projectRepos)
      .where(
        and(
          eq(projectRepos.projectId, scope.projectId),
          eq(projectRepos.owner, owner),
          eq(projectRepos.repo, repo),
        ),
      )
      .returning({ id: projectRepos.id })
    return rows.length > 0
  }

  // --- tasks ---------------------------------------------------------------

  /**
   * Creates a task and the spec that makes it runnable, in one transaction.
   *
   * Two tables, because `public.tasks` is the product's and shared with an ingest pipeline: the
   * runner's fields live beside it in `runner.task_specs`, and a task is runnable exactly when
   * a spec row exists. One transaction, because a task with no spec is invisible to this system
   * while still appearing on the product's board — a half-created row nobody owns.
   *
   * The repository is resolved to a row in `runner.project_repos` rather than stored as a URL.
   * That is the project's allowlist, and this is the only place it can be enforced: the GitHub
   * App is installed at space level and may cover an entire organisation, so being *able* to
   * reach a repository says nothing about whether this project may act on it.
   */
  async createTask(
    input: Omit<TaskRow, 'id' | 'status' | 'createdAt' | 'projectId' | 'clientSpaceId'>,
    scope: ProjectScope,
  ): Promise<TaskRow> {
    const target = parseRepoUrl(input.repoUrl)
    if (!target) throw new RepoNotAllowed(input.repoUrl, scope.projectId)

    return await this.db.transaction(async (tx) => {
      const [allowed] = await tx
        .select()
        .from(projectRepos)
        .where(
          and(
            eq(projectRepos.projectId, scope.projectId),
            eq(projectRepos.owner, target.owner),
            eq(projectRepos.repo, target.repo),
          ),
        )
        .limit(1)
      if (!allowed) throw new RepoNotAllowed(input.repoUrl, scope.projectId)

      // Generated here rather than by the column default, because the same id is needed for
      // the spec insert and reading it back would cost another round trip.
      const id = randomUUID()

      await tx.insert(productTasks).values({
        id,
        clientSpaceId: scope.clientSpaceId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        title: input.title,
        description: input.description,
        // `confidence`, `for_date` and `dedupe_hash` are NOT NULL on their table and carry
        // defaults added by migration 0001 — a task a person wrote has no meaningful value for
        // any of them.
        status: 'pending',
      })

      await tx.insert(taskSpecs).values({
        taskId: id,
        repoId: allowed.id,
        baseBranch: input.baseBranch,
        harness: input.harness,
        acceptanceCriteria: input.acceptanceCriteria,
        details: input.details ?? null,
        mcpServerIds: input.mcpServerIds,
        runnerStatus: 'not_started',
      })

      const created = await this.readTask(id, tx)
      if (!created) throw new Error(`task ${id} vanished during creation`)
      return created
    })
  }

  async listTasks(scope: ProjectScope): Promise<TaskRow[]> {
    const rows = await this.taskQuery()
      .where(eq(productTasks.projectId, scope.projectId))
      .orderBy(asc(productTasks.createdAt))
    return rows.map(toTask)
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    return await this.readTask(id, this.db)
  }

  /**
   * Moves a task's status, refusing transitions the state machine does not allow.
   *
   * Writes both statuses: the runner's own onto the spec, and the product's coarse projection
   * onto their table. The projection goes through `runner.product_status()` rather than a map in
   * this file, so anything else that advances a runner status collapses it the same way.
   */
  async setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow> {
    const current = await this.getTask(id)
    if (!current) throw new Error(`no such task ${id}`)
    if (current.status !== status && !canTransitionTask(current.status, status)) {
      throw new Error(`cannot move task ${id} from ${current.status} to ${status}`)
    }

    return await this.db.transaction(async (tx) => {
      await tx.update(taskSpecs).set({ runnerStatus: status }).where(eq(taskSpecs.taskId, id))
      await tx
        .update(productTasks)
        .set({ status: sql`runner.product_status(${status})` })
        .where(eq(productTasks.id, id))
      const row = await this.readTask(id, tx)
      if (!row) throw new Error(`no such task ${id}`)
      return row
    })
  }

  /**
   * The join every task read shares.
   *
   * Inner joins on purpose: a `public.tasks` row with no spec is an ingest observation, not
   * agent work, and must not surface here. That is the same predicate as "is this runnable".
   */
  private taskQuery() {
    return this.db
      .select({
        id: productTasks.id,
        projectId: productTasks.projectId,
        clientSpaceId: productTasks.clientSpaceId,
        title: productTasks.title,
        description: productTasks.description,
        createdAt: productTasks.createdAt,
        details: taskSpecs.details,
        acceptanceCriteria: taskSpecs.acceptanceCriteria,
        harness: taskSpecs.harness,
        mcpServerIds: taskSpecs.mcpServerIds,
        baseBranch: taskSpecs.baseBranch,
        runnerStatus: taskSpecs.runnerStatus,
        owner: projectRepos.owner,
        repo: projectRepos.repo,
      })
      .from(productTasks)
      .innerJoin(taskSpecs, eq(taskSpecs.taskId, productTasks.id))
      .innerJoin(projectRepos, eq(projectRepos.id, taskSpecs.repoId))
      .$dynamic()
  }

  /** Reads one task, on this connection or inside a caller's transaction. */
  private async readTask(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: any,
  ): Promise<TaskRow | undefined> {
    const [row] = await executor
      .select({
        id: productTasks.id,
        projectId: productTasks.projectId,
        clientSpaceId: productTasks.clientSpaceId,
        title: productTasks.title,
        description: productTasks.description,
        createdAt: productTasks.createdAt,
        details: taskSpecs.details,
        acceptanceCriteria: taskSpecs.acceptanceCriteria,
        harness: taskSpecs.harness,
        mcpServerIds: taskSpecs.mcpServerIds,
        baseBranch: taskSpecs.baseBranch,
        runnerStatus: taskSpecs.runnerStatus,
        owner: projectRepos.owner,
        repo: projectRepos.repo,
      })
      .from(productTasks)
      .innerJoin(taskSpecs, eq(taskSpecs.taskId, productTasks.id))
      .innerJoin(projectRepos, eq(projectRepos.id, taskSpecs.repoId))
      .where(eq(productTasks.id, id))
      .limit(1)
    return row ? toTask(row) : undefined
  }

  // --- runs ----------------------------------------------------------------

  /**
   * Starts a run, inheriting its tenancy from the task.
   *
   * `client_space_id` and `project_id` are copied onto the run rather than reached through the
   * task at read time, because the RLS policy on `runner.runs` filters on them directly — a
   * policy that had to join two schemas to find a project would be paid on every row of every
   * event query. The composite foreign key onto `projects(id, client_space_id)` is what stops
   * the copy from ever disagreeing with the task it came from.
   */
  async createRun(taskId: string, harness: HarnessId, branch: string): Promise<RunRow> {
    const task = await this.getTask(taskId)
    if (!task) throw new Error(`no such task ${taskId}`)

    const [row] = await this.db
      .insert(runs)
      .values({
        id: randomUUID(),
        taskId,
        clientSpaceId: task.clientSpaceId,
        projectId: task.projectId,
        status: 'queued',
        harness,
        branch,
        startedAt: new Date(),
        // -1, not 0: seq 0 is a real event and `0 <= 0` would reject the first one.
        seqHwm: -1,
        records: [],
      })
      .returning()
    return toRun(row!)
  }

  async getRun(id: string): Promise<RunRow | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1)
    return row ? toRun(row) : undefined
  }

  async findRunByHandle(handle: string): Promise<RunRow | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.handle, handle)).limit(1)
    return row ? toRun(row) : undefined
  }

  async listUnsettledRuns(): Promise<RunRow[]> {
    // `parked` is excluded: non-terminal, but waiting on a human rather than a container.
    const rows = await this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ['queued', 'provisioning', 'running']))
    return rows.map(toRun)
  }

  async listRuns(taskId?: string): Promise<RunRow[]> {
    const query = this.db.select().from(runs).$dynamic()
    const rows = await (taskId ? query.where(eq(runs.taskId, taskId)) : query).orderBy(
      asc(runs.startedAt),
    )
    return rows.map(toRun)
  }

  async updateRun(id: string, patch: Partial<RunRow>): Promise<RunRow> {
    const set: Record<string, unknown> = {}
    if (patch.status !== undefined) set['status'] = patch.status
    if (patch.branch !== undefined) set['branch'] = patch.branch
    if (patch.endedAt !== undefined) set['endedAt'] = new Date(patch.endedAt)
    if (patch.seqHwm !== undefined) set['seqHwm'] = patch.seqHwm
    if (patch.records !== undefined) set['records'] = patch.records
    if (patch.prUrl !== undefined) set['prUrl'] = patch.prUrl
    if (patch.failureReason !== undefined) set['failureReason'] = patch.failureReason
    if (patch.handle !== undefined) set['handle'] = patch.handle

    if (Object.keys(set).length === 0) {
      const existing = await this.getRun(id)
      if (!existing) throw new Error(`no such run ${id}`)
      return existing
    }

    const [row] = await this.db.update(runs).set(set).where(eq(runs.id, id)).returning()
    if (!row) throw new Error(`no such run ${id}`)
    return toRun(row)
  }

  // --- events --------------------------------------------------------------

  async appendEvent(event: AgentEvent): Promise<boolean> {
    return (await this.appendEvents([event])) > 0
  }

  /**
   * Appends a batch in one round trip, absorbing replays.
   *
   * Two properties make this safe under the adapter's reconnect behaviour, which re-sends
   * everything unacknowledged every time:
   *
   *  - `ON CONFLICT DO NOTHING` on `(run_id, seq)` means a duplicate is a no-op rather than
   *    an error or a second row, and it needs no read first.
   *  - `seq_hwm` advances with `GREATEST`, so an out-of-order replay cannot move it
   *    backwards and let an already-stored event be counted as new.
   *
   * Returns how many rows were actually inserted, which is what the caller needs to know:
   * a return of 0 means "already had them", not "failed".
   */
  async appendEvents(events: readonly AgentEvent[]): Promise<number> {
    if (events.length === 0) return 0

    const byRun = new Map<string, AgentEvent[]>()
    for (const event of events) {
      const list = byRun.get(event.runId) ?? []
      list.push(event)
      byRun.set(event.runId, list)
    }

    let inserted = 0
    for (const [runId, batch] of byRun) {
      const rows = await this.db
        .insert(runEvents)
        .values(
          batch.map((event) => ({
            runId: event.runId,
            seq: event.seq,
            ts: new Date(event.ts),
            type: event.type,
            stage: event.stage ?? null,
            body: event,
          })),
        )
        .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
        .returning({ seq: runEvents.seq })

      if (rows.length === 0) continue
      inserted += rows.length

      const highest = Math.max(...rows.map((row) => row.seq))
      await this.db
        .update(runs)
        .set({ seqHwm: sql`greatest(${runs.seqHwm}, ${highest})` })
        .where(eq(runs.id, runId))

      // Fan out only what was genuinely new, so a replay does not re-render in the UI.
      const fresh = new Set(rows.map((row) => row.seq))
      this.deliverLocally(
        runId,
        batch.filter((event) => fresh.has(event.seq)).sort((a, b) => a.seq - b.seq),
      )

      if (this.notify) {
        // The payload is the run id, not the events: NOTIFY caps at 8000 bytes and an event
        // can carry a 2000-character preview. Other instances read the rows themselves.
        // Failing to notify must not fail the write — the events are already durable, and
        // SSE backfills from `seq` on connect, so a missed notification costs latency on
        // another instance rather than correctness.
        try {
          await this.db.execute(sql`select pg_notify(${RUN_EVENTS_CHANNEL}, ${runId})`)
        } catch (error) {
          this.opts.onDiagnostic?.(`pg_notify failed for ${runId}: ${String(error)}`)
        }
      }
    }
    return inserted
  }

  async eventsSince(runId: string, since = -1): Promise<AgentEvent[]> {
    const rows = await this.db
      .select({ body: runEvents.body })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, since)))
      .orderBy(asc(runEvents.seq))
    // Parsed rather than cast: a row written by an older build must fail loudly here, not
    // three stages later as an `undefined`.
    return rows.map((row) => AgentEvent.parse(row.body))
  }

  /**
   * In-process fan-out, exactly as the in-memory store does.
   *
   * C6 replaces this with `LISTEN`/`NOTIFY` — which the session pooler was chosen to
   * support — so a browser attached to one control-plane instance sees events that arrived
   * at another. Until then, running more than one instance means a UI can miss events.
   */
  subscribe(runId: string, listener: Listener, opts: { since: number }): () => void {
    const subscription: Subscription = { listener, cursor: new DeliveryCursor(opts.since) }
    const set = this.subscriptions.get(runId) ?? new Set()
    set.add(subscription)
    this.subscriptions.set(runId, set)

    // Backfill immediately; every later delivery comes from a notification.
    this.drain(runId).catch((error: unknown) => {
      this.opts.onDiagnostic?.(`backfill failed for ${runId}: ${String(error)}`)
    })

    return () => set.delete(subscription)
  }

  /**
   * Empties every table. For tests only.
   *
   * `tasks` cascades to `runs` and `run_events`, so one statement covers all three — which
   * matters because it is also one round trip rather than three against a database ~85 ms
   * away, and this runs before every contract test.
   */
  /**
   * Empties this project's runner tasks, and nothing else.
   *
   * Scoped, after two separate incidents. The first version was
   * `truncate table tasks cascade` against an unqualified name, which resolved to the product's
   * own `public.tasks`. Narrowing it to tasks holding a runner spec fixed that — but left it
   * deleting *every* project's runner tasks, so pointing the tests at their own project changed
   * nothing and a live Fargate run was destroyed mid-flight a second time.
   *
   * Both mistakes had the same shape: a delete whose blast radius was wider than the thing
   * asking for it. Requiring a scope makes the radius impossible to leave unstated.
   */
  async truncateAll(scope: ProjectScope): Promise<void> {
    // Written out rather than built, because the builder emits a bare `"tasks"` — drizzle
    // refuses to let `public` be named as a schema — and a bare name is what made this
    // dangerous in the first place. Guarded by `PostgresStore destructive safety`.
    await this.db.execute(
      sql`delete from public.tasks
           where project_id = ${scope.projectId}
             and id in (select task_id from runner.task_specs)`,
    )
  }

  async close(): Promise<void> {
    await this.notify?.close()
    await this.pool.end()
  }
}

function toProjectRepo(row: typeof projectRepos.$inferSelect): ProjectRepoRow {
  return {
    id: row.id,
    projectId: row.projectId,
    clientSpaceId: row.clientSpaceId,
    owner: row.owner,
    repo: row.repo,
    installationRef: row.installationRef,
    ...(row.defaultBranch ? { defaultBranch: row.defaultBranch } : {}),
  }
}

/**
 * Assembles a `TaskRow` from the join of the product's task, its spec and its repository.
 *
 * `status` comes from the spec, not from `public.tasks.status`: theirs is the five-value
 * projection and cannot be turned back into the runner's eight.
 */
function toTask(row: {
  id: string
  projectId: string | null
  clientSpaceId: string
  title: string
  description: string | null
  createdAt: Date
  details: string | null
  acceptanceCriteria: string[]
  harness: string
  mcpServerIds: string[]
  baseBranch: string
  runnerStatus: string
  owner: string
  repo: string
}): TaskRow {
  return {
    id: row.id,
    // Non-null in practice: a spec row cannot exist without a project, because its repository
    // is project-scoped. Asserted rather than defaulted, so a violation is loud.
    projectId: row.projectId!,
    clientSpaceId: row.clientSpaceId,
    title: row.title,
    description: row.description ?? '',
    ...(row.details ? { details: row.details } : {}),
    acceptanceCriteria: row.acceptanceCriteria,
    harness: row.harness as HarnessId,
    status: row.runnerStatus as TaskStatus,
    createdAt: row.createdAt.toISOString(),
    repoUrl: repoUrlOf(row.owner, row.repo),
    baseBranch: row.baseBranch,
    mcpServerIds: row.mcpServerIds,
  }
}

/**
 * The clone URL for an allowlisted repository.
 *
 * GitHub is assumed, because the credential broker mints GitHub App installation tokens and
 * nothing else can authenticate a run's clone. When a second host appears, `project_repos`
 * grows a column for it and this reads it — the allowlist is already the right place for that
 * to live.
 */
function repoUrlOf(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * `owner` and `repo` from a clone URL, or undefined if it is not one we understand.
 *
 * Accepts the scp-like form (`git@github.com:owner/repo.git`) as well as a URL, because both
 * appear in the wild and a caller pasting the form GitHub offers should not get a refusal that
 * reads like a permissions problem.
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

function toRun(row: typeof runs.$inferSelect): RunRow {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as RunStatus,
    harness: row.harness as HarnessId,
    branch: row.branch,
    startedAt: row.startedAt.toISOString(),
    ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
    seqHwm: row.seqHwm,
    records: row.records as StageRecord[],
    ...(row.prUrl ? { prUrl: row.prUrl } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
  }
}
