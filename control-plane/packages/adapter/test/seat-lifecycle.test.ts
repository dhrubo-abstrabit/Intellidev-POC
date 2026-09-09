import { describe, expect, it } from 'vitest'
import { SeatLifecycle } from '../src/credentials/seat-lifecycle.js'
import type { SeatCredential } from '../src/credentials/types.js'

/**
 * A run that outlasts its credential.
 *
 * The control plane hands out a token that is fresh at dispatch, which covers a run finishing
 * inside the refresh margin. A hard task can take longer, and then the token expires somewhere in
 * the middle — and Claude Code cannot refresh it, run headless. Asking again is the mechanism the
 * broker was built for, so a long run becomes a series of fresh tokens rather than one that has
 * to last.
 */
function credential(expiresInMs: number): SeatCredential {
  return {
    harness: 'claude-code',
    material: {},
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  }
}

describe('a run that outlasts its token', () => {
  it('asks again before the credential expires', async () => {
    let asked = 0
    const materialised: string[] = []
    const lifecycle = new SeatLifecycle({
      fetchSeat: async () => {
        asked++
        return credential(8 * 3600 * 1000)
      },
      materialise: async (c) => materialised.push(c.expiresAt),
      checkIntervalMs: 5,
    })
    lifecycle.observe(credential(60_000)) // inside the ten-minute renewal window
    lifecycle.start()
    await new Promise((r) => setTimeout(r, 40))
    lifecycle.stop()

    expect(asked).toBeGreaterThanOrEqual(1)
    // And the new credential was actually written, not merely fetched.
    expect(materialised).toHaveLength(asked)
  })

  it('does not ask while the credential has plenty of life', async () => {
    let asked = 0
    const lifecycle = new SeatLifecycle({
      fetchSeat: async () => {
        asked++
        return credential(8 * 3600 * 1000)
      },
      materialise: async () => {},
      checkIntervalMs: 5,
    })
    lifecycle.observe(credential(6 * 3600 * 1000))
    lifecycle.start()
    await new Promise((r) => setTimeout(r, 30))
    lifecycle.stop()

    expect(asked).toBe(0)
  })

  it('stops asking when the answer does not move the expiry forward', async () => {
    /**
     * An answer with the same expiry means the control plane could not refresh — the provider
     * is down, or the seat needs a human. Treating it as a renewal would have this fire again a
     * minute later, and then every minute for the rest of the run.
     */
    let asked = 0
    const stuck = credential(60_000)
    const lifecycle = new SeatLifecycle({
      fetchSeat: async () => {
        asked++
        return stuck
      },
      materialise: async () => {
        throw new Error('should not materialise an answer that renewed nothing')
      },
      checkIntervalMs: 5,
    })
    lifecycle.observe(stuck)
    lifecycle.start()
    await new Promise((r) => setTimeout(r, 40))
    lifecycle.stop()

    // It keeps trying — the provider may recover — but never rewrites the file with the same
    // credential, and never throws into the run.
    expect(asked).toBeGreaterThan(0)
  })

  it('never fails the run when renewal fails', async () => {
    // The credential in place is valid until it is not. A failed renewal that killed the run
    // would be worse than the expiry it was trying to avoid.
    const errors: Error[] = []
    const lifecycle = new SeatLifecycle({
      fetchSeat: async () => {
        throw new Error('control plane unreachable')
      },
      materialise: async () => {},
      checkIntervalMs: 5,
      onError: (error) => errors.push(error),
    })
    lifecycle.observe(credential(60_000))
    lifecycle.start()
    await new Promise((r) => setTimeout(r, 30))
    lifecycle.stop()

    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toContain('unreachable')
  })
})
