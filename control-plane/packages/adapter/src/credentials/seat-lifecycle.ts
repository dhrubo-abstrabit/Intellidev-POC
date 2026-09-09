import type { SeatCredential } from './types.js'

/**
 * Keeping a run's harness credential valid for as long as the run lasts.
 *
 * The control plane hands out a token that is fresh when the run starts, which is enough for a
 * run that finishes inside the refresh margin. It is not enough in general: the margin is ninety
 * minutes and a hard task can take longer, at which point the token expires somewhere in the
 * middle. Claude Code will not refresh it — it cannot, run headless — so the run would fail
 * partway through having done most of the work.
 *
 * So the container asks again before the credential dies, which is what the broker was built for:
 * "a run re-asks cheaply". The refresh happens centrally on that ask, under the same lock as
 * everything else, so a long run is a series of fresh tokens rather than one that has to last.
 * Nothing here refreshes anything itself; asking is the whole mechanism.
 */
export interface SeatLifecycleOptions {
  /** Asks the control plane for the current credential. Refreshes centrally as a side effect. */
  fetchSeat: () => Promise<SeatCredential>
  /** Writes the material into the harness's own files and returns any env it needs. */
  materialise: (credential: SeatCredential) => Promise<unknown>
  /**
   * How long before expiry to renew.
   *
   * Long enough that a slow control plane or a retried request still lands before the token dies,
   * short enough that a normal run never renews at all.
   */
  renewBeforeMs?: number
  /** How often to look. Cheap: a comparison against a stored timestamp. */
  checkIntervalMs?: number
  onRenew?: (expiresAt: string) => void
  onError?: (error: Error) => void
  now?: () => number
}

export class SeatLifecycle {
  private timer?: ReturnType<typeof setInterval>
  private expiresAt?: number
  private renewing = false

  constructor(private readonly opts: SeatLifecycleOptions) {}

  /** Records the expiry of the credential the run started with. */
  observe(credential: SeatCredential): void {
    const parsed = Date.parse(credential.expiresAt)
    this.expiresAt = Number.isNaN(parsed) ? undefined : parsed
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.maybeRenew(), this.opts.checkIntervalMs ?? 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async maybeRenew(): Promise<void> {
    if (this.renewing || this.expiresAt === undefined) return
    const now = this.opts.now?.() ?? Date.now()
    if (this.expiresAt - now > (this.opts.renewBeforeMs ?? 10 * 60_000)) return

    this.renewing = true
    try {
      const credential = await this.opts.fetchSeat()
      const parsed = Date.parse(credential.expiresAt)
      /**
       * A renewal that did not move the expiry forward is not a renewal.
       *
       * It means the control plane could not refresh — the provider is down, or the seat needs a
       * human. Accepting it and rewriting the same file would just have this fire again a minute
       * later, and then every minute, for the rest of the run.
       */
      if (Number.isNaN(parsed) || (this.expiresAt !== undefined && parsed <= this.expiresAt)) {
        // Backed off to the original expiry so the next attempt is not immediate. The run may
        // still finish in time; if not, the harness's own error is the honest one.
        this.expiresAt = Number.isNaN(parsed) ? undefined : this.expiresAt
        return
      }
      await this.opts.materialise(credential)
      this.expiresAt = parsed
      this.opts.onRenew?.(credential.expiresAt)
    } catch (error) {
      // Never fatal. The credential in place is still valid until it is not, and a failed
      // renewal that killed the run would be worse than the expiry it was trying to avoid.
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.renewing = false
    }
  }
}
