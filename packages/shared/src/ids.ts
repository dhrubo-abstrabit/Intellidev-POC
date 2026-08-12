import { z } from 'zod'

/**
 * Vocabulary shared with the UI. These strings are server-authoritative: the UI
 * renders them and never infers them. See docs/ui-contract.md.
 */

/** One step of the process. The UI calls these "stages" — never "phases". */
export const StageId = z.enum([
  'design',
  'branch',
  'code',
  'verify',
  'test',
  'review',
  'approval',
  'pr',
])
export type StageId = z.infer<typeof StageId>

/**
 * Three harnesses. Each is a driver behind one interface, never a fork of the
 * platform — adding the third cost a driver and a capability record, which is the
 * abstraction doing its job rather than a reason to redesign anything.
 */
export const HarnessId = z.enum(['claude-code', 'codex', 'opencode'])
export type HarnessId = z.infer<typeof HarnessId>

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
  dispatched: ['running', 'waiting_capacity', 'failed', 'not_started'],
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
