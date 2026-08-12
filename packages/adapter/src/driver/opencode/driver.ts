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
import { OpencodeMapper } from './mapper.js'

export const OPENCODE_PINNED_VERSION = '1.18.16'

/**
 * `opencode run` is one-shot like `codex exec`, so no mid-run steering. It does
 * stream text deltas and — unlike Codex — reports a per-step cost. Being
 * provider-agnostic, it has no single rolling window to report.
 *
 * Verified from `opencode run --help` and the server's OpenAPI document at 1.18.16.
 */
export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  midRunSteering: false,
  streamingDeltas: true,
  nativeStructuredOutput: false,
  reportsWindowState: false,
  reportsCost: true,
}

export interface OpencodeDriverOptions {
  binary?: string
  /** `provider/model`, e.g. `anthropic/claude-opus-5`. */
  model?: string
  /** Named agent from opencode's own agent config. */
  agent?: string
  /** Provider-specific reasoning effort — `high`, `max`, `minimal`. */
  variant?: string
  /**
   * Auto-approve permissions. Required for unattended runs, and safe only because
   * the run container is the sandbox — never enable this outside one.
   */
  auto?: boolean
  /** Attach to an already-running `opencode serve` instead of starting one. */
  attach?: string
}

export function buildOpencodeArgs(req: StageRequest, opts: OpencodeDriverOptions = {}): string[] {
  const args = ['run', '--format', 'json']

  args.push('--dir', req.cwd)
  // Unattended means nothing can answer a permission prompt; the container is the
  // boundary that makes this acceptable.
  if (opts.auto !== false) args.push('--auto')

  // Session continuation is a flag here, unlike Codex's positional subcommand.
  if (req.resume) args.push('--session', req.resume)

  const model = req.model ?? opts.model
  if (model) args.push('--model', model)
  if (opts.agent) args.push('--agent', opts.agent)
  if (opts.variant) args.push('--variant', opts.variant)
  if (opts.attach) args.push('--attach', opts.attach)

  // The prompt is variadic and positional. There is no system-prompt flag, so an
  // append is prefixed rather than dropped.
  const prompt = req.systemAppend ? `${req.systemAppend}\n\n${req.prompt}` : req.prompt
  args.push(prompt)

  return args
}

export class OpencodeDriver implements HarnessDriver {
  readonly id: HarnessId = 'opencode'
  readonly capabilities = OPENCODE_CAPABILITIES

  constructor(private readonly opts: OpencodeDriverOptions = {}) {}

  async materialise(_paths: { cwd: string; home: string }): Promise<void> {
    // Config projection lands in T8.
  }

  async start(req: StageRequest): Promise<Session> {
    const args = buildOpencodeArgs(req, this.opts)
    const child = spawn(this.opts.binary ?? 'opencode', args, {
      cwd: req.cwd,
      env: { ...process.env, ...req.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    // The prompt is an argument; nothing should be waiting on stdin.
    child.stdin.end()

    return new OpencodeSession(child, req)
  }
}

class OpencodeSession implements Session {
  readonly events = new AsyncQueue<EventBodyInput>()
  private readonly mapper = new OpencodeMapper()
  private readonly stdout = new NdjsonBuffer()
  private readonly queuedSteers: string[] = []
  private stderrTail = ''
  private exit: { exitCode: number | null; signal: string | null } | null = null
  private readonly exited: Promise<{ exitCode: number | null; signal: string | null }>
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    req: StageRequest,
  ) {
    child.stdout.on('data', (chunk: Buffer) => {
      for (const raw of this.stdout.push(chunk)) this.emit(this.mapper.push(raw))
    })
    child.stderr.on('data', (chunk: Buffer) => {
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
        if (exitCode !== 0 && exitCode !== null) {
          this.events.push({
            type: 'harness.crashed',
            data: {
              harness: 'opencode',
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

  private emit(bodies: EventBodyInput[]): void {
    for (const body of bodies) this.events.push(body)
  }

  /** Queues only; `opencode run` has no channel into a turn already in flight. */
  async send(text: string): Promise<void> {
    this.queuedSteers.push(text)
  }

  pendingSteers(): string[] {
    return [...this.queuedSteers]
  }

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
