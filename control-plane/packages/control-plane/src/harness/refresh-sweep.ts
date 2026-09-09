import type { HarnessId } from '@intellidev/shared'
import type { SeatRefresher, SeatRefreshEvent } from './seat-refresher.js'
import type { SeatStore, SpaceScope } from './seat-store.js'

/**
 * Keeps seats alive while nothing is running.
 *
 * Refreshing before a run is enough only if runs keep happening. They do not: a weekend with no
 * dispatches is longer than an access token lives, and — worse — long enough to approach the
 * refresh token's own expiry, past which no amount of automation helps and a person has to sign
 * in again. The failure is silent until the next dispatch, which is the worst possible moment to
 * discover it.
 *
 * So the control plane refreshes on a timer as well as on demand. The two paths share one
 * `SeatRefresher`, so the single-flight guard covers both: a sweep and a dispatch that coincide
 * do not rotate the same token twice.
 *
 * The interval is a fraction of the shortest thing being kept alive. Claude Code's access token
 * lasts about eight hours, so a few hours between sweeps leaves several chances to recover from
 * a transient failure before anything expires — and a missed sweep is then unremarkable rather
 * than the beginning of an outage.
 */
export interface RefreshSweepOptions {
  accounts: Pick<SeatStore, 'list'>
  refresher: Pick<SeatRefresher, 'ensureFresh'>
  /** The spaces to keep alive. Today the one this control plane serves. */
  scopes: () => SpaceScope[]
  intervalMs?: number
  onEvent?: (event: SeatRefreshEvent & { scope: string }) => void
  /** Injected so a test can drive time rather than wait for it. */
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

/** Three hours: several attempts inside the eight-hour life of the shortest-lived token. */
export const DEFAULT_SWEEP_INTERVAL_MS = 3 * 3600 * 1000

export class RefreshSweep {
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(private readonly opts: RefreshSweepOptions) {}

  /**
   * Starts sweeping, beginning immediately.
   *
   * The first sweep is not deferred by an interval: a restart is exactly when a seat is most
   * likely to have gone stale, because the process was not there to refresh it.
   */
  start(): void {
    if (this.timer) return
    const setIntervalFn = this.opts.setIntervalImpl ?? setInterval
    void this.sweep()
    this.timer = setIntervalFn(
      () => void this.sweep(),
      this.opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    )
    // Never hold the process open: a control plane that has been told to stop should not wait
    // out a three-hour timer to do it.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    ;(this.opts.clearIntervalImpl ?? clearInterval)(this.timer)
    this.timer = undefined
  }

  /**
   * One pass over every connected seat.
   *
   * Guarded against overlap: a sweep that is slow — a provider timing out, several spaces —
   * must not have the next tick start a second one behind it, since both would then queue on
   * the same locks and the queue would only grow.
   */
  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const scope of this.opts.scopes()) {
        let seats
        try {
          seats = await this.opts.accounts.list(scope)
        } catch (error) {
          // A database that is briefly unreachable is not worth stopping the sweep for; the
          // next tick tries again.
          this.opts.onEvent?.({
            scope: scope.clientSpaceId,
            harness: 'claude-code',
            outcome: 'failed',
            detail: `could not list seats: ${describe(error)}`,
          })
          continue
        }

        for (const seat of seats) {
          // A seat whose ciphertext cannot even be opened is not a refresh problem — it needs a
          // person, and trying would only produce a confusing error every three hours.
          if (seat.readable === false) continue
          try {
            await this.opts.refresher.ensureFresh(scope, seat.harness as HarnessId)
          } catch (error) {
            this.opts.onEvent?.({
              scope: scope.clientSpaceId,
              harness: seat.harness,
              outcome: 'failed',
              detail: describe(error),
            })
          }
        }
      }
    } finally {
      this.running = false
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
