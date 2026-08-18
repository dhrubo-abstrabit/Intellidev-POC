import { z } from 'zod'
import { HarnessId, RunOutcome, StageId, StageOutcome } from './ids.js'

/**
 * The canonical event vocabulary.
 *
 * This is the contract everything hangs off: the UI feed, the audit trail, crash
 * resume and eval input all read this one stream. Treat changes as breaking.
 *
 * Two shapes exist deliberately:
 *
 *  - `EventBody`  — what a driver or the stage engine emits. No sequence number,
 *                   because only the adapter's event bus may assign one.
 *  - `AgentEvent` — what goes on the wire and into `run_events`. Body plus meta.
 *
 * Payload rule: events are a log, not a transport for blobs. Anything unbounded
 * (file contents, full tool results, command output) is truncated to a preview
 * and the real artefact is stored elsewhere.
 */

export const PREVIEW_MAX_CHARS = 2_000

const Preview = z.string().max(PREVIEW_MAX_CHARS)

export const TokenUsage = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  tokensCacheRead: z.number().int().nonnegative().default(0),
  tokensCacheWrite: z.number().int().nonnegative().default(0),
})
export type TokenUsage = z.infer<typeof TokenUsage>

// ---------------------------------------------------------------------------
// lifecycle & bootstrap
// ---------------------------------------------------------------------------

const runProvisioning = z.object({
  type: z.literal('run.provisioning'),
  data: z.object({ message: z.string().optional() }),
})

const bundleFetched = z.object({
  type: z.literal('bundle.fetched'),
  data: z.object({
    manifestVersion: z.number().int().positive(),
    digest: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
})

const cacheRestored = z.object({
  type: z.literal('cache.restored'),
  data: z.object({
    hit: z.boolean(),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
})

const worktreeReady = z.object({
  type: z.literal('worktree.ready'),
  data: z.object({
    branch: z.string(),
    baseSha: z.string(),
    path: z.string(),
  }),
})

const runStarted = z.object({
  type: z.literal('run.started'),
  data: z.object({
    harness: HarnessId,
    manifestVersion: z.number().int().positive(),
  }),
})

const stageEntered = z.object({
  type: z.literal('stage.entered'),
  data: z.object({ attempt: z.number().int().positive() }),
})

const stageExited = z.object({
  type: z.literal('stage.exited'),
  data: z.object({
    attempt: z.number().int().positive(),
    outcome: StageOutcome,
    durationMs: z.number().int().nonnegative(),
  }),
})

const runFinished = z.object({
  type: z.literal('run.finished'),
  data: z.object({
    outcome: RunOutcome,
    prUrl: z.string().url().optional(),
    reason: z.string().optional(),
  }),
})

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

const thinkingStarted = z.object({
  type: z.literal('thinking.started'),
  data: z.object({}),
})

const assistantDelta = z.object({
  type: z.literal('assistant.delta'),
  data: z.object({ text: z.string() }),
})

const assistantMessage = z.object({
  type: z.literal('assistant.message'),
  data: z.object({ text: Preview, truncated: z.boolean().default(false) }),
})

/** The only point at which queued steering may be injected. */
const turnBoundary = z.object({
  type: z.literal('turn.boundary'),
  data: z.object({ turn: z.number().int().nonnegative() }),
})

// ---------------------------------------------------------------------------
// tools — every call passes through the adapter's MCP gateway
// ---------------------------------------------------------------------------

const toolCall = z.object({
  type: z.literal('tool.call'),
  data: z.object({
    id: z.string(),
    name: z.string(),
    /** Upstream MCP server, absent for harness-native tools. */
    server: z.string().optional(),
    inputPreview: Preview.optional(),
  }),
})

const toolResult = z.object({
  type: z.literal('tool.result'),
  data: z.object({
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative().optional(),
    resultPreview: Preview.optional(),
    truncated: z.boolean().default(false),
  }),
})

/**
 * An attached MCP server finished connecting.
 *
 * Added because nothing in the stream said whether the gateway reached an upstream server at
 * all: a failed *optional* server surfaced only as an `error`, and a working one surfaced
 * only indirectly, when a tool call happened to succeed. That left "are my tools connected?"
 * — the question the UI exists to answer — unanswerable until something went wrong.
 */
const toolServerConnected = z.object({
  type: z.literal('tool.server_connected'),
  data: z.object({
    serverId: z.string(),
    name: z.string(),
    /** Names as the agent sees them, already namespaced by the gateway. */
    tools: z.array(z.string()),
    /** Whether the connection needed a credential, not the credential itself. */
    authenticated: z.boolean().default(false),
  }),
})

/**
 * The harness's own subscription credential was loaded.
 *
 * Its absence is the thing worth seeing: a run with no seat reaches the model layer and reports
 * `Not logged in`, which looks like a platform fault rather than a missing credential. Names
 * and paths only — never a value, which is also why redaction cannot help here.
 */
const seatAuthenticated = z.object({
  type: z.literal('seat.authenticated'),
  data: z.object({
    harness: HarnessId,
    /** Variable NAMES contributed to the harness environment. */
    envVars: z.array(z.string()).default([]),
    /** Credential files written under the run's HOME. */
    files: z.array(z.string()).default([]),
  }),
})

const toolDenied = z.object({
  type: z.literal('tool.denied'),
  data: z.object({
    id: z.string(),
    name: z.string(),
    /** Which rule refused it: stage scope, policy deny-list, or missing attachment. */
    reason: z.enum(['stage_scope', 'policy_deny', 'not_attached', 'budget']),
    detail: z.string().optional(),
  }),
})

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

const fileChanged = z.object({
  type: z.literal('file.changed'),
  data: z.object({
    path: z.string(),
    change: z.enum(['added', 'modified', 'deleted']),
  }),
})

const diffProduced = z.object({
  type: z.literal('diff.produced'),
  data: z.object({
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
})

const commandOutput = z.object({
  type: z.literal('command.output'),
  data: z.object({
    command: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    chunk: Preview,
  }),
})

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const gitBranchCreated = z.object({
  type: z.literal('git.branch_created'),
  data: z.object({ branch: z.string(), from: z.string() }),
})

const gitCommitted = z.object({
  type: z.literal('git.committed'),
  data: z.object({
    sha: z.string(),
    message: Preview,
    filesChanged: z.number().int().nonnegative(),
  }),
})

const gitPushed = z.object({
  type: z.literal('git.pushed'),
  data: z.object({ branch: z.string(), remote: z.string().default('origin') }),
})

const prOpened = z.object({
  type: z.literal('pr.opened'),
  data: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    base: z.string(),
    head: z.string(),
  }),
})

// ---------------------------------------------------------------------------
// control
// ---------------------------------------------------------------------------

const gateEvaluated = z.object({
  type: z.literal('gate.evaluated'),
  data: z.object({
    kind: z.enum(['command', 'predicate', 'human']),
    passed: z.boolean(),
    /**
     * What was checked — the command line, or the predicate expression.
     *
     * Present so a PR body can name the check that ran. Without it the log records
     * that *a* gate passed but not which, and a reviewer cannot tell whether the
     * test suite ran at all.
     */
    label: Preview.optional(),
    detail: Preview.optional(),
    exitCode: z.number().int().optional(),
  }),
})

const gateBlocked = z.object({
  type: z.literal('gate.blocked'),
  data: z.object({
    reason: z.string(),
    attemptsUsed: z.number().int().nonnegative(),
    attemptsAllowed: z.number().int().nonnegative(),
    /** Where the machine goes next — absent means the run fails here. */
    nextStage: StageId.optional(),
  }),
})

const approvalRequested = z.object({
  type: z.literal('approval.requested'),
  data: z.object({
    approvalId: z.string(),
    action: z.string(),
    detail: Preview.optional(),
  }),
})

/** Emitted the moment a steer arrives, so the UI can show it as pending. */
const steerReceived = z.object({
  type: z.literal('steer.received'),
  data: z.object({
    messageId: z.string(),
    text: Preview,
    status: z.literal('pending'),
  }),
})

/** Emitted only once actually injected into the harness. Never optimistic. */
const steerDelivered = z.object({
  type: z.literal('steer.delivered'),
  data: z.object({
    messageId: z.string(),
    turn: z.number().int().nonnegative(),
  }),
})

// ---------------------------------------------------------------------------
// metering
// ---------------------------------------------------------------------------

/**
 * Window state as reported by the harness itself, when it reports any.
 *
 * Claude Code emits a `rate_limit_event` carrying the seat's rolling-window type,
 * reset time and status — so reset time and status are AUTHORITATIVE for that
 * harness, not inferred. What is still ours to estimate is how much of the window
 * has been consumed, since no percentage is published.
 */
export const RateLimitWindow = z.object({
  /** Provider's own label, e.g. `five_hour` or `weekly`. Left open on purpose. */
  type: z.string(),
  resetsAt: z.string().datetime(),
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  usingOverage: z.boolean().default(false),
})
export type RateLimitWindow = z.infer<typeof RateLimitWindow>

const usageUpdated = z.object({
  type: z.literal('usage.updated'),
  data: TokenUsage.extend({
    usdEst: z.number().nonnegative().optional(),
    /**
     * True when the token counts were inferred rather than reported by the harness.
     * Both harnesses do report them, so this is normally false — but the UI must
     * still label derived window *utilisation* as an estimate.
     */
    estimate: z.boolean().default(true),
    window: RateLimitWindow.optional(),
  }),
})

const budgetWarned = z.object({
  type: z.literal('budget.warned'),
  data: z.object({
    metric: z.enum(['tokens', 'usd_est', 'wall_clock']),
    used: z.number().nonnegative(),
    limit: z.number().positive(),
  }),
})

const budgetExceeded = z.object({
  type: z.literal('budget.exceeded'),
  data: z.object({
    metric: z.enum(['tokens', 'usd_est', 'wall_clock']),
    used: z.number().nonnegative(),
    limit: z.number().positive(),
    /** We park at the next gate rather than dying mid-edit. */
    action: z.literal('parked'),
  }),
})

// ---------------------------------------------------------------------------
// failure
// ---------------------------------------------------------------------------

const errorEvent = z.object({
  type: z.literal('error'),
  data: z.object({
    code: z.string(),
    message: Preview,
    retryable: z.boolean().default(false),
  }),
})

const harnessCrashed = z.object({
  type: z.literal('harness.crashed'),
  data: z.object({
    harness: HarnessId,
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stderrPreview: Preview.optional(),
  }),
})

const rateLimited = z.object({
  type: z.literal('rate_limited'),
  data: z.object({
    scope: z.enum(['seat', 'tool']),
    retryAfterSec: z.number().int().nonnegative().optional(),
    detail: z.string().optional(),
  }),
})

// ---------------------------------------------------------------------------
// unions
// ---------------------------------------------------------------------------

export const EventBody = z.discriminatedUnion('type', [
  runProvisioning,
  bundleFetched,
  cacheRestored,
  worktreeReady,
  runStarted,
  stageEntered,
  stageExited,
  runFinished,
  thinkingStarted,
  assistantDelta,
  assistantMessage,
  turnBoundary,
  toolCall,
  toolResult,
  toolDenied,
  toolServerConnected,
  seatAuthenticated,
  fileChanged,
  diffProduced,
  commandOutput,
  gitBranchCreated,
  gitCommitted,
  gitPushed,
  prOpened,
  gateEvaluated,
  gateBlocked,
  approvalRequested,
  steerReceived,
  steerDelivered,
  usageUpdated,
  budgetWarned,
  budgetExceeded,
  errorEvent,
  harnessCrashed,
  rateLimited,
])
export type EventBody = z.infer<typeof EventBody>

/**
 * What an emitter passes in, before defaults are applied.
 *
 * Drivers and the stage engine build events; the bus parses them and fills in
 * defaults like `truncated: false`. Making callers restate those defaults would be
 * noise, so emit paths take this and only the log holds the settled `EventBody`.
 */
export type EventBodyInput = z.input<typeof EventBody>

export const EventType = z.enum([
  'run.provisioning',
  'bundle.fetched',
  'cache.restored',
  'worktree.ready',
  'run.started',
  'stage.entered',
  'stage.exited',
  'run.finished',
  'thinking.started',
  'assistant.delta',
  'assistant.message',
  'turn.boundary',
  'tool.call',
  'tool.result',
  'tool.denied',
  'tool.server_connected',
  'seat.authenticated',
  'file.changed',
  'diff.produced',
  'command.output',
  'git.branch_created',
  'git.committed',
  'git.pushed',
  'pr.opened',
  'gate.evaluated',
  'gate.blocked',
  'approval.requested',
  'steer.received',
  'steer.delivered',
  'usage.updated',
  'budget.warned',
  'budget.exceeded',
  'error',
  'harness.crashed',
  'rate_limited',
])
export type EventType = z.infer<typeof EventType>

export const EventMeta = z.object({
  /** Per-run, monotonic, gapless. What makes reconnect a replay instead of a hole. */
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  ts: z.string().datetime(),
  /** Null for bootstrap events emitted before the first stage is entered. */
  stage: StageId.nullable(),
})
export type EventMeta = z.infer<typeof EventMeta>

export const AgentEvent = z.intersection(EventMeta, EventBody)
export type AgentEvent = EventMeta & EventBody

/** Narrow an event by type, e.g. `isEvent(e, 'tool.call')`. */
export function isEvent<T extends EventType>(
  event: AgentEvent,
  type: T,
): event is AgentEvent & { type: T } {
  return event.type === type
}

export const EVENT_GROUPS = {
  lifecycle: [
    'run.provisioning',
    'bundle.fetched',
    'cache.restored',
    'worktree.ready',
    'run.started',
    'stage.entered',
    'stage.exited',
    'run.finished',
  ],
  model: ['thinking.started', 'assistant.delta', 'assistant.message', 'turn.boundary'],
  tools: ['tool.call', 'tool.result', 'tool.denied', 'tool.server_connected'],
  seat: ['seat.authenticated'],
  workspace: ['file.changed', 'diff.produced', 'command.output'],
  git: ['git.branch_created', 'git.committed', 'git.pushed', 'pr.opened'],
  control: [
    'gate.evaluated',
    'gate.blocked',
    'approval.requested',
    'steer.received',
    'steer.delivered',
  ],
  metering: ['usage.updated', 'budget.warned', 'budget.exceeded'],
  failure: ['error', 'harness.crashed', 'rate_limited'],
} as const satisfies Record<string, readonly EventType[]>

export type EventGroup = keyof typeof EVENT_GROUPS

/** Truncate a payload to a preview, reporting whether anything was dropped. */
export function preview(
  value: unknown,
  max = PREVIEW_MAX_CHARS,
): {
  text: string
  truncated: boolean
} {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}
