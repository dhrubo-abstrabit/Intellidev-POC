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
import { CodexMapper } from './mapper.js'

export const CODEX_PINNED_VERSION = '0.147.0'

/**
 * Codex `exec` takes one prompt and runs to completion — there is no streaming
 * stdin, so a steer cannot reach a turn in flight. It does have `--output-schema`,
 * which Claude Code lacks. The gaps run in both directions, which is exactly why
 * the capability record exists rather than a lowest-common-denominator interface.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  midRunSteering: false,
  streamingDeltas: false,
  nativeStructuredOutput: true,
  reportsWindowState: false,
  reportsCost: false,
}

/** Our tool policy → the sandbox Codex should run commands under. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

export function sandboxForToolMode(mode: 'none' | 'read_only' | 'full'): CodexSandbox {
  switch (mode) {
    case 'none':
    case 'read_only':
      return 'read-only'
    case 'full':
      return 'workspace-write'
  }
}

export interface CodexDriverOptions {
  binary?: string
  sandbox?: CodexSandbox
  /** Needed when the worktree is not itself a git repository. */
  skipGitRepoCheck?: boolean
  /** Path to a JSON Schema constraining the final message — used by predicate gates. */
  outputSchemaPath?: string
  /** Keep no session files on disk; the run container is thrown away anyway. */
  ephemeral?: boolean
}

export function buildCodexArgs(req: StageRequest, opts: CodexDriverOptions = {}): string[] {
  const args = ['exec', '--json']

  // Resume continues an existing thread instead of starting cold. Codex takes the
  // thread id as a subcommand argument rather than a flag.
  if (req.resume) args.splice(1, 0, 'resume', req.resume)

  args.push('-C', req.cwd)
  args.push('-s', opts.sandbox ?? 'workspace-write')
  if (opts.skipGitRepoCheck !== false) args.push('--skip-git-repo-check')
  if (opts.ephemeral) args.push('--ephemeral')
  if (req.model) args.push('-m', req.model)
  if (opts.outputSchemaPath) args.push('--output-schema', opts.outputSchemaPath)

  // MCP servers are config, not flags — one entry pointing at our gateway.
  if (req.mcpConfigPath) {
    args.push('-c', `mcp_servers.intellidev.command=${req.mcpConfigPath}`)
  }

  // The prompt is positional. A system append has nowhere else to go, so it is
  // prefixed onto the prompt rather than silently dropped.
  const prompt = req.systemAppend ? `${req.systemAppend}\n\n${req.prompt}` : req.prompt
  args.push(prompt)

  return args
}

export class CodexDriver implements HarnessDriver {
  readonly id: HarnessId = 'codex'
  readonly capabilities = CODEX_CAPABILITIES

  constructor(private readonly opts: CodexDriverOptions = {}) {}

  async materialise(_paths: { cwd: string; home: string }): Promise<void> {
    // Config projection lands in T8.
  }

  async start(req: StageRequest): Promise<Session> {
    const args = buildCodexArgs(req, this.opts)
    const child = spawn(this.opts.binary ?? 'codex', args, {
      cwd: req.cwd,
      env: { ...process.env, ...req.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    // Codex appends piped stdin to the prompt as a `<stdin>` block and waits for it
    // to close. Since the prompt is already an argument, close stdin immediately —
    // leaving it open hangs the process forever.
    child.stdin.end()

    return new CodexSession(child, req)
  }
}

class CodexSession implements Session {
  readonly events = new AsyncQueue<EventBodyInput>()
  private readonly mapper = new CodexMapper()
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
              harness: 'codex',
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

  /**
   * Queues only. Codex has no channel into a running turn, so the stage engine
   * picks these up from `pendingSteers()` and resumes the thread with them —
   * a human's message is deferred, never discarded.
   */
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
