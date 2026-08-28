import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Per-run bearer tokens.
 *
 * This is the one credential a run legitimately holds in its environment, and it is the
 * root of everything else: the run presents it to open its event socket, and B3 will have
 * it presented to the credential broker for git, seat and MCP material. Which means the
 * token must buy *only* what that one run is entitled to — never anything reusable, and
 * never anything another run could use.
 *
 * Three properties worth being explicit about, because each closes a specific hole:
 *
 *  - **Stored hashed.** A dump of this registry — a heap snapshot, a log line, later a
 *    database row — must not be usable as a credential. Only the run ever holds the
 *    plaintext.
 *  - **Compared in constant time.** Token comparison on a public endpoint is exactly where
 *    a timing oracle is worth having, and `===` on a secret is the classic way to give one
 *    away.
 *  - **Bound to one run and expired.** A token that outlives its run is a standing
 *    credential, which is the thing this design exists to avoid.
 *
 * **Durable, not in-process.** This used to be two Maps, which works exactly as long as there
 * is one control-plane process. Behind a load balancer a token minted while dispatching on
 * instance A is unverifiable on instance B, so a container's broker calls fail on roughly half
 * of them — and the half that fails moves with the routing, which is the worst kind of bug to
 * meet in production. Storage is behind `RunTokenStore` so the in-memory path still needs no
 * database, and the Postgres one keeps only the fingerprint.
 */

export interface RunTokenRecord {
  readonly runId: string
  readonly expiresAt: number
}

export interface MintedRunToken {
  /** Given to the run. Never stored, never logged. */
  readonly token: string
  readonly runId: string
  readonly expiresAt: number
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Where tokens live between minting and verifying.
 *
 * Four methods rather than a general key-value interface, because the semantics matter:
 * `revokeRunTokens` is keyed by *run*, not by token, since a run's token has to be killable
 * without knowing what it was.
 */
export interface RunTokenStore {
  putRunToken(fingerprint: string, runId: string, expiresAt: number): Promise<void>
  getRunToken(fingerprint: string): Promise<RunTokenRecord | undefined>
  revokeRunTokens(runId: string): Promise<void>
  pruneRunTokens(now: number): Promise<number>
}

/**
 * The default store: correct for one process, and all a local loop needs.
 *
 * Kept rather than deleted because the in-memory task store has no database behind it either,
 * and the pairing should stay consistent — a developer running without Postgres gets a control
 * plane that works, not one that fails at dispatch.
 */
export class InMemoryRunTokens implements RunTokenStore {
  private readonly byFingerprint = new Map<string, RunTokenRecord>()
  private readonly byRun = new Map<string, string>()

  async putRunToken(fingerprint: string, runId: string, expiresAt: number): Promise<void> {
    this.byFingerprint.set(fingerprint, { runId, expiresAt })
    this.byRun.set(runId, fingerprint)
  }

  async getRunToken(fingerprint: string): Promise<RunTokenRecord | undefined> {
    return this.byFingerprint.get(fingerprint)
  }

  async revokeRunTokens(runId: string): Promise<void> {
    const fp = this.byRun.get(runId)
    if (!fp) return
    this.byFingerprint.delete(fp)
    this.byRun.delete(runId)
  }

  async pruneRunTokens(now: number): Promise<number> {
    let dropped = 0
    for (const [fp, record] of this.byFingerprint) {
      if (record.expiresAt <= now) {
        this.byFingerprint.delete(fp)
        this.byRun.delete(record.runId)
        dropped += 1
      }
    }
    return dropped
  }

  get size(): number {
    return this.byFingerprint.size
  }
}

export class RunTokenRegistry {
  private readonly store: RunTokenStore

  constructor(
    private readonly opts: {
      /** Where tokens are kept. Defaults to memory, which is right for one process. */
      store?: RunTokenStore
      /**
       * How long a token stays valid.
       *
       * Generous relative to a run's wall clock, because a token that expires mid-run would
       * silently sever the event stream and look like a network fault. E1's wall-clock
       * ceiling is what bounds a run, not this.
       */
      ttlMs?: number
      now?: () => number
    } = {},
  ) {
    this.store = opts.store ?? new InMemoryRunTokens()
  }

  /**
   * Issues a token for a run, replacing any previous one.
   *
   * Replacing matters: dispatch is retried on throttling, and two live tokens for one run
   * would mean revoking it took two calls — so one would be missed.
   */
  async mint(runId: string): Promise<MintedRunToken> {
    await this.revoke(runId)
    // 32 bytes of CSPRNG. base64url so it survives an env var, a URL and a header without
    // escaping, which is where a `+` or `/` would otherwise be mangled.
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + (this.opts.ttlMs ?? 6 * 60 * 60 * 1000)
    const fp = fingerprint(token)
    await this.store.putRunToken(fp, runId, expiresAt)
    return { token, runId, expiresAt }
  }

  /**
   * Returns the run a token belongs to, or undefined.
   *
   * Deliberately returns the run rather than a boolean: every caller needs to know *which*
   * run is authenticated, and a boolean would invite checking the token against a runId
   * taken from the request path — which is how a valid token for run A ends up authorising
   * a write to run B.
   */
  async verify(token: string): Promise<string | undefined> {
    if (!token) return undefined
    const fp = fingerprint(token)
    const record = await this.store.getRunToken(fp)
    if (!record) return undefined

    if (record.expiresAt <= this.now()) {
      // Expiry is enforced here as well as in the store's query, so a store that returns a
      // stale row cannot extend a token's life.
      await this.store.revokeRunTokens(record.runId)
      return undefined
    }

    // The map lookup above is already content-addressed by a hash, so this comparison is
    // belt-and-braces — but it costs nothing and it means the code never compares secrets
    // with `===`, which is the habit worth keeping.
    const expected = Buffer.from(fp, 'hex')
    const actual = Buffer.from(fingerprint(token), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined

    return record.runId
  }

  /** Called when a run settles. A token outliving its run is a standing credential. */
  async revoke(runId: string): Promise<void> {
    await this.store.revokeRunTokens(runId)
  }

  /** Drops expired records. Cheap, and keeps a long-lived process from growing. */
  async prune(): Promise<number> {
    return await this.store.pruneRunTokens(this.now())
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
