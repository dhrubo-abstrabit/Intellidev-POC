/**
 * Expiry-aware credential cache.
 *
 * The reason this exists rather than a plain map: a GitHub installation token lives an
 * hour and runs routinely last longer. A `git push` at minute 90 must transparently get
 * a fresh token, or the whole run is wasted at the last step. Designs that inject a
 * token at boot discover this the hard way, at minute 61.
 *
 * Refresh happens **before** expiry by a safety margin, because a token that expires
 * mid-request has already failed.
 */

export const DEFAULT_SKEW_SEC = 60

interface Entry<T> {
  value: T
  expiresAtMs: number
  /** In-flight fetch, so concurrent callers share one round trip. */
  pending?: Promise<T>
}

export class CredentialCache {
  private readonly entries = new Map<string, Entry<unknown>>()
  private refreshes = 0

  constructor(
    private readonly skewSec = DEFAULT_SKEW_SEC,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** How many times a value was actually fetched, for tests and observability. */
  get refreshCount(): number {
    return this.refreshes
  }

  /**
   * Return a cached value, or fetch one.
   *
   * Concurrent callers for the same key share a single fetch: four git operations
   * starting at once should not mint four tokens.
   */
  async get<T>(key: string, fetch: () => Promise<T>, expiresAt: (value: T) => string): Promise<T> {
    const existing = this.entries.get(key) as Entry<T> | undefined

    if (existing?.pending) return existing.pending
    if (existing && !this.isStale(existing.expiresAtMs)) return existing.value

    const pending = (async () => {
      const value = await fetch()
      const expiresAtMs = Date.parse(expiresAt(value))
      this.entries.set(key, {
        value,
        // An unparseable expiry is treated as already stale rather than as forever:
        // re-fetching costs a round trip, trusting a bad date costs the run.
        expiresAtMs: Number.isNaN(expiresAtMs) ? 0 : expiresAtMs,
      })
      this.refreshes++
      return value
    })()

    this.entries.set(key, {
      value: existing?.value as T,
      expiresAtMs: existing?.expiresAtMs ?? 0,
      pending,
    })

    try {
      return await pending
    } catch (error) {
      // A failed fetch must not leave a poisoned pending promise behind.
      this.entries.delete(key)
      throw error
    }
  }

  /** Force the next `get` to fetch. Used when a 401 says our token died early. */
  invalidate(key: string): void {
    this.entries.delete(key)
  }

  private isStale(expiresAtMs: number): boolean {
    return this.now() + this.skewSec * 1000 >= expiresAtMs
  }
}
