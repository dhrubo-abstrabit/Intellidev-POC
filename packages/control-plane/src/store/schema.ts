import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The tables B1 needs, shaped to match `docs/architecture.md §10`.
 *
 * **Three tables, not sixteen.** §10 lists the whole model, and writing all of it now would
 * mean a dozen tables no code reads — schema that cannot be wrong because nothing depends
 * on it, and that will need changing anyway once seats and approvals are built. These three
 * are the ones the store actually serves; the rest arrive with the features that need them
 * (`seats` and `seat_windows` in D2, `credentials` in B2, `projects` and `manifests` in
 * multi-project).
 *
 * Stage records stay a JSONB column on the run rather than a `run_stages` table, which is
 * how the in-memory store already shapes them. Splitting them out is a change worth making
 * when something queries across stages — a gate-pass-rate report — and not before.
 */

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    details: text('details'),
    // JSONB rather than text[]: it round-trips through the same codec as every other
    // structured column, so one mapping function covers the whole row.
    acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
    harness: text('harness').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    repoUrl: text('repo_url').notNull(),
    baseBranch: text('base_branch').notNull(),
    mcpServerIds: jsonb('mcp_server_ids').$type<string[]>().notNull(),
  },
  (table) => [index('tasks_status_idx').on(table.status)],
)

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    harness: text('harness').notNull(),
    branch: text('branch').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /**
     * Highest sequence number stored for this run.
     *
     * The gate that makes `appendEvent` idempotent under replay. `-1` rather than `0`,
     * because seq 0 is a real event and `0 <= 0` would reject the first one.
     */
    seqHwm: integer('seq_hwm').notNull().default(-1),
    records: jsonb('records').$type<unknown[]>().notNull().default([]),
    prUrl: text('pr_url'),
    failureReason: text('failure_reason'),
    /**
     * Container name locally, task ARN on Fargate.
     *
     * Indexed because C5's reconciler looks runs up by it on every task-state-change event,
     * and a sequential scan over every run ever would get slower for ever.
     */
    handle: text('handle'),
  },
  (table) => [
    index('runs_task_id_idx').on(table.taskId),
    index('runs_handle_idx').on(table.handle),
    // The reconciler's sweep filters on exactly this.
    index('runs_status_idx').on(table.status),
  ],
)

export const runEvents = pgTable(
  'run_events',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    stage: text('stage'),
    /** The whole canonical event, so the log is replayable without reconstructing it. */
    body: jsonb('body').$type<unknown>().notNull(),
    /**
     * Insertion order, independent of `seq`.
     *
     * Needed because a replay after a reconnect inserts older seqs after newer ones, and a
     * report on "what arrived when" cannot use `seq` for that.
     */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // (run, seq) is the natural key, and the composite primary key is what makes
    // `ON CONFLICT DO NOTHING` able to absorb a replay without a read first.
    primaryKey({ columns: [table.runId, table.seq] }),
    // SSE backfills with `seq > since` for one run, which this serves directly.
    index('run_events_run_seq_idx').on(table.runId, table.seq),
  ],
)

/**
 * A placeholder for the retention decision B1 surfaced.
 *
 * `run_events` grows 0.25–2.5 GB/month at 500 runs and never stops; Supabase Pro includes
 * 8 GB. Nothing prunes it yet, and pretending otherwise would be worse than saying so:
 * this is a real open item, tracked in `docs/aws-ecs-plan.md` under B1.
 */
export const RETENTION_IS_UNIMPLEMENTED = true

export const schema = { tasks, runs, runEvents }
export type Schema = typeof schema
