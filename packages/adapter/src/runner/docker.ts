import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { RunHandle, Runner, RunLaunchSpec, RunOutcome } from './types.js'

/**
 * Launches a run in a local Docker container.
 *
 * Uses the `docker` CLI rather than the Engine API over a socket. That is a deliberate
 * choice for the local path: it needs no extra dependency, it respects whatever Docker
 * context the developer already has configured, and the command it runs is the command you
 * would type — which makes a failing launch debuggable by copy-paste.
 *
 * **The host socket is never mounted into the container.** The runner talks to Docker; the
 * container does not. Mounting `/var/run/docker.sock` would hand model-authored code root
 * on the host, and it is the one shortcut this design exists to avoid.
 */
export interface DockerRunnerOptions {
  binary?: string
  /** Extra flags for local experiments. Never used for security-relevant settings. */
  extraArgs?: readonly string[]
  /** Off by default: a run needs the network for git and model APIs. */
  network?: string
}

/**
 * Env var names whose values must never reach a log.
 *
 * A denylist by suffix rather than an allowlist, because the set grows: every provider key,
 * every MCP token and the run token all arrive here as `--env NAME=value`. Matching on the
 * shape of the name means a new secret is redacted by default rather than when someone
 * remembers to add it.
 */
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|MATERIAL|CREDENTIAL)S?$/i

/**
 * Messages that mean the container never ran.
 *
 * Matched on shape rather than exit code, because the obvious discriminator does not work:
 * a dead daemon makes the client exit **1**, not 125, and 1 is also a perfectly ordinary
 * container exit code. Discriminating on the code would either miss the daemon case or
 * treat every failed run as a launch failure.
 *
 * A pattern list is the honest tool here. These are the Docker *client's* own errors, which
 * a container cannot produce because it does not exist yet — so matching one is proof the
 * message is Docker's and not the run's.
 */
const LAUNCH_FAILURE_PATTERNS = [
  /cannot connect to the docker daemon/i,
  /is the docker daemon running/i,
  /permission denied while trying to connect to the docker daemon/i,
  /error response from daemon/i,
  /unable to find image/i,
  /invalid reference format/i,
  /no such file or directory.*docker\.sock/i,
  /exec:.*not found/i,
]

/**
 * Explains a failure a human can act on, without turning the run log into a leak.
 *
 * stderr is surfaced **only** when it matches a Docker client error. For a container that
 * ran, stderr is whatever the adapter and the harness printed, and copying that into a
 * stored reason would put arbitrary run output — potentially a token a harness echoed — into
 * a row that outlives the run. Its explanation belongs in the event stream instead.
 */
function reasonFor(
  code: number | null,
  timedOut: boolean,
  stderrTail: string,
): { reason?: string } {
  if (timedOut) return { reason: 'exceeded wall clock' }
  if (code === null || code === 0) return {}

  const line = stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => LAUNCH_FAILURE_PATTERNS.some((pattern) => pattern.test(l)))

  return line ? { reason: `container did not start: ${line}` } : {}
}

/** Replaces secret env values in an argv, keeping the names. */
export function redactArgv(argv: readonly string[]): string[] {
  return argv.map((arg, index) => {
    // Only the value half of an `--env NAME=value` pair, so a path or an image reference
    // that happens to contain "key" is left alone.
    if (argv[index - 1] !== '--env') return arg
    const eq = arg.indexOf('=')
    if (eq < 0) return arg
    const name = arg.slice(0, eq)
    return SECRET_NAME.test(name) ? `${name}=<redacted>` : arg
  })
}

export class DockerRunner implements Runner {
  readonly kind = 'docker' as const

  constructor(private readonly opts: DockerRunnerOptions = {}) {}

  /** The exact argv, exposed so a failing launch can be reproduced by hand. */
  buildArgs(spec: RunLaunchSpec, containerName: string): string[] {
    const args = ['run', '--rm', '--name', containerName]

    // Identity is baked into the image (uid 10001). Stated here so a stray `--user root`
    // in extraArgs is visibly overriding a decision rather than quietly filling a gap.
    args.push('--init')

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }
    for (const mount of spec.mounts ?? []) {
      args.push(
        '--mount',
        `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
      )
    }
    if (spec.cacheVolume) {
      // A named volume, so the git mirror and package caches survive between runs — the
      // local stand-in for the S3 cache the deployed path uses.
      args.push(
        '--mount',
        `type=volume,source=${spec.cacheVolume.name},target=${spec.cacheVolume.target}`,
      )
    }

    if (spec.cpus) args.push('--cpus', String(spec.cpus))
    if (spec.memoryMb) args.push('--memory', `${spec.memoryMb}m`)
    // A fork bomb in generated code should hit a ceiling, not the host's process table.
    args.push('--pids-limit', '512')
    if (this.opts.network) args.push('--network', this.opts.network)

    args.push(...(this.opts.extraArgs ?? []))
    args.push(spec.image, ...spec.args)
    return args
  }

  /**
   * Spawns the container and returns as soon as it has a name.
   *
   * `docker run` blocks until the container exits, so the outcome promise wraps the child
   * rather than the call: the handle is available immediately, which is what the interface
   * requires and what lets dispatch record it before the run finishes.
   */
  async start(spec: RunLaunchSpec): Promise<RunHandle> {
    const containerName = `intellidev-${spec.runId}-${randomBytes(3).toString('hex')}`
    const args = this.buildArgs(spec, containerName)
    spec.onArgv?.(redactArgv([this.opts.binary ?? 'docker', ...args]))

    const child = spawn(this.opts.binary ?? 'docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let timedOut = false

    /**
     * The tail of stderr, kept only to explain a launch that never became a container.
     *
     * Bounded, because a chatty run would otherwise hold its whole log in memory for a
     * string that is at most a sentence.
     */
    let stderrTail = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => spec.onOutput?.('stdout', chunk))
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000)
      spec.onOutput?.('stderr', chunk)
    })

    const timer = spec.timeoutSec
      ? setTimeout(() => {
          timedOut = true
          // Stop the container, not just the client: killing `docker run` leaves the
          // container running and still billing.
          void this.stop(containerName)
        }, spec.timeoutSec * 1000)
      : null

    const outcome = new Promise<RunOutcome>((resolve, reject) => {
      child.on('error', (error) => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({
          runId: spec.runId,
          exitCode: code,
          timedOut,
          ...reasonFor(code, timedOut, stderrTail),
        })
      })
    })

    return { runId: spec.runId, handle: containerName, outcome }
  }

  async stop(handle: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const child = spawn(this.opts.binary ?? 'docker', ['stop', '--time', '10', handle], {
        stdio: 'ignore',
      })
      child.on('close', () => resolve())
      child.on('error', () => resolve())
    })
  }
}
