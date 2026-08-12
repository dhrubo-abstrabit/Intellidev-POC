import type { EventBody, HarnessId, StageId, TokenUsage } from '@intellidev/shared'

/**
 * The seam that keeps the harness replaceable.
 *
 * Everything durable — stages, gates, events, tools, credentials — lives on our
 * side of this interface. A third harness costs a driver, not a redesign.
 */

export interface StageRequest {
  stage: StageId
  /** The stage prompt, already rendered from the bundle. */
  prompt: string
  /** Appended to the harness's system prompt where it supports one. */
  systemAppend?: string
  cwd: string
  /** Path to the rendered MCP config pointing at our gateway. */
  mcpConfigPath?: string
  model?: string
  /** Harness-native session id to continue rather than restart. */
  resume?: string
  /** Hard stop for the stage, enforced by the driver as well as the engine. */
  timeoutSec?: number
  maxTurns?: number
  env?: Record<string, string>
}

export interface UsageSnapshot extends TokenUsage {
  usdEst?: number
  /** Populated only when the harness reports its own window state. */
  window?: {
    type: string
    resetsAt: string
    status: 'allowed' | 'allowed_warning' | 'rejected'
    usingOverage: boolean
  }
}

/** What the harness told us about itself at startup. Recorded for reproducibility. */
export interface SessionInfo {
  sessionId: string
  harness: HarnessId
  harnessVersion?: string
  model?: string
  tools: string[]
  mcpServers: Array<{ name: string; status: string }>
  skills: string[]
  capabilities: string[]
}

export interface Session {
  /**
   * Normalised events, in order. Bodies only — the adapter's event bus assigns
   * `seq`, `runId` and `ts`, because only one thing may number the stream.
   */
  readonly events: AsyncIterable<EventBody>
  /** Queued; injected at the next turn boundary, never mid tool-call. */
  send(text: string): Promise<void>
  /** A separate verb from steering: jumps the queue and stops the stage. */
  interrupt(): Promise<void>
  usage(): UsageSnapshot
  /** Available once the harness has reported its session. */
  info(): SessionInfo | null
  /** Non-null once known, so a resumed run continues rather than restarts. */
  readonly resumeToken: string | null
  /** Resolves when the process has exited and `events` is exhausted. */
  done(): Promise<{ exitCode: number | null; signal: string | null }>
}

export interface HarnessDriver {
  readonly id: HarnessId
  /** Write this harness's own config files from the canonical bundle. */
  materialise(paths: { cwd: string; home: string }): Promise<void>
  start(req: StageRequest): Promise<Session>
}

/**
 * A driver maps raw harness output to canonical events, and reports anything it
 * did not recognise. Unmapped output is how CLI drift is detected — the
 * alternative is silently dropping new message types.
 */
export interface RawMapper {
  push(raw: unknown): EventBody[]
  readonly unmapped: readonly string[]
  usage(): UsageSnapshot
  info(): SessionInfo | null
  readonly resumeToken: string | null
}
