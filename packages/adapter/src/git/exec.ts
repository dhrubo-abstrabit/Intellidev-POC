import { spawn } from 'node:child_process'

/**
 * Runs git with a deliberately hostile-to-surprises environment.
 *
 * Four settings that are not optional, each fixing a failure that is miserable to
 * diagnose in a headless run:
 *
 *  - `GIT_TERMINAL_PROMPT=0` — without it, a failed auth **hangs forever** waiting for a
 *    password nobody can type. The run burns its wall-clock budget doing nothing.
 *  - `GIT_ASKPASS=` and `SSH_ASKPASS=` — same trap through a different door, including a
 *    GUI prompt on a developer machine.
 *  - `GIT_CONFIG_NOSYSTEM=1` and a pinned `HOME` — so a developer's global gitconfig
 *    cannot change what a run does. Reproducibility beats convenience here.
 *  - Author and committer passed explicitly, never inherited.
 */
export interface GitIdentity {
  name: string
  email: string
}

export interface GitRunnerOptions {
  /** Where git config and the credential helper are resolved from. */
  home: string
  identity: GitIdentity
  /** Shell command for `credential.helper`. The `!` prefix is git's own convention. */
  credentialHelper?: string
  /** Extra env for the git process. Never secrets — git needs none. */
  env?: Record<string, string>
  timeoutSec?: number
  onCommand?: (command: string) => void
}

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`)
  }
}

export class GitRunner {
  constructor(private readonly opts: GitRunnerOptions) {}

  /** Run git, throwing on non-zero. */
  async run(args: readonly string[], cwd: string): Promise<GitResult> {
    const result = await this.tryRun(args, cwd)
    if (result.exitCode !== 0) throw new GitError(args, result)
    return result
  }

  /** Run git, returning the failure instead of throwing. */
  async tryRun(args: readonly string[], cwd: string): Promise<GitResult> {
    this.opts.onCommand?.(`git ${args.join(' ')}`)

    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: this.opts.home,
      // Never block on a prompt nobody can answer.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: this.opts.identity.name,
      GIT_AUTHOR_EMAIL: this.opts.identity.email,
      GIT_COMMITTER_NAME: this.opts.identity.name,
      GIT_COMMITTER_EMAIL: this.opts.identity.email,
      // Stable output regardless of the host's locale.
      LC_ALL: 'C',
      ...this.opts.env,
    }

    const configArgs: string[] = []
    if (this.opts.credentialHelper) {
      // Clear inherited helpers first: an empty value resets the list, so a developer's
      // osxkeychain helper cannot answer for us.
      configArgs.push('-c', 'credential.helper=')
      configArgs.push('-c', `credential.helper=${this.opts.credentialHelper}`)
    }

    return new Promise((resolve, reject) => {
      const child = spawn('git', [...configArgs, ...args], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      const timeout = setTimeout(() => child.kill('SIGKILL'), (this.opts.timeoutSec ?? 600) * 1000)
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on('close', (exitCode) => {
        clearTimeout(timeout)
        resolve({ exitCode: exitCode ?? -1, stdout, stderr })
      })
    })
  }
}
