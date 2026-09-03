import { describe, expect, it, vi } from 'vitest'
import { SeatRefresher } from '../src/harness/seat-refresher.js'
import { RefreshSweep } from '../src/harness/refresh-sweep.js'
import {
  canStillRefresh,
  claudeCodeRefresher,
  codexRefresher,
  needsRefresh,
  REFRESH_MARGIN_MS,
} from '../src/harness/refresh.js'
import type { HarnessAccount, HarnessAccountPublic } from '../src/harness/accounts.js'
import type { SeatStore, SpaceScope } from '../src/harness/seat-store.js'

/**
 * Keeping a shared harness seat alive.
 *
 * The behaviour under test is not "a token can be refreshed" but the three things that made
 * refreshing necessary and dangerous at once:
 *
 *  - the stored token silently ages out while nothing runs;
 *  - Claude Code will not refresh itself when run headless, so nothing else will do it;
 *  - refreshing rotates the refresh token, so two refreshes of one seat invalidate each other.
 *
 * The third is why these tests are mostly about concurrency.
 */
const SCOPE: SpaceScope = { clientSpaceId: 'space-1' }
const HOUR = 3600 * 1000

function claudeFile(opts: { expiresInMs: number; refresh?: string; refreshExpiresInMs?: number }) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-1',
      refreshToken: opts.refresh ?? 'refresh-1',
      expiresAt: Date.now() + opts.expiresInMs,
      refreshTokenExpiresAt: Date.now() + (opts.refreshExpiresInMs ?? 28 * 24 * HOUR),
      scopes: 'user:inference',
    },
  })
}

/** A seat store that records every write, so rotation can be followed. */
function seatStore(initial: string) {
  const stored: HarnessAccount[] = [
    {
      harness: 'claude-code',
      label: 'claude-code',
      files: [{ path: '.claude/.credentials.json', contents: initial }],
      connectedAt: new Date().toISOString(),
    },
  ]
  const store: SeatStore = {
    async list(): Promise<HarnessAccountPublic[]> {
      return stored.map((a) => ({
        harness: a.harness,
        label: a.label,
        envVars: [],
        files: (a.files ?? []).map((f) => f.path),
        connectedAt: a.connectedAt,
        readable: true,
      }))
    },
    async has() {
      return stored.length > 0
    },
    async material() {
      const latest = stored.at(-1)!
      return { files: latest.files }
    },
    async connect(_scope, account) {
      stored.push(account)
    },
    async remove() {
      return true
    },
  }
  return { store, stored, current: () => stored.at(-1)!.files![0]!.contents }
}

describe('deciding when a seat needs refreshing', () => {
  it('refreshes well before expiry, not at it', () => {
    // A run can last the better part of an hour. A token that is valid *now* but expires in ten
    // minutes fails the stage rather than the request, which is far more expensive.
    expect(needsRefresh({ accessExpiresAt: new Date(Date.now() + 10 * 60 * 1000) })).toBe(true)
    expect(needsRefresh({ accessExpiresAt: new Date(Date.now() + REFRESH_MARGIN_MS + HOUR) })).toBe(
      false,
    )
  })

  it('knows when only a human can help', () => {
    // Past the refresh token's own expiry there is nothing to exchange, and saying so beats
    // producing an HTTP error every three hours for ever.
    expect(canStillRefresh({ refreshExpiresAt: new Date(Date.now() - HOUR) })).toBe(false)
    expect(canStillRefresh({ refreshExpiresAt: new Date(Date.now() + HOUR) })).toBe(true)
    // No stated expiry means no reason to give up.
    expect(canStillRefresh({})).toBe(true)
  })

  it('reads the expiry Claude Code actually writes', () => {
    const expiry = claudeCodeRefresher.expiryOf(claudeFile({ expiresInMs: 8 * HOUR }))
    expect(expiry.accessExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * HOUR)
    expect(expiry.refreshExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 27 * 24 * HOUR)
  })

  it('judges codex by last_refresh, which is the field it keeps', () => {
    // Codex stores no token expiry at all; it decides staleness from how long ago it last
    // refreshed, so that is what has to be read.
    const fresh = codexRefresher.expiryOf(
      JSON.stringify({ tokens: { refresh_token: 'r' }, last_refresh: new Date().toISOString() }),
    )
    expect(needsRefresh(fresh)).toBe(false)

    const old = codexRefresher.expiryOf(
      JSON.stringify({
        tokens: { refresh_token: 'r' },
        last_refresh: new Date(Date.now() - 9 * 24 * HOUR).toISOString(),
      }),
    )
    expect(needsRefresh(old)).toBe(true)
  })
})

describe('refreshing a seat', () => {
  it('stores the rotated refresh token, or the next refresh fails', async () => {
    /**
     * The endpoint returns a *new* refresh token and invalidates the old one. Storing only the
     * access token would work exactly once and then leave a seat that cannot be recovered
     * without a human — which is the failure this whole mechanism exists to prevent.
     */
    const { store, current } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 28800 }),
    ) as unknown as typeof fetch

    await new SeatRefresher({ accounts: store, fetchImpl }).ensureFresh(SCOPE, 'claude-code')

    const stored = JSON.parse(current()).claudeAiOauth
    expect(stored.accessToken).toBe('access-2')
    expect(stored.refreshToken).toBe('refresh-2')
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 7 * HOUR)
  })

  it('keeps the old refresh token when the server does not rotate', async () => {
    // Replacing a working token with undefined would break the seat far more thoroughly than
    // not refreshing it at all.
    const { store, current } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'access-2', expires_in: 28800 }),
    ) as unknown as typeof fetch

    await new SeatRefresher({ accounts: store, fetchImpl }).ensureFresh(SCOPE, 'claude-code')
    expect(JSON.parse(current()).claudeAiOauth.refreshToken).toBe('refresh-1')
  })

  it('refreshes once when many runs ask at the same time', async () => {
    /**
     * THE POINT OF ALL THIS. Two runs share one seat. If each refreshed, each would rotate the
     * refresh token and the loser's copy would be dead — the container holding it fails mid-run
     * looking like an expired subscription, which is exactly what we were seeing.
     */
    const { store, stored } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      // Slow enough that the other callers are certainly waiting rather than merely sequential.
      await new Promise((r) => setTimeout(r, 20))
      return Response.json({
        access_token: `access-${calls + 1}`,
        refresh_token: `refresh-${calls + 1}`,
        expires_in: 28800,
      })
    }) as unknown as typeof fetch

    const refresher = new SeatRefresher({ accounts: store, fetchImpl })
    await Promise.all(Array.from({ length: 8 }, () => refresher.ensureFresh(SCOPE, 'claude-code')))

    expect(calls).toBe(1)
    // And exactly one new credential was stored, not eight.
    expect(stored).toHaveLength(2)
  })

  it('serialises across instances through the lock it is given', async () => {
    /**
     * The in-process guard covers one control plane. A second instance sweeping while the first
     * dispatches is the case that needs the advisory lock, and this proves the refresher
     * actually goes through it rather than around it.
     */
    const { store } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const order: string[] = []
    let held = false
    const lock = async <T>(_s: SpaceScope, _h: string, body: () => Promise<T>): Promise<T> => {
      // Would be a violation of mutual exclusion, so it is asserted rather than tolerated.
      expect(held).toBe(false)
      held = true
      order.push('locked')
      try {
        return await body()
      } finally {
        held = false
        order.push('released')
      }
    }
    const fetchImpl = (async () =>
      Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 28800 })) as never

    const refresher = new SeatRefresher({ accounts: store, fetchImpl, lock })
    await refresher.ensureFresh(SCOPE, 'claude-code')
    expect(order).toEqual(['locked', 'released'])
  })

  it('re-reads inside the lock, so a queued caller does not refresh again', async () => {
    /**
     * Whoever waited on the lock is very likely waiting behind a refresh that just happened. If
     * it acted on the credential it read *before* waiting, it would rotate a token that had
     * already been replaced — turning the lock from a guard into a delay.
     */
    const { store } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return Response.json({
        access_token: 'a',
        refresh_token: 'r',
        // Refreshed to well beyond the margin, so a correct second pass sees no work to do.
        expires_in: 28800,
      })
    }) as never

    const refresher = new SeatRefresher({ accounts: store, fetchImpl })
    await refresher.ensureFresh(SCOPE, 'claude-code')
    // Sequential, so the in-flight promise cannot be what saves us — only the re-read can.
    await refresher.ensureFresh(SCOPE, 'claude-code')
    expect(calls).toBe(1)
  })

  it('leaves the stored credential alone when a refresh fails', async () => {
    /**
     * The old token may still have life in it. Replacing it with nothing would turn a
     * recoverable state into a seat that certainly cannot work.
     *
     * A 503 rather than `invalid_grant`, deliberately: a provider having a bad minute is the
     * retryable case. A rejected token is a different outcome and is asserted separately.
     */
    const { store, current, stored } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const before = current()
    const events: string[] = []
    const fetchImpl = (async () => new Response('upstream boom', { status: 503 })) as never

    await new SeatRefresher({
      accounts: store,
      fetchImpl,
      onEvent: (e) => events.push(`${e.outcome}`),
    }).ensureFresh(SCOPE, 'claude-code')

    expect(stored).toHaveLength(1)
    expect(current()).toBe(before)
    expect(events).toEqual(['failed'])
  })

  it('does not call the provider when the token is still fresh', async () => {
    const { store } = seatStore(claudeFile({ expiresInMs: 6 * HOUR }))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const events: string[] = []
    await new SeatRefresher({
      accounts: store,
      fetchImpl,
      onEvent: (e) => events.push(e.outcome),
    }).ensureFresh(SCOPE, 'claude-code')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(events).toEqual(['still-fresh'])
  })

  it('asks for a human once the refresh token itself has expired', async () => {
    const { store } = seatStore(claudeFile({ expiresInMs: -HOUR, refreshExpiresInMs: -HOUR }))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const events: Array<{ outcome: string; detail?: string }> = []
    await new SeatRefresher({
      accounts: store,
      fetchImpl,
      onEvent: (e) =>
        events.push({ outcome: e.outcome, ...(e.detail ? { detail: e.detail } : {}) }),
    }).ensureFresh(SCOPE, 'claude-code')

    // No point POSTing a token that cannot be redeemed; say what has to happen instead.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(events[0]?.outcome).toBe('needs-login')
    expect(events[0]?.detail).toMatch(/sign in again/)
  })
})

describe('the idle sweep', () => {
  it('refreshes seats when nothing is running', async () => {
    /**
     * A quiet weekend is longer than an access token lives. Without this, the seat is fine until
     * the next dispatch and then fails at it — the worst moment to discover it.
     */
    const { store, current } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const fetchImpl = (async () =>
      Response.json({
        access_token: 'swept',
        refresh_token: 'swept-refresh',
        expires_in: 28800,
      })) as never
    const refresher = new SeatRefresher({ accounts: store, fetchImpl })

    await new RefreshSweep({
      accounts: store,
      refresher,
      scopes: () => [SCOPE],
    }).sweep()

    expect(JSON.parse(current()).claudeAiOauth.accessToken).toBe('swept')
  })

  it('skips a seat whose credential cannot be decrypted', async () => {
    // That needs a person, not a refresh, and trying would log a confusing error every few
    // hours for ever.
    const asked: string[] = []
    await new RefreshSweep({
      accounts: {
        async list() {
          return [
            {
              harness: 'claude-code',
              label: 'claude-code',
              envVars: [],
              files: ['.claude/.credentials.json'],
              connectedAt: new Date().toISOString(),
              readable: false,
            },
          ]
        },
      },
      refresher: {
        async ensureFresh(_scope, harness) {
          asked.push(harness)
        },
      },
      scopes: () => [SCOPE],
    }).sweep()

    expect(asked).toEqual([])
  })

  it('does not start a second pass on top of a slow one', async () => {
    // Two overlapping sweeps would queue on the same locks, and the queue would only grow.
    let inFlight = 0
    let peak = 0
    const sweep = new RefreshSweep({
      accounts: {
        async list() {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((r) => setTimeout(r, 30))
          inFlight--
          return []
        },
      },
      refresher: { async ensureFresh() {} },
      scopes: () => [SCOPE],
    })

    await Promise.all([sweep.sweep(), sweep.sweep(), sweep.sweep()])
    expect(peak).toBe(1)
  })

  it('keeps going when one space fails', async () => {
    // A database blip on one space must not stop the others from being kept alive.
    const asked: string[] = []
    let first = true
    await new RefreshSweep({
      accounts: {
        async list(scope) {
          if (first) {
            first = false
            throw new Error('connection terminated')
          }
          asked.push(scope.clientSpaceId)
          return []
        },
      },
      refresher: { async ensureFresh() {} },
      scopes: () => [{ clientSpaceId: 'space-1' }, { clientSpaceId: 'space-2' }],
    }).sweep()

    expect(asked).toEqual(['space-2'])
  })
})

describe('a refresh token the provider will never accept again', () => {
  it('asks for a login rather than retrying for ever', async () => {
    /**
     * FOUND BY RUNNING IT against the real provider. The stored Claude Code token came back
     * `invalid_grant — Refresh token not found or invalid`: it had already been redeemed, so no
     * amount of retrying can help.
     *
     * Reported as a generic failure it would be retried by every sweep, every three hours,
     * until a person happened to look. `invalid_grant` is a different answer from a 500 and is
     * treated as one.
     */
    const { store, stored } = seatStore(claudeFile({ expiresInMs: 10 * 60 * 1000 }))
    const events: Array<{ outcome: string; detail?: string }> = []
    const fetchImpl = (async () =>
      new Response('{"error":"invalid_grant","error_description":"Refresh token not found"}', {
        status: 400,
      })) as never

    await new SeatRefresher({
      accounts: store,
      fetchImpl,
      onEvent: (e) =>
        events.push({ outcome: e.outcome, ...(e.detail ? { detail: e.detail } : {}) }),
    }).ensureFresh(SCOPE, 'claude-code')

    expect(events[0]?.outcome).toBe('needs-login')
    expect(events[0]?.detail).toMatch(/sign in again/)
    // And the dead credential is left in place, so the UI can still show what is connected.
    expect(stored).toHaveLength(1)
  })
})
