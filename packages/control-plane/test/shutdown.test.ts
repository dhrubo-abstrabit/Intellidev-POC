import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The control plane must exit when it is told to.
 *
 * FOUND BY RUNNING IT. `process.once('SIGTERM', () => reconciler.stop())` *replaces* Node's
 * default behaviour of exiting, so the signal stopped the reconciler and the process ran on for
 * ever. `kill` appeared to do nothing, the port stayed held, and the next start failed with
 * EADDRINUSE — twice, in this project, each time looking like a different problem.
 *
 * It matters beyond tidiness. ECS sends SIGTERM, waits the stop timeout, then SIGKILL: a task
 * that ignores the signal makes every deploy wait out the grace period and kills in-flight runs
 * rather than draining them.
 *
 * Spawned as a real process, because that is the only way to send it a real signal. Run in
 * memory with no database, so it is fast and needs nothing configured.
 */
describe('shutdown', () => {
  async function startServer(port: number) {
    const work = await mkdtemp(join(tmpdir(), 'idv-shutdown-'))
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', new URL('../src/main.ts', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          PORT: String(port),
          INTELLIDEV_MODE: 'inline',
          INTELLIDEV_WORK_ROOT: work,
          // Cleared so the process uses the in-memory store: this test is about signals, and a
          // database connection would make it slow and dependent on configuration.
          SUPABASE_CONNECTION_STRING_SESSION: '',
          INTELLIDEV_PROJECT_ID: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    // Wait for it to be listening rather than sleeping a fixed amount, which is wrong in both
    // directions on a machine under load.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 30_000)
      const watch = (chunk: Buffer) => {
        if (chunk.toString().includes('Intellidev control plane')) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stderr.on('data', watch)
      child.stdout.on('data', watch)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`server exited early with ${code}`))
      })
    })
    return child
  }

  /** Resolves with the exit code, or rejects if it outlives the deadline. */
  function exitsWithin(child: ReturnType<typeof spawn>, ms: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`still running ${ms}ms after the signal`))
      }, ms)
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
  }

  it('exits on SIGTERM instead of ignoring it', async () => {
    const child = await startServer(4321)
    child.kill('SIGTERM')
    // Generously more than a clean drain needs, and far less than ECS would wait.
    expect(await exitsWithin(child, 15_000)).toBe(0)
  }, 60_000)

  it('exits on SIGINT, so Ctrl-C works in a terminal', async () => {
    const child = await startServer(4322)
    child.kill('SIGINT')
    expect(await exitsWithin(child, 15_000)).toBe(0)
  }, 60_000)

  it('releases the port, so the next start is not EADDRINUSE', async () => {
    // The symptom that made this visible: a restart binding onto a process that never died.
    const first = await startServer(4323)
    first.kill('SIGTERM')
    await exitsWithin(first, 15_000)

    const second = await startServer(4323)
    second.kill('SIGTERM')
    expect(await exitsWithin(second, 15_000)).toBe(0)
  }, 90_000)
})
