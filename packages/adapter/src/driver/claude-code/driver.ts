import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { preview, type EventBodyInput, type HarnessId } from '@intellidev/shared'
import { NdjsonBuffer } from '../ndjson.js'
import { AsyncQueue } from '../queue.js'
import type {
  HarnessCapabilities,
  HarnessDriver,
  Session,
  SessionInfo,
  StageRequest,
  UsageSnapshot,
} from '../types.js'
import { ClaudeCodeMapper } from './mapper.js'

export const CLAUDE_CODE_PINNED_VERSION = '2.1.228'

/**
 * Streaming stdin means a steer can reach a turn in flight, and the CLI reports both
 * cost and the provider's rolling-window state. What it lacks is a native
 * response-schema flag, so structured output goes through our `stage_advance`
 * gateway tool instead.
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  midRunSteering: true,
  streamingDeltas: true,
  nativeStructuredOutput: false,
  reportsWindowState: true,
  reportsCost: true,
  nativeSkills: true,
  perToolPermissions: true,
}

export interface ClaudeCodeDriverOptions {
  /** Overridable so tests and the golden image can point at an absolute path. */
  binary?: string
  /** Streaming stdin enables mid-run steering. Off means one-shot. */
  streamingInput?: boolean
  /** Token deltas for the live UI feed. Costs nothing but volume. */
  includePartialMessages?: boolean
}

/**
 * The stage's policy, as Claude Code spells it.
 *
 * FOUND BY RUNNING IT. Without this the CLI ran in its `default` mode, which asks a human before
 * a write — and a headless run has nobody to ask, so every `Write` and every `Bash` redirection
 * was refused while reads sailed through. The agent spent a whole stage proving the directory was
 * writable, which it was; the permission prompt was the thing in the way.
 *
 * `acceptEdits` rather than `bypassPermissions`: edits inside the worktree are the job, and the
 * deny-list for irreversible commands should keep applying.
 */
export function claudePermissionMode(mode: StageRequest['toolsMode']): string {
  return mode === 'full' ? 'acceptEdits' : 'plan'
}

export function buildClaudeArgs(req: StageRequest, opts: ClaudeCodeDriverOptions = {}): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']

  // Streaming stdin is what makes steering possible at all; without it the CLI
  // takes one prompt and exits.
  if (opts.streamingInput !== false) args.push('--input-format', 'stream-json')
  if (opts.includePartialMessages !== false) args.push('--include-partial-messages')

  if (req.mcpConfigPath) args.push('--mcp-config', req.mcpConfigPath)
  if (req.systemAppend) args.push('--append-system-prompt', req.systemAppend)
  if (req.model) args.push('--model', req.model)
  args.push('--permission-mode', claudePermissionMode(req.toolsMode))
  if (req.maxTurns !== undefined) args.push('--max-turns', String(req.maxTurns))
  if (req.resume) args.push('--resume', req.resume)

  return args
}

/** One NDJSON user message, the shape `--input-format stream-json` expects. */
export function encodeUserMessage(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  )
}

export class ClaudeCodeDriver implements HarnessDriver {
  readonly id: HarnessId = 'claude-code'
  readonly capabilities = CLAUDE_CODE_CAPABILITIES

  constructor(private readonly opts: ClaudeCodeDriverOptions = {}) {}

  async materialise(_paths: { cwd: string; home: string }): Promise<void> {
    // Config projection lands in T8; the driver only consumes what it is given.
  }

  async start(req: StageRequest): Promise<Session> {
    const args = buildClaudeArgs(req, this.opts)
    const child = spawn(this.opts.binary ?? 'claude', args, {
      cwd: req.cwd,
      env: { ...process.env, ...req.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    return new ClaudeCodeSession(child, req)
  }
}

class ClaudeCodeSession implements Session {
  readonly events = new AsyncQueue<EventBodyInput>()
  private readonly mapper = new ClaudeCodeMapper()
  private readonly stdout = new NdjsonBuffer()
  private readonly steerQueue: Array<{ text: string }> = []
  private atBoundary = false
  private turn = 0
  private stderrTail = ''
  private exit: { exitCode: number | null; signal: string | null } | null = null
  private readonly exited: Promise<{ exitCode: number | null; signal: string | null }>
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    req: StageRequest,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail: stderr is diagnostics, not a transport.
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000)
    })

    this.exited = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => {
        for (const raw of this.stdout.flush()) this.emit(this.mapper.push(raw))
        for (const line of this.stdout.malformed) {
          this.events.push({
            type: 'error',
            data: { code: 'malformed_output', message: preview(line).text, retryable: false },
          })
        }
        // A non-zero exit with no result event means the harness died rather than
        // finished — the stage engine needs to tell those apart.
        if (exitCode !== 0 && exitCode !== null) {
          this.events.push({
            type: 'harness.crashed',
            data: {
              harness: 'claude-code',
              exitCode,
              signal: signal ?? null,
              stderrPreview: preview(this.stderrTail).text,
            },
          })
        }
        if (this.timer) clearTimeout(this.timer)
        this.exit = { exitCode, signal: signal ?? null }
        this.events.close()
        resolve(this.exit)
      })
    })

    // The first prompt goes in as a normal streaming message, so the same path
    // handles it and every later steer.
    child.stdin.write(encodeUserMessage(req.prompt))

    if (req.timeoutSec) {
      this.timer = setTimeout(() => {
        this.events.push({
          type: 'error',
          data: { code: 'stage_timeout', message: `exceeded ${req.timeoutSec}s`, retryable: true },
        })
        void this.interrupt()
      }, req.timeoutSec * 1000)
    }
  }

  private onStdout(chunk: Buffer): void {
    for (const raw of this.stdout.push(chunk)) this.emit(this.mapper.push(raw))
  }

  private emit(bodies: EventBodyInput[]): void {
    for (const body of bodies) {
      this.events.push(body)
      if (body.type === 'turn.boundary') {
        this.turn = body.data.turn
        this.atBoundary = true
        this.flushSteers()
        // FOUND BY RUNNING IT. Streaming stdin is what makes steering possible, but it also
        // means the CLI waits for another message after finishing a turn instead of exiting —
        // so the process never closed, the event queue never closed with it, and the stage hung
        // until its timeout with a completed plan already in the log.
        //
        // `flushSteers` clears `atBoundary` when it writes, so this only fires when the turn
        // ended with nothing queued: the stage is one turn, and that turn is over.
        if (this.atBoundary) this.endInput()
      } else {
        this.atBoundary = false
      }
    }
  }

  /** Close stdin so the CLI exits. Safe to call twice; a late steer simply finds it shut. */
  private endInput(): void {
    if (this.child.stdin.writable) this.child.stdin.end()
  }

  /**
   * Injected only at a turn boundary. Writing mid tool-call corrupts the
   * transcript, so a steer that arrives early waits — and the UI shows it as
   * pending until `steer.delivered` says otherwise.
   */
  private flushSteers(): void {
    if (!this.atBoundary) return
    while (this.steerQueue.length > 0) {
      const next = this.steerQueue.shift()
      if (!next) break
      this.child.stdin.write(encodeUserMessage(next.text))
      this.events.push({
        type: 'steer.delivered',
        data: { messageId: hashMessage(next.text), turn: this.turn },
      })
      this.atBoundary = false
    }
  }

  async send(text: string): Promise<void> {
    this.steerQueue.push({ text })
    this.flushSteers()
  }

  pendingSteers(): string[] {
    return this.steerQueue.map((s) => s.text)
  }

  /**
   * Terminates the harness. Claude Code 2.1.228 advertises an
   * `interrupt_receipt_v1` capability over the control protocol, which would stop
   * the turn without killing the process — worth adopting once the frame shape is
   * verified. Until then this is a hard stop, and the stage engine treats it as
   * the stage being cancelled rather than failed.
   */
  async interrupt(): Promise<void> {
    if (this.exit) return
    this.child.kill('SIGINT')
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    await Promise.race([this.exited.then(() => undefined), deadline])
    if (!this.exit) this.child.kill('SIGKILL')
  }

  usage(): UsageSnapshot {
    return this.mapper.usage()
  }

  info(): SessionInfo | null {
    return this.mapper.info()
  }

  get resumeToken(): string | null {
    return this.mapper.resumeToken
  }

  get unmapped(): readonly string[] {
    return this.mapper.unmapped
  }

  done(): Promise<{ exitCode: number | null; signal: string | null }> {
    return this.exited
  }
}

/** Stable short id for a steer message, so pending/delivered can be correlated. */
function hashMessage(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
  return `steer_${(hash >>> 0).toString(36)}`
}
