import {
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The tables this system reads and writes, as `db/migrations` created them.
 *
 * **Definitions, not a source of truth.** The SQL in `db/migrations` is authoritative;
 * `drizzle-kit generate` is not used to author it, because this database is shared and what
 * the schema needs — RLS policies, `SECURITY DEFINER` helpers, `GRANT`/`REVOKE` — cannot be
 * expressed here. See `db/README.md`.
 *
 * Two schemas appear below, and the distinction matters:
 *
 *  - **`runner`** is ours. Everything in it was created by this repo's migrations.
 *  - **`public`** belongs to the product, and another repo owns it. Only the columns this
 *    system actually touches are declared, and only `tasks` is written to at all.
 *
 * `runner.*` is qualified by the schema object, so drizzle always emits `"runner"."x"`.
 * `public.tasks` cannot be: drizzle refuses `pgSchema('public')` outright, so `pgTable` emits a
 * bare `"tasks"` that resolves through `search_path`. For reads and writes of a *named* table
 * that is harmless — it is the table we mean.
 *
 * Where it was not harmless was `truncateAll`, whose `truncate table tasks cascade` therefore
 * aimed at the product's own task table. That statement is now written with an explicit
 * `public.tasks` and narrowed to tasks holding a runner spec, and
 * `PostgresStore destructive safety` in the contract suite is what keeps it that way — it caught
 * this exact regression on its first run.
 */

export const runner = pgSchema('runner')

// --- the product's tables ---------------------------------------------------

/**
 * `public.tasks` — the dispatchable unit, and the product's table.
 *
 * A task is shared ground: the ingest pipeline creates them from observed events, and a person
 * creates them to hand to an agent. Rather than keeping a parallel task table, the runner adds
 * its own fields in `runner.task_specs` and treats a task as runnable exactly when a spec row
 * exists.
 *
 * Only the columns used here are declared. The real table has twenty-seven, including an
 * embedding and a dedupe hash that belong to the generator — declaring them would invite this
 * code to write things it has no business writing.
 */
export const productTasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    clientSpaceId: uuid('client_space_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    /**
     * Nullable on their table: an observation can belong to a whole space.
     *
     * A runnable task always has one, because a run needs a project to resolve its repository,
     * harness seat and MCP servers from. Enforced where tasks are created rather than by a
     * constraint, since their table must keep allowing space-level rows.
     */
    projectId: uuid('project_id'),
    title: text('title').notNull(),
    description: text('description'),
    /**
     * The product's five-value enum, as text.
     *
     * Text rather than a drizzle enum because this column's type is theirs to change, and a
     * mirrored enum here would be a second declaration of it that can silently disagree.
     * `runner.product_status()` is what maps the runner's eight states onto these five.
     */
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tasks_project_id_idx').on(table.projectId)],
)

// --- ours -------------------------------------------------------------------

/**
 * Which repositories a project may target.
 *
 * A task names a row here rather than a URL. The GitHub App is installed at space level and
 * can cover an entire organisation, so without this any project in the space could dispatch
 * against any repository in it — and a foreign key makes an unauthorised one unrecordable
 * rather than merely rejected.
 */
export const projectRepos = runner.table('project_repos', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientSpaceId: uuid('client_space_id').notNull(),
  projectId: uuid('project_id').notNull(),
  installationRef: text('installation_ref').notNull(),
  owner: text('owner').notNull(),
  repo: text('repo').notNull(),
  defaultBranch: text('default_branch'),
  addedBy: uuid('added_by'),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The runner's fields on a product task. One row per runnable task.
 *
 * Separate from `public.tasks` rather than six nullable columns on it: those columns would be
 * null for every ingest-generated row, and "is this runnable?" would become a six-way null
 * check instead of the existence of a row.
 */
export const taskSpecs = runner.table('task_specs', {
  taskId: uuid('task_id').primaryKey(),
  repoId: uuid('repo_id').notNull(),
  baseBranch: text('base_branch').notNull(),
  harness: text('harness').notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>().notNull(),
  details: text('details'),
  /**
   * Which connected servers this task uses, by id.
   *
   * Ids, not inline config: a server is connected once per project and reused, so a task holds
   * a reference and never a credential.
   */
  mcpServerIds: jsonb('mcp_server_ids').$type<string[]>().notNull(),
  /**
   * The runner's own status, in its own eight-value vocabulary.
   *
   * Stored because the mapping onto the product's five is not reversible — dispatched,
   * running, waiting_capacity and in_review all read as `in_progress` there. Their enum is not
   * extended, because every index on `public.tasks` is partial on
   * `status IN ('pending','in_progress')` and a new value would drop agent tasks off their
   * board and out of the dedupe constraint.
   */
  runnerStatus: text('runner_status').notNull().default('not_started'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const runs = runner.table(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id').notNull(),
    clientSpaceId: uuid('client_space_id').notNull(),
    projectId: uuid('project_id').notNull(),
    status: text('status').notNull(),
    harness: text('harness').notNull(),
    branch: text('branch').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /**
     * Highest sequence number stored for this run.
     *
     * The gate that makes `appendEvent` idempotent under replay. `-1` rather than `0`, because
     * seq 0 is a real event and `0 <= 0` would reject the first one.
     */
    seqHwm: integer('seq_hwm').notNull().default(-1),
    records: jsonb('records').$type<unknown[]>().notNull().default([]),
    prUrl: text('pr_url'),
    failureReason: text('failure_reason'),
    /** Container name locally, task ARN on Fargate. */
    handle: text('handle'),
    /**
     * The stage engine's own state, written by the container on every transition.
     *
     * Here rather than in the container because a run that parks for approval is *destroyed*
     * while it waits. This is what the next container loads to continue at the stage after the
     * one somebody approved.
     */
    engineState: jsonb('engine_state').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('runs_task_idx').on(table.taskId),
    index('runs_project_idx').on(table.projectId),
    // The reconciler looks a run up by this on every ECS task-state-change event.
    index('runs_handle_idx').on(table.handle),
    // And its sweep filters on exactly this.
    index('runs_status_idx').on(table.status),
  ],
)

export const runEvents = runner.table(
  'run_events',
  {
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    type: text('type').notNull(),
    stage: text('stage'),
    /** The whole canonical event, so the log replays without reconstructing it. */
    body: jsonb('body').$type<unknown>().notNull(),
    /**
     * Insertion order, independent of `seq`.
     *
     * A replay after a reconnect inserts older seqs after newer ones, so "what arrived when"
     * cannot be answered from `seq`.
     */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // (run, seq) is the natural key, and making it the primary key is what lets
    // `ON CONFLICT DO NOTHING` absorb a replay without reading first.
    primaryKey({ columns: [table.runId, table.seq] }),
  ],
)

/**
 * Connected integrations: MCP servers, skills, the harness seat, the GitHub installation.
 *
 * `projectId` null means the row serves every project in the space, which is how a harness seat
 * and a GitHub installation are shared. A database CHECK ties which scope is legal to `kind`.
 */
export const integrations = runner.table('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientSpaceId: uuid('client_space_id').notNull(),
  projectId: uuid('project_id'),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  displayName: text('display_name').notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('connected'),
  connectedBy: uuid('connected_by'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Envelope-encrypted credential material, one row per integration that has any.
 *
 * Read only by the credential broker, over a service-role connection. The table has RLS on and
 * no policies at all, so no user's JWT can reach it under any circumstances.
 */
export const credentials = runner.table('credentials', {
  integrationId: uuid('integration_id').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  wrappedKey: text('wrapped_key').notNull(),
  keyArn: text('key_arn').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshAfter: timestamp('refresh_after', { withTimezone: true }),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A run's own bearer token, stored as a fingerprint.
 *
 * Durable rather than in memory because a token minted by one control-plane process must be
 * verifiable by another: behind a load balancer, an in-process registry fails roughly half of
 * a container's broker calls. Only the sha256 is kept, so a database dump yields no working
 * tokens.
 */
export const runTokens = runner.table('run_tokens', {
  fingerprint: text('fingerprint').primaryKey(),
  runId: uuid('run_id').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const schema = {
  productTasks,
  projectRepos,
  taskSpecs,
  runs,
  runEvents,
  integrations,
  credentials,
  runTokens,
}
export type Schema = typeof schema
