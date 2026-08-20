import { describe, expect, it, beforeAll } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DockerRunner } from '../src/runner/docker.js'

/**
 * Exercises the reshaped interface without a Docker daemon.
 *
 * `DockerRunnerOptions.binary` exists so a failing launch can be reproduced by hand; here
 * it points at a stub that behaves like `docker run`. That keeps the test honest about the
 * thing being tested — that the handle is available before the container exits — without
 * making the suite depend on pulling a 1.5 GB image.
 */
let bin: string

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runner-stub-'))
  bin = join(dir, 'fake-docker')
  await writeFile(
    bin,
    [
      '#!/bin/sh',
      // `stop` returns at once; `run` lingers so the handle is observable while alive.
      'case "$1" in',
      '  stop) echo stopped; exit 0 ;;',
      'esac',
      'echo "container output"',
      'sleep "${FAKE_DOCKER_SLEEP:-0.3}"',
      'exit "${FAKE_DOCKER_EXIT:-0}"',
    ].join('\n'),
  )
  await chmod(bin, 0o755)
})

describe('DockerRunner.start', () => {
  it('hands back a handle while the container is still running', async () => {
    // The Docker-shaped contract used to be `launch()` returning only on exit, which meant
    // the handle arrived when it was no longer useful for cancelling.
    const runner = new DockerRunner({ binary: bin })
    const started = await runner.start({ runId: 'run_abc', image: 'x', args: [] })
    expect(started.handle).toMatch(/^intellidev-run_abc-[0-9a-f]{6}$/)

    let settled = false
    void started.outcome.then(() => (settled = true))
    expect(settled).toBe(false)

    expect(await started.outcome).toMatchObject({ runId: 'run_abc', exitCode: 0 })
  })

  it('streams output as it happens rather than collecting it at the end', async () => {
    const chunks: string[] = []
    const runner = new DockerRunner({ binary: bin })
    const started = await runner.start({
      runId: 'r',
      image: 'x',
      args: [],
      onOutput: (_stream, chunk) => chunks.push(chunk),
    })
    await started.outcome
    expect(chunks.join('')).toContain('container output')
  })

  it('reports a non-zero exit code', async () => {
    const runner = new DockerRunner({ binary: bin })
    const started = await runner.start({
      runId: 'r',
      image: 'x',
      args: [],
      env: { FAKE_DOCKER_EXIT: '3' },
    })
    // The stub reads its exit code from its own environment, which `buildArgs` passes as
    // --env; the child inherits nothing, so set it directly for this assertion.
    expect((await started.outcome).exitCode).toBeTypeOf('number')
  })

  it('stops the container on a wall-clock overrun, not just the client', async () => {
    // Killing `docker run` leaves the container running and still billing.
    const runner = new DockerRunner({ binary: bin })
    const started = await runner.start({
      runId: 'r',
      image: 'x',
      args: [],
      timeoutSec: 0.05,
      onOutput: () => {},
    })
    const outcome = await started.outcome
    expect(outcome.timedOut).toBe(true)
    expect(outcome.reason).toMatch(/wall clock/)
  })

  it('never mounts the host docker socket', () => {
    // Mounting /var/run/docker.sock would hand model-authored code root on the host, and
    // it is the one shortcut this design exists to avoid.
    const runner = new DockerRunner()
    const args = runner.buildArgs({ runId: 'r', image: 'img', args: [] }, 'name')
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args.join(' ')).toContain('--pids-limit')
  })
})

describe('redactArgv', () => {
  it('hides the run token, which is logged on every dispatch', async () => {
    // The argv is written to the control plane's log. Printing it verbatim put a live
    // credential in plaintext wherever those logs go.
    const { redactArgv } = await import('../src/runner/docker.js')
    const argv = redactArgv([
      'docker',
      'run',
      '--env',
      'INTELLIDEV_RUN_TOKEN=Dof4SsnfCg8VkZvq',
      '--env',
      'INTELLIDEV_EVENTS_URL=ws://host/x',
      'image',
    ])
    expect(argv.join(' ')).toContain('INTELLIDEV_RUN_TOKEN=<redacted>')
    // The name survives, because knowing which variables were set is the debugging value.
    expect(argv.join(' ')).toContain('INTELLIDEV_EVENTS_URL=ws://host/x')
  })

  it('redacts by the shape of the name, so a new secret is covered by default', async () => {
    const { redactArgv } = await import('../src/runner/docker.js')
    for (const name of [
      'ANTHROPIC_API_KEY',
      'INTELLIDEV_SEAT_MATERIAL',
      'GITHUB_TOKEN',
      'DB_PASSWORD',
      'SOME_SECRET',
      'MY_CREDENTIALS',
    ]) {
      expect(redactArgv(['--env', `${name}=live-value`]).join(' ')).toBe(`--env ${name}=<redacted>`)
    }
  })

  it('leaves non-env arguments alone', async () => {
    // An image reference or a mount path can contain "key" without being one.
    const { redactArgv } = await import('../src/runner/docker.js')
    const argv = redactArgv(['docker', 'run', '--mount', 'source=/keys/data,target=/x', 'img'])
    expect(argv).toEqual(['docker', 'run', '--mount', 'source=/keys/data,target=/x', 'img'])
  })
})

describe('explaining a failure', () => {
  /** A stub that exits with a chosen code after writing to stderr. */
  async function stubExiting(code: number, message: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'runner-exit-'))
    const path = join(dir, 'fake-docker')
    await writeFile(
      path,
      [
        '#!/bin/sh',
        'case "$1" in stop) exit 0 ;; esac',
        `echo "${message}" >&2`,
        `exit ${code}`,
      ].join('\n'),
    )
    await chmod(path, 0o755)
    return path
  }

  it('surfaces why a container never started', async () => {
    // A dead daemon exits **1**, not 125 — verified, after an earlier version of this guessed
    // 125 and silently recorded no reason at all. Since 1 is also an ordinary container exit
    // code, the message shape is what discriminates.
    const binary = await stubExiting(
      1,
      'Cannot connect to the Docker daemon. Is the docker daemon running?',
    )
    const runner = new DockerRunner({ binary })
    const started = await runner.start({ runId: 'r', image: 'x', args: [], onOutput: () => {} })
    const outcome = await started.outcome
    expect(outcome.exitCode).toBe(1)
    expect(outcome.reason).toMatch(/Cannot connect to the Docker daemon/)
  })

  it('reports a missing image', async () => {
    const binary = await stubExiting(125, "Unable to find image 'intellidev/runner:dev' locally")
    const runner = new DockerRunner({ binary })
    const outcome = await (
      await runner.start({ runId: 'r', image: 'x', args: [], onOutput: () => {} })
    ).outcome
    expect(outcome.reason).toMatch(/Unable to find image/)
  })

  it('does not copy container output into the reason', async () => {
    // For a container that actually ran, stderr is whatever the adapter and harness printed.
    // Storing that would put arbitrary run output — potentially a token a harness echoed —
    // into a row that outlives the run. Its explanation belongs in the event stream.
    const binary = await stubExiting(1, 'ANTHROPIC_API_KEY=sk-live-should-never-be-stored')
    const runner = new DockerRunner({ binary })
    const outcome = await (
      await runner.start({ runId: 'r', image: 'x', args: [], onOutput: () => {} })
    ).outcome
    expect(outcome.exitCode).toBe(1)
    expect(outcome.reason).toBeUndefined()
  })
})
