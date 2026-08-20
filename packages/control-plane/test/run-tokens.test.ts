import { describe, expect, it } from 'vitest'
import { RunTokenRegistry } from '../src/runs/tokens.js'

describe('minting', () => {
  it('issues a token that resolves to its own run', () => {
    // Returns the run rather than a boolean on purpose: a boolean invites checking the
    // token against a runId taken from the request path, which is how a valid token for
    // run A ends up authorising a write to run B.
    const registry = new RunTokenRegistry()
    const { token } = registry.mint('run_a')
    expect(registry.verify(token)).toBe('run_a')
  })

  it('gives two runs unrelated tokens', () => {
    const registry = new RunTokenRegistry()
    const a = registry.mint('run_a')
    const b = registry.mint('run_b')
    expect(a.token).not.toBe(b.token)
    expect(registry.verify(a.token)).toBe('run_a')
    expect(registry.verify(b.token)).toBe('run_b')
  })

  it('replaces a previous token for the same run', () => {
    // Dispatch is retried on throttling. Two live tokens for one run would mean revoking it
    // took two calls, so one would be missed.
    const registry = new RunTokenRegistry()
    const first = registry.mint('run_a')
    const second = registry.mint('run_a')
    expect(registry.verify(first.token)).toBeUndefined()
    expect(registry.verify(second.token)).toBe('run_a')
    expect(registry.size).toBe(1)
  })

  it('produces tokens safe in an env var, a URL and a header', () => {
    // base64url, so no `+` or `/` to be mangled in a query string.
    const registry = new RunTokenRegistry()
    for (let i = 0; i < 20; i += 1) {
      expect(registry.mint(`run_${i}`).token).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('rejecting', () => {
  it('rejects an unknown token', () => {
    expect(new RunTokenRegistry().verify('made-up')).toBeUndefined()
  })

  it('rejects an empty token without touching the map', () => {
    expect(new RunTokenRegistry().verify('')).toBeUndefined()
  })

  it('rejects an expired token and forgets it', () => {
    let now = 1_000
    const registry = new RunTokenRegistry({ ttlMs: 100, now: () => now })
    const { token } = registry.mint('run_a')
    expect(registry.verify(token)).toBe('run_a')
    now += 101
    expect(registry.verify(token)).toBeUndefined()
    // Forgotten, not merely refused: a stale record is a credential waiting for a clock bug.
    expect(registry.size).toBe(0)
  })
})

describe('revoking', () => {
  it('revokes on settle, so a token cannot outlive its run', () => {
    const registry = new RunTokenRegistry()
    const { token } = registry.mint('run_a')
    registry.revoke('run_a')
    expect(registry.verify(token)).toBeUndefined()
  })

  it('is a no-op for a run that has none', () => {
    const registry = new RunTokenRegistry()
    expect(() => registry.revoke('run_missing')).not.toThrow()
  })

  it('prunes expired records so a long-lived process does not grow', () => {
    let now = 0
    const registry = new RunTokenRegistry({ ttlMs: 10, now: () => now })
    for (let i = 0; i < 5; i += 1) registry.mint(`run_${i}`)
    now = 50
    expect(registry.prune()).toBe(5)
    expect(registry.size).toBe(0)
  })
})
