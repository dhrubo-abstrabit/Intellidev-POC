import { spawn } from 'node:child_process'
import { preview, type EventBodyInput } from '@intellidev/shared'
import type { CommandRunner } from './types.js'

/**
 * Runs gate commands and `run_check` invocations.
 *
 * Three things this has to get right, each of which would otherwise waste a whole run:
 *
 *  - **A timeout that actually kills.** `SIGTERM` then `SIGKILL`, because a hung test
 *    process ignores the polite signal and the run would sit there burning wall clock.
 *  - **Output is captured, not streamed to our stdout.** In production stdout is the MCP
 *    gateway's transport; printing a test log into it would corrupt the protocol.
 *  - **Secrets in the environment, output through the bus.** Command output is emitted as
 *    events, so it passes the bus redactor before it can reach the log.
 */
export interface ShellCommandRunnerOptions {
  /** Project env plus resolved secrets for the current stage. */
  env?: Record<string, string>
  /** Emitting output as events is what puts it through the redactor. */
  emit?: (event: EventBodyInput) => void
  shell?: string
  /** Keep only the tail: a 200MB test log is not an event payload. */
  maxCapturedBytes?: number
}

export class ShellCommandRunner implements CommandRunner {
  constructor(private readonly opts: ShellCommandRunnerOptions = {}) {}

  async run(
    command: string,
    opts: { cwd: string; timeoutSec: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const max = this.opts.maxCapturedBytes ?? 512_000
    const shell = this.opts.shell ?? '/bin/sh'

    return new Promise((resolve) => {
      const child = spawn(shell, ['-c', command], {
        cwd: opts.cwd,
        /**
         * Its own process group, so the timeout can kill the whole tree.
         *
         * FOUND ON LINUX CI, PASSING ON MACOS. `sh -c 'sleep 30'` execs under bash but *forks*
         * under dash, so signalling the child killed the shell and left `sleep` orphaned —
         * still holding the stdout and stderr pipes, so `close` never fired and the command
         * hung until the run's wall-clock limit. Which is the exact failure the timeout below
         * exists to prevent.
         *
         * A group leader can be signalled as `-pid`, which reaches every descendant. Not
         * `unref`'d: this process still waits for it.
         */
        detached: true,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '/tmp',
          CI: '1',
          // Colour codes in a captured log are noise a model has to read past.
          NO_COLOR: '1',
          TERM: 'dumb',
          ...this.opts.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const capture = (stream: 'stdout' | 'stderr') => (chunk: string) => {
        if (stream === 'stdout') stdout = (stdout + chunk).slice(-max)
        else stderr = (stderr + chunk).slice(-max)
        this.opts.emit?.({
          type: 'command.output',
          data: { command, stream, chunk: preview(chunk).text },
        })
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', capture('stdout'))
      child.stderr.on('data', capture('stderr'))

      /**
       * Signal the group, not the process.
       *
       * `child.kill()` reaches only the shell. Anything it started outlives it and keeps the
       * pipes open, which is what made the timeout below not actually a timeout.
       */
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, signal)
        } catch {
          // ESRCH: the group is already gone, which is the outcome being asked for. On a
          // platform without process groups, fall back to the child alone.
          try {
            child.kill(signal)
          } catch {
            /* already reaped */
          }
        }
      }

      // Polite first, then not. A hung process ignoring SIGTERM would otherwise hold the
      // run open until its wall-clock limit.
      let hard: NodeJS.Timeout | undefined
      let flush: NodeJS.Timeout | undefined
      const kill = setTimeout(() => {
        signalGroup('SIGTERM')
        hard = setTimeout(() => signalGroup('SIGKILL'), 5_000)
      }, opts.timeoutSec * 1000)

      const finish = (exitCode: number) => {
        if (settled) return
        settled = true
        clearTimeout(kill)
        if (hard) clearTimeout(hard)
        if (flush) clearTimeout(flush)
        resolve({ exitCode, stdout, stderr })
      }

      child.on('error', (error) => {
        stderr += `\n${error.message}`
        finish(127)
      })
      child.on('close', (code, signal) => {
        // A killed process reports a null code; the caller needs a number to compare.
        finish(code ?? (signal ? 124 : -1))
      })
      /**
       * `close` waits for the pipes; `exit` does not. Normally close follows within a tick and
       * is the one worth waiting for, because it means every byte has been read. But a
       * descendant holding an inherited pipe open can delay it indefinitely — so once the shell
       * itself is gone, give the streams a moment to drain and then answer regardless.
       */
      child.on('exit', (code, signal) => {
        if (settled) return
        flush = setTimeout(() => finish(code ?? (signal ? 124 : -1)), 250)
      })
    })
  }
}
