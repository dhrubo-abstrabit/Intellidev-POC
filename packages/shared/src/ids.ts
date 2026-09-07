import { z } from 'zod'

/**
 * Vocabulary shared with the UI. These strings are server-authoritative: the UI
 * renders them and never infers them. See docs/ui-contract.md.
 */

/** One step of the process. The UI calls these "stages" — never "phases". */
/**
 * A stage's name, as a slug.
 *
 * This was a closed enum of nine, which made the pipeline exactly as configurable as whoever
 * edited this file. A client space that wants a `security-review` stage, or one that wants no
 * `design` at all, was asking for a code change — so the vocabulary is open and the *composition*
 * is data.
 *
 * Still constrained. An id names a directory entry in a bundle, appears in an event stream, and
 * is a key in several maps, so it is a slug rather than free text: lower case, digits and dashes,
 * starting with a letter. Anything looser would let a template smuggle a path into a filename.
 *
 * `BuiltinAction` stays closed, and that is the real boundary — a builtin stage runs *our* code,
 * so its action must be one we wrote. An agent stage is a prompt and a tool policy, which is why
 * it can be anything.
 */
export const StageId = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z][a-z0-9-]*$/,
    'a stage id is lower case letters, digits and dashes, starting with a letter',
  )
export type StageId = z.infer<typeof StageId>

/**
 * The stages the built-in template uses, and what the UI offers first.
 *
 * Not a constraint — a project may name a stage anything valid. These exist so the default
 * template, the bundled prompts and the picker all agree on the common ones rather than each
 * spelling them separately.
 */
export const WELL_KNOWN_STAGE_IDS = [
  'design',
  'branch',
  'code',
  'commit',
  'verify',
  'test',
  'review',
  'approval',
  'pr',
] as const

/**
 * Three harnesses. Each is a driver behind one interface, never a fork of the
 * platform — adding the third cost a driver and a capability record, which is the
 * abstraction doing its job rather than a reason to redesign anything.
 */
export const HarnessId = z.enum(['claude-code', 'codex', 'opencode'])
export type HarnessId = z.infer<typeof HarnessId>

/**
 * Default for new projects.
 *
 * opencode, because it is the richest projection target of the three: native skills
 * via `skills.paths`, MCP local *and* remote servers, an `instructions` array, and
 * per-tool permission rules. A project can override it per stage.
 */
export const DEFAULT_HARNESS: HarnessId = 'opencode'

export const TaskStatus = z.enum([
  'not_started',
  'dispatched',
  'running',
  'waiting_capacity',
  'in_review',
  'done',
  'blocked',
  'failed',
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const RunStatus = z.enum([
  'queued',
  'provisioning',
  'running',
  'parked',
  'succeeded',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatus>

/** Health of an attached MCP server, refreshed on a schedule — not at dispatch. */
export const ConnectionHealth = z.enum(['ok', 'needs_reauth', 'unreachable'])
export type ConnectionHealth = z.infer<typeof ConnectionHealth>

export const StageOutcome = z.enum(['passed', 'failed', 'skipped'])
export type StageOutcome = z.infer<typeof StageOutcome>

export const RunOutcome = z.enum(['succeeded', 'failed', 'cancelled', 'parked'])
export type RunOutcome = z.infer<typeof RunOutcome>

/**
 * Transitions the API enforces. Anything not listed is rejected, so status can
 * never be advanced out of order by a client.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  not_started: ['dispatched', 'blocked'],
  // `in_review` is reachable directly, not only through `running`. A run's outcome is
  // authoritative, and it can finish without a `run.started` event ever being *recorded* —
  // a database blip losing that one write left a task stuck on `dispatched` for ever while
  // its run said `succeeded`. The board must be able to tell the truth.
  dispatched: ['running', 'in_review', 'waiting_capacity', 'failed', 'not_started'],
  waiting_capacity: ['dispatched', 'running', 'failed', 'not_started'],
  running: ['in_review', 'failed', 'blocked', 'waiting_capacity'],
  in_review: ['done', 'running', 'failed'],
  blocked: ['not_started', 'dispatched', 'failed'],
  done: [],
  failed: ['not_started', 'dispatched'],
} as const

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to)
}

/** Statuses that mean "nothing more will happen without a human". */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done'] as const

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
] as const

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}
