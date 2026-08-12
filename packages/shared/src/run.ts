import { z } from 'zod'
import { HarnessId, StageId } from './ids.js'
import { ProjectManifest } from './manifest.js'
import { StageTemplate } from './stages.js'
import { ToolsetSpec } from './tools.js'

/**
 * What the adapter fetches from `GET /internal/runs/:id/spec` at boot, using the
 * single-use RUN_TOKEN. That token buys this one call and nothing else — every
 * credential after it comes from the broker on demand.
 */

/** The manual task form is the only way tasks are created in M0. */
export const TaskBrief = z.object({
  id: z.string(),
  title: z.string().min(1),
  /** Markdown. Becomes the agent's brief. */
  description: z.string(),
  /** Markdown. Links, constraints, prior art. */
  details: z.string().optional(),
  /** Surfaced to the review stage as the thing to check against. */
  acceptanceCriteria: z.array(z.string()).default([]),
})
export type TaskBrief = z.infer<typeof TaskBrief>

export const GitSpec = z.object({
  repoUrl: z.string().min(1),
  baseBranch: z.string(),
  /** Resolved from the manifest's branchPattern before dispatch, so it is auditable. */
  branch: z.string(),
  /** Where the mirror lands after cache restore. */
  mirrorPath: z.string().default('/cache/git'),
  worktreePath: z.string(),
})
export type GitSpec = z.infer<typeof GitSpec>

export const SeatRef = z.object({
  id: z.string(),
  pool: z.string(),
  provider: z.string(),
})
export type SeatRef = z.infer<typeof SeatRef>

export const RunLimits = z.object({
  wallClockSec: z.number().int().positive(),
  idleKillSec: z.number().int().positive(),
  perStageTimeoutSec: z.number().int().positive(),
  tokensMax: z.number().int().positive(),
  usdEstMax: z.number().positive(),
})
export type RunLimits = z.infer<typeof RunLimits>

export const BundleRef = z.object({
  url: z.string().min(1),
  digest: z.string().min(1),
})
export type BundleRef = z.infer<typeof BundleRef>

export const RunSpec = z.object({
  runId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  /** Pinned. The manifest may have moved on; this run does not. */
  manifestVersion: z.number().int().positive(),
  manifest: ProjectManifest,
  bundle: BundleRef,
  task: TaskBrief,
  harness: HarnessId,
  stageTemplate: StageTemplate,
  toolset: ToolsetSpec,
  git: GitSpec,
  seat: SeatRef,
  limits: RunLimits,
  /** Where the adapter dials out to. Nothing ever dials in. */
  controlPlaneUrl: z.string().url(),
  streamUrl: z.string(),
  /** Unix socket the credential broker listens on inside the container. */
  brokerSocket: z.string().default('/run/broker.sock'),
})
export type RunSpec = z.infer<typeof RunSpec>

// ---------------------------------------------------------------------------
// control frames — UI → control plane → adapter, down the same socket
// ---------------------------------------------------------------------------

/** Queued and injected at the next `turn.boundary`, never mid tool-call. */
const steerFrame = z.object({
  type: z.literal('steer'),
  messageId: z.string(),
  text: z.string().min(1),
})

/** A separate verb from steering: jumps the queue and halts at the nearest safe point. */
const interruptFrame = z.object({
  type: z.literal('interrupt'),
})

const cancelFrame = z.object({
  type: z.literal('cancel'),
  reason: z.string().optional(),
})

const approvalFrame = z.object({
  type: z.literal('approval'),
  approvalId: z.string(),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().optional(),
})

/** Acknowledges events up to `seq` so the adapter can drop its replay buffer. */
const ackFrame = z.object({
  type: z.literal('ack'),
  seq: z.number().int().nonnegative(),
})

export const ControlFrame = z.discriminatedUnion('type', [
  steerFrame,
  interruptFrame,
  cancelFrame,
  approvalFrame,
  ackFrame,
])
export type ControlFrame = z.infer<typeof ControlFrame>

/** One row of `run_stages`: how a stage went, and whether it can be resumed. */
export const StageRecord = z.object({
  stage: StageId,
  attempt: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'parked']),
  harness: HarnessId.optional(),
  /** Harness-native session id, so a resumed run continues rather than restarts. */
  resumeToken: z.string().nullable().default(null),
  gatePassed: z.boolean().nullable().default(null),
  gateDetail: z.string().optional(),
  output: z.record(z.unknown()).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
})
export type StageRecord = z.infer<typeof StageRecord>
