import type { HarnessId, StageId, StageRecord } from '@intellidev/shared'

/** Injected so the engine is testable without a shell. */
export interface CommandRunner {
  run(
    command: string,
    opts: { cwd: string; timeoutSec: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
}

/**
 * Deterministic steps that are ours, not the model's. Implemented in T6 (git
 * workflow); the engine only needs the seam so its own logic can be proven first.
 */
export interface BuiltinActions {
  createBranch(ctx: StageContext): Promise<{ branch: string; from: string }>
  /** Commits whatever the agent stages left in the worktree. Null when nothing changed. */
  commit(ctx: StageContext): Promise<{ sha: string; filesChanged: number } | null>
  openPullRequest(ctx: StageContext): Promise<{ number: number; url: string }>
}

/**
 * Where a stage's structured output arrives from. In the real system the MCP
 * gateway's `stage_advance` tool writes it here (T7); Codex can also produce it
 * natively via `--output-schema`.
 */
export interface StageOutputSink {
  /** Consume the output for a stage, if the agent produced one. */
  take(stage: StageId): unknown | undefined
}

export interface StageContext {
  runId: string
  stage: StageId
  attempt: number
  cwd: string
  harness: HarnessId
  /** Harness-native session id from a previous attempt, if any. */
  resume?: string
  /** Steers queued but not yet delivered, carried into the next attempt. */
  pendingSteers: string[]
}

/** Persisted after every transition, so a killed process resumes at its last gate. */
export interface RunState {
  runId: string
  templateName: string
  /** Index into the template's stage list. */
  cursor: number
  /** Gate failures per stage, which is what `maxAttempts` bounds. */
  gateFailures: Partial<Record<StageId, number>>
  /** How many times each stage has been entered, for reporting. */
  visits: Partial<Record<StageId, number>>
  records: StageRecord[]
  status: 'running' | 'succeeded' | 'failed' | 'parked' | 'cancelled'
  /** Per-stage harness session ids, so a resumed stage continues its thread. */
  resumeTokens: Partial<Record<StageId, string>>
  /** Steers that arrived while a non-steerable harness was mid-stage. */
  pendingSteers: string[]
  totalStageRuns: number
  failureReason?: string
}

export interface RunStateStore {
  load(): Promise<RunState | null>
  save(state: RunState): Promise<void>
}
