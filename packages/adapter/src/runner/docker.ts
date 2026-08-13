import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Runner, RunLaunchResult, RunLaunchSpec } from './types.js'

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

  async launch(spec: RunLaunchSpec): Promise<RunLaunchResult> {
    const containerName = `intellidev-${spec.runId}-${randomBytes(3).toString('hex')}`
    const args = this.buildArgs(spec, containerName)
    spec.onArgv?.([this.opts.binary ?? 'docker', ...args])

    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binary ?? 'docker', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let timedOut = false

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => spec.onOutput?.('stdout', chunk))
      child.stderr.on('data', (chunk: string) => spec.onOutput?.('stderr', chunk))

      const timer = spec.timeoutSec
        ? setTimeout(() => {
            timedOut = true
            // Stop the container, not just the client: killing `docker run` leaves the
            // container running and still billing.
            void this.stop(containerName)
          }, spec.timeoutSec * 1000)
        : null

      child.on('error', (error) => {
        if (timer) clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({
          runId: spec.runId,
          exitCode: code ?? -1,
          timedOut,
          handle: containerName,
        })
      })
    })
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
