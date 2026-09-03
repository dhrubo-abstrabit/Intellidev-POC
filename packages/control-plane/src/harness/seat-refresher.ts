import type { HarnessId } from '@intellidev/shared'
import type { SeatStore, SpaceScope } from './seat-store.js'
import {
  RefreshTokenRejected,
  canStillRefresh,
  needsRefresh,
  refresherFor,
  type HarnessRefresher,
  type SeatExpiry,
} from './refresh.js'

/**
 * Refreshes a seat, once, no matter how many things ask at the same time.
 *
 * The single-flight guard is the whole point. Refreshing rotates the refresh token, so two
 * refreshes of the same seat produce two new tokens and invalidate each other — the second
 * request would succeed, the first one's token would be dead, and whichever container held it
 * would fail mid-run with an error that looks like an expired subscription.
 *
 * Two layers, because there are two kinds of concurrency:
 *
 *  - **In this process**, an in-flight promise is shared: ten runs dispatched at once make one
 *    HTTP call and all wait on it.
 *  - **Across processes**, a caller can supply a lock. With more than one control-plane task,
 *    two instances would otherwise refresh simultaneously and the loser's runs would break in a
 *    way no log would explain.
 */
export interface SeatRefresherOptions {
  accounts: SeatStore
  /**
   * Serialises refreshes of one seat across every instance.
   *
   * Optional because a single-instance deployment and the test suite do not need it, and a lock
   * that is not there is better than one that pretends. `PostgresStore.withSeatLock` supplies
   * the real one.
   */
  lock?: <T>(scope: SpaceScope, harness: HarnessId, body: () => Promise<T>) => Promise<T>
  fetchImpl?: typeof fetch
  now?: () => Date
  /** Told about refreshes, so an operator can see them without reading the database. */
  onEvent?: (event: SeatRefreshEvent) => void
}

export interface SeatRefreshEvent {
  harness: HarnessId
  outcome: 'refreshed' | 'still-fresh' | 'failed' | 'needs-login'
  detail?: string
}

export class SeatRefresher {
  /** In-flight refreshes, keyed by space and harness. */
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly opts: SeatRefresherOptions) {}

  /**
   * Make sure this seat is usable, refreshing if it is close to expiry.
   *
   * Called before a run is handed its credential, so a container never receives a token that
   * will expire while it is working — and never has to refresh one itself, which is what makes
   * two concurrent runs safe.
   */
  async ensureFresh(scope: SpaceScope, harness: HarnessId): Promise<void> {
    const key = `${scope.clientSpaceId}:${harness}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const attempt = this.refreshIfNeeded(scope, harness).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, attempt)
    return attempt
  }

  /**
   * Store a credential a run's harness rotated, if it is newer than what we hold.
   *
   * The newness check is the whole safety of this path. Two containers can rotate in either
   * order and report in the other; accepting blindly would let the older bundle land last and
   * overwrite a working credential with one the provider has already invalidated — strictly
   * worse than never having accepted a write-back at all.
   *
   * Compared by the harness's own expiry rather than by arrival time, because arrival order says
   * nothing about which token the provider considers current.
   */
  async accept(
    scope: SpaceScope,
    harness: HarnessId,
    files: Array<{ path: string; contents: string }>,
  ): Promise<{ stored: boolean; reason?: string }> {
    const refresher = refresherFor(harness)
    if (!refresher) return { stored: false, reason: 'no refresher for this harness' }

    const name = refresher.path.split('/').pop()!
    const incoming = files.find((file) => file.path.endsWith(name))
    if (!incoming) return { stored: false, reason: `no ${name} in the report` }

    let incomingExpiry
    try {
      incomingExpiry = refresher.expiryOf(incoming.contents).accessExpiresAt
    } catch {
      // Unparseable is not a credential. Storing it would break every future run to honour a
      // report that told us nothing.
      return { stored: false, reason: 'the reported credential could not be parsed' }
    }
    if (!incomingExpiry) return { stored: false, reason: 'the reported credential has no expiry' }

    const run = async () => {
      // Read inside the lock, so the comparison is against what is stored *now* rather than
      // what was stored when this request arrived.
      const currentContents = await this.contentsOf(scope, harness, refresher)
      const current = currentContents
        ? (() => {
            try {
              return refresher.expiryOf(currentContents).accessExpiresAt
            } catch {
              return undefined
            }
          })()
        : undefined

      if (current && current.getTime() >= incomingExpiry.getTime()) {
        this.emit({
          harness,
          outcome: 'still-fresh',
          detail: 'a newer credential is already stored',
        })
        return { stored: false, reason: 'a newer credential is already stored' }
      }

      await this.opts.accounts.connect(scope, {
        harness,
        label: harness,
        files: [{ path: refresher.path, contents: incoming.contents }],
        connectedAt: new Date().toISOString(),
        importedFrom: 'rotated by a run and reported back',
      })
      this.emit({
        harness,
        outcome: 'refreshed',
        detail: `rotated by a run; valid until ${incomingExpiry.toISOString()}`,
      })
      return { stored: true }
    }

    return this.opts.lock ? this.opts.lock(scope, harness, run) : run()
  }

  /** What the seat's own file says about its freshness, without refreshing anything. */
  async inspect(scope: SpaceScope, harness: HarnessId): Promise<SeatExpiry | undefined> {
    const refresher = refresherFor(harness)
    if (!refresher) return undefined
    const contents = await this.contentsOf(scope, harness, refresher)
    if (contents === undefined) return undefined
    try {
      return refresher.expiryOf(contents)
    } catch {
      return undefined
    }
  }

  private async refreshIfNeeded(scope: SpaceScope, harness: HarnessId): Promise<void> {
    const refresher = refresherFor(harness)
    if (!refresher) return

    const run = async () => {
      /**
       * Re-read inside the lock, not before it.
       *
       * Whoever held the lock first has very likely just refreshed this seat, and acting on the
       * copy read before waiting would refresh a token that was already rotated — turning the
       * lock from a guard into a delay.
       */
      const contents = await this.contentsOf(scope, harness, refresher)
      if (contents === undefined) return

      let expiry: SeatExpiry
      try {
        expiry = refresher.expiryOf(contents)
      } catch (error) {
        // A credential we cannot parse is not one we can refresh. Left alone: the run will fail
        // with the harness's own message, which says more than a parse error would.
        this.emit({ harness, outcome: 'failed', detail: `unreadable credential: ${String(error)}` })
        return
      }

      const now = this.opts.now?.() ?? new Date()
      if (!needsRefresh(expiry, now)) {
        this.emit({ harness, outcome: 'still-fresh' })
        return
      }
      if (!canStillRefresh(expiry, now)) {
        // Past this there is nothing to do but ask a person, and saying so is more useful than
        // an HTTP error from a token that cannot work.
        this.emit({
          harness,
          outcome: 'needs-login',
          detail: 'the refresh token has expired; sign in again',
        })
        return
      }

      try {
        const refreshed = await refresher.refresh(contents, this.opts.fetchImpl)
        await this.opts.accounts.connect(scope, {
          harness,
          label: harness,
          files: [{ path: refresher.path, contents: refreshed.contents }],
          connectedAt: new Date().toISOString(),
          importedFrom: 'refreshed by the control plane',
        })
        this.emit({
          harness,
          outcome: 'refreshed',
          detail: `valid until ${refreshed.expiresAt.toISOString()}`,
        })
      } catch (error) {
        /**
         * A rejected refresh token is a different answer from a failed request.
         *
         * `invalid_grant` means it was already redeemed and can never work again, so retrying
         * it every three hours is a guaranteed-useless call until somebody notices. Reported as
         * needing a login, which is the only thing that actually fixes it.
         */
        if (error instanceof RefreshTokenRejected) {
          this.emit({
            harness,
            outcome: 'needs-login',
            detail: 'the stored refresh token was rejected; sign in again',
          })
          return
        }
        /**
         * Any other failed refresh leaves the stored credential alone.
         *
         * The old token may still have life in it, and replacing it with nothing would turn a
         * recoverable state into a seat that certainly cannot work. The run then fails with the
         * harness's own message, which is the honest one.
         */
        this.emit({
          harness,
          outcome: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return this.opts.lock ? this.opts.lock(scope, harness, run) : run()
  }

  private async contentsOf(
    scope: SpaceScope,
    harness: HarnessId,
    refresher: HarnessRefresher,
  ): Promise<string | undefined> {
    const material = await this.opts.accounts.material(scope, harness)
    const files = (material?.['files'] ?? []) as Array<{ path: string; contents: string }>
    // Matched by suffix: the stored path is the harness's own, and a leading slash or a `~`
    // should not decide whether a seat can be kept alive.
    return files.find((file) => file.path.endsWith(refresher.path.split('/').pop()!))?.contents
  }

  private emit(event: SeatRefreshEvent): void {
    this.opts.onEvent?.(event)
  }
}
