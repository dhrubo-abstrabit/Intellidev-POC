import type { EventBodyInput, HarnessId, StageId, TokenUsage } from '@intellidev/shared'

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
  /**
   * The stage's tool policy, in the canonical vocabulary.
   *
   * Passed per stage because a permission mode is not a property of the run: `design` plans and
   * `code` edits, and the config files are written once at bootstrap so they cannot express the
   * difference. Each driver maps this to whatever its harness calls the same idea.
   */
  toolsMode?: 'none' | 'read_only' | 'full'
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

/**
 * Where the harnesses genuinely differ. Written down rather than papered over,
 * because the stage engine has to compensate for each gap explicitly — and because
 * levelling everything down to the weakest harness would be the wrong consistency.
 *
 * Verified against claude-code 2.1.228 and codex-cli 0.147.0 in T2/T3.
 */
export interface HarnessCapabilities {
  /**
   * Whether a steer can reach a running turn. Claude Code accepts streaming stdin;
   * Codex `exec` takes one prompt and runs to completion, so steering it means
   * resuming the thread with a follow-up prompt after the stage ends.
   */
  midRunSteering: boolean
  /** Token-level deltas for the live UI feed, rather than settled messages only. */
  streamingDeltas: boolean
  /**
   * A native way to constrain the final response to a JSON Schema. Codex has
   * `--output-schema`; Claude Code goes through our `stage_advance` gateway tool.
   */
  nativeStructuredOutput: boolean
  /** Reports the provider's rolling-window reset and status. Claude Code only. */
  reportsWindowState: boolean
  /** Reports a currency cost for the turn. */
  reportsCost: boolean
  /**
   * Loads skills from a directory itself, with progressive disclosure. Where true we
   * hand the harness real files; where false the gateway exposes `skill_list` and
   * `skill_load` as tools instead.
   */
  nativeSkills: boolean
  /**
   * Can allow or deny individual tools in its own config. Where false the gateway
   * must enforce the whole policy, since the harness can only be told all-or-nothing.
   */
  perToolPermissions: boolean
}

export interface Session {
  /**
   * Normalised events, in order. Bodies only — the adapter's event bus assigns
   * `seq`, `runId` and `ts`, because only one thing may number the stream.
   */
  readonly events: AsyncIterable<EventBodyInput>
  /**
   * Queued; injected at the next turn boundary, never mid tool-call. On a harness
   * without `midRunSteering` this only queues — see `pendingSteers`.
   */
  send(text: string): Promise<void>
  /**
   * Steers that were queued but never delivered, because the harness had no
   * boundary left to inject them at. The stage engine resumes the session with
   * these rather than silently dropping what a human typed.
   */
  pendingSteers(): string[]
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
  /** Static per harness, so the stage engine can plan around the gaps. */
  readonly capabilities: HarnessCapabilities
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
  push(raw: unknown): EventBodyInput[]
  readonly unmapped: readonly string[]
  usage(): UsageSnapshot
  info(): SessionInfo | null
  readonly resumeToken: string | null
}
