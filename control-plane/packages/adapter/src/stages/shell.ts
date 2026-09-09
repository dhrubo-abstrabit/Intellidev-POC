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

      // Polite first, then not. A hung process ignoring SIGTERM would otherwise hold the
      // run open until its wall-clock limit.
      const kill = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000)
      }, opts.timeoutSec * 1000)

      const finish = (exitCode: number) => {
        if (settled) return
        settled = true
        clearTimeout(kill)
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
    })
  }
}
