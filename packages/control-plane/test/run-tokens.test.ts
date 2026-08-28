import { describe, expect, it } from 'vitest'
import { InMemoryRunTokens, RunTokenRegistry } from '../src/runs/tokens.js'

describe('minting', () => {
  it('issues a token that resolves to its own run', async () => {
    // Returns the run rather than a boolean on purpose: a boolean invites checking the
    // token against a runId taken from the request path, which is how a valid token for
    // run A ends up authorising a write to run B.
    const registry = new RunTokenRegistry()
    const { token } = await registry.mint('run_a')
    expect(await registry.verify(token)).toBe('run_a')
  })

  it('gives two runs unrelated tokens', async () => {
    const registry = new RunTokenRegistry()
    const a = await registry.mint('run_a')
    const b = await registry.mint('run_b')
    expect(a.token).not.toBe(b.token)
    expect(await registry.verify(a.token)).toBe('run_a')
    expect(await registry.verify(b.token)).toBe('run_b')
  })

  it('replaces a previous token for the same run', async () => {
    // Dispatch is retried on throttling. Two live tokens for one run would mean revoking it
    // took two calls, so one would be missed.
    // The store is held explicitly because `size` is an in-memory notion: the durable store
    // keeps revoked rows on purpose, so counting them there would mean something different.
    const store = new InMemoryRunTokens()
    const registry = new RunTokenRegistry({ store })
    const first = await registry.mint('run_a')
    const second = await registry.mint('run_a')
    expect(await registry.verify(first.token)).toBeUndefined()
    expect(await registry.verify(second.token)).toBe('run_a')
    expect(store.size).toBe(1)
  })

  it('produces tokens safe in an env var, a URL and a header', async () => {
    // base64url, so no `+` or `/` to be mangled in a query string.
    const registry = new RunTokenRegistry()
    for (let i = 0; i < 20; i += 1) {
      expect((await registry.mint(`run_${i}`)).token).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe('rejecting', () => {
  it('rejects an unknown token', async () => {
    expect(await new RunTokenRegistry().verify('made-up')).toBeUndefined()
  })

  it('rejects an empty token without touching the map', async () => {
    expect(await new RunTokenRegistry().verify('')).toBeUndefined()
  })

  it('rejects an expired token and forgets it', async () => {
    let now = 1_000
    const store = new InMemoryRunTokens()
    const registry = new RunTokenRegistry({ store, ttlMs: 100, now: () => now })
    const { token } = await registry.mint('run_a')
    expect(await registry.verify(token)).toBe('run_a')
    now += 101
    expect(await registry.verify(token)).toBeUndefined()
    // Forgotten, not merely refused: a stale record is a credential waiting for a clock bug.
    expect(store.size).toBe(0)
  })
})

describe('revoking', () => {
  it('revokes on settle, so a token cannot outlive its run', async () => {
    const registry = new RunTokenRegistry()
    const { token } = await registry.mint('run_a')
    await registry.revoke('run_a')
    expect(await registry.verify(token)).toBeUndefined()
  })

  it('is a no-op for a run that has none', async () => {
    const registry = new RunTokenRegistry()
    await expect(registry.revoke('run_missing')).resolves.toBeUndefined()
  })

  it('prunes expired records so a long-lived process does not grow', async () => {
    let now = 0
    const store = new InMemoryRunTokens()
    const registry = new RunTokenRegistry({ store, ttlMs: 10, now: () => now })
    for (let i = 0; i < 5; i += 1) await registry.mint(`run_${i}`)
    now = 50
    expect(await registry.prune()).toBe(5)
    expect(store.size).toBe(0)
  })
})
