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

export class RunTokenRegistry {
  private readonly byFingerprint = new Map<string, RunTokenRecord>()
  private readonly byRun = new Map<string, string>()

  constructor(
    private readonly opts: {
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
  ) {}

  /**
   * Issues a token for a run, replacing any previous one.
   *
   * Replacing matters: dispatch is retried on throttling, and two live tokens for one run
   * would mean revoking it took two calls — so one would be missed.
   */
  mint(runId: string): MintedRunToken {
    this.revoke(runId)
    // 32 bytes of CSPRNG. base64url so it survives an env var, a URL and a header without
    // escaping, which is where a `+` or `/` would otherwise be mangled.
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + (this.opts.ttlMs ?? 6 * 60 * 60 * 1000)
    const fp = fingerprint(token)
    this.byFingerprint.set(fp, { runId, expiresAt })
    this.byRun.set(runId, fp)
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
  verify(token: string): string | undefined {
    if (!token) return undefined
    const fp = fingerprint(token)
    const record = this.byFingerprint.get(fp)
    if (!record) return undefined

    if (record.expiresAt <= this.now()) {
      this.byFingerprint.delete(fp)
      this.byRun.delete(record.runId)
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
  revoke(runId: string): void {
    const fp = this.byRun.get(runId)
    if (!fp) return
    this.byFingerprint.delete(fp)
    this.byRun.delete(runId)
  }

  /** Drops expired records. Cheap, and keeps a long-lived process from growing. */
  prune(): number {
    const now = this.now()
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

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
