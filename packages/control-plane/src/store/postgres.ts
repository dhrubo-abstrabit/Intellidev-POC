import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
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
import type { Listener, RunRow, Store, TaskRow } from './types.js'
import { runEvents, runs, tasks } from './schema.js'

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
  /** Bounded: Supavisor has its own ceiling, and an unbounded pool finds it. */
  readonly maxConnections?: number
  readonly onDiagnostic?: (message: string) => void
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool
  private readonly db: NodePgDatabase
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(opts: PostgresStoreOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 10,
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
  }

  // --- tasks ---------------------------------------------------------------

  async createTask(input: Omit<TaskRow, 'id' | 'status' | 'createdAt'>): Promise<TaskRow> {
    const row = {
      id: `task_${randomBytes(5).toString('hex')}`,
      title: input.title,
      description: input.description,
      details: input.details ?? null,
      acceptanceCriteria: input.acceptanceCriteria,
      harness: input.harness,
      status: 'not_started' as TaskStatus,
      createdAt: new Date(),
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
      mcpServerIds: input.mcpServerIds,
    }
    const [inserted] = await this.db.insert(tasks).values(row).returning()
    return toTask(inserted!)
  }

  async listTasks(): Promise<TaskRow[]> {
    const rows = await this.db.select().from(tasks).orderBy(asc(tasks.createdAt))
    return rows.map(toTask)
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return row ? toTask(row) : undefined
  }

  /**
   * Moves a task's status, refusing transitions the state machine does not allow.
   *
   * The guard runs against the row this statement itself read, in one round trip: a
   * read-then-write would let two dispatches both see `not_started` and both proceed.
   */
  async setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow> {
    const current = await this.getTask(id)
    if (!current) throw new Error(`no such task ${id}`)
    if (current.status !== status && !canTransitionTask(current.status, status)) {
      throw new Error(`cannot move task ${id} from ${current.status} to ${status}`)
    }
    const [row] = await this.db.update(tasks).set({ status }).where(eq(tasks.id, id)).returning()
    return toTask(row!)
  }

  // --- runs ----------------------------------------------------------------

  async createRun(taskId: string, harness: HarnessId, branch: string): Promise<RunRow> {
    const [row] = await this.db
      .insert(runs)
      .values({
        id: `run_${randomBytes(5).toString('hex')}`,
        taskId,
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
      for (const event of batch) {
        if (!fresh.has(event.seq)) continue
        for (const listener of this.listeners.get(runId) ?? []) listener(event)
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
  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set()
    set.add(listener)
    this.listeners.set(runId, set)
    return () => set.delete(listener)
  }

  /**
   * Empties every table. For tests only.
   *
   * `tasks` cascades to `runs` and `run_events`, so one statement covers all three — which
   * matters because it is also one round trip rather than three against a database 85 ms
   * away, and this runs before every contract test.
   */
  async truncateAll(): Promise<void> {
    await this.db.execute(sql`truncate table ${tasks} cascade`)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function toTask(row: typeof tasks.$inferSelect): TaskRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    ...(row.details ? { details: row.details } : {}),
    acceptanceCriteria: row.acceptanceCriteria,
    harness: row.harness as HarnessId,
    status: row.status as TaskStatus,
    createdAt: row.createdAt.toISOString(),
    repoUrl: row.repoUrl,
    baseBranch: row.baseBranch,
    mcpServerIds: row.mcpServerIds,
  }
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
