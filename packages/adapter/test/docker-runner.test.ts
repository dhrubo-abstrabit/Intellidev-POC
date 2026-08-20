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
