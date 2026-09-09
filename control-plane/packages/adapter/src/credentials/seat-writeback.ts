import { readFile, stat } from 'node:fs/promises'

/**
 * Reporting a credential the harness rotated behind our back.
 *
 * The control plane refreshes seats centrally so a run is handed a token that outlives it, which
 * removes the *reason* a container would refresh. It does not remove the *ability*: codex
 * refreshes reactively on a 401, and Claude Code would too if the headless bug that stops it were
 * ever fixed. Designing on the assumption that a harness never refreshes is designing on a
 * vendor's bug staying unfixed.
 *
 * When one does refresh, it rotates the token family. The container then holds a working
 * credential, and the copy in the database — the one every future run starts from — is dead. That
 * is not hypothetical: it is exactly the state the claude-code seat was found in, `invalid_grant`
 * on a token nothing in our code had ever refreshed.
 *
 * So the file is watched, and a change is reported back. Whoever rotates, the store learns.
 *
 * Polled rather than `fs.watch`: inotify watches are a per-container kernel resource, they are
 * silently unreliable over some overlay filesystems, and the file is a few hundred bytes. Five
 * seconds is far below the several minutes a run lasts and costs nothing worth measuring.
 */
export interface SeatWriteBackOptions {
  /** Absolute paths written from the seat, and what they held when written. */
  files: Array<{ path: string; contents: string }>
  /** Sends the changed file to the control plane. */
  report: (files: Array<{ path: string; contents: string }>) => Promise<void>
  intervalMs?: number
  /** Reports a problem without failing the run over it. */
  onError?: (error: Error) => void
}

export class SeatWriteBack {
  private timer?: ReturnType<typeof setInterval>
  private readonly seen = new Map<string, string>()
  private checking = false

  constructor(private readonly opts: SeatWriteBackOptions) {
    for (const file of opts.files) this.seen.set(file.path, file.contents)
  }

  start(): void {
    if (this.timer || this.opts.files.length === 0) return
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 5000)
    // Never the reason a finished run stays alive.
    this.timer.unref?.()
  }

  /**
   * Stops watching, after one last look.
   *
   * The final check matters more than the periodic ones: a harness that refreshes during its
   * last turn would otherwise have the rotation discarded with the container, which is the whole
   * failure this exists to prevent.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.check()
  }

  private async check(): Promise<void> {
    // Overlapping checks would report the same change twice, and the second report would carry
    // an older body than the first if the file were mid-write.
    if (this.checking) return
    this.checking = true
    try {
      const changed: Array<{ path: string; contents: string }> = []
      for (const [path, previous] of this.seen) {
        try {
          // A harness rewrites this file in place; a size check first avoids reading it every
          // five seconds for the overwhelmingly common case of nothing having happened.
          const info = await stat(path)
          if (info.size === 0) continue
          const current = await readFile(path, 'utf8')
          if (current === previous) continue
          // Parsed before reporting: a file caught mid-write is a real occurrence, and sending
          // half a JSON document would replace a working credential with a broken one.
          JSON.parse(current)
          this.seen.set(path, current)
          changed.push({ path, contents: current })
        } catch {
          // A missing or half-written file is not an error worth surfacing; the next poll sees
          // it whole.
          continue
        }
      }
      if (changed.length > 0) {
        await this.opts.report(changed).catch((error: Error) => this.opts.onError?.(error))
      }
    } finally {
      this.checking = false
    }
  }
}
