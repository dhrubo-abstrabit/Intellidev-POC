import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * Verifies the access tokens Supabase Auth issues.
 *
 * **Asymmetric, so this holds no secret.** Supabase signs with ES256 and publishes the public
 * half at `/auth/v1/.well-known/jwks.json`. Verification therefore needs a public key and
 * nothing else — there is no shared signing secret to distribute, rotate, or leak from a
 * deployment. That is a materially better position than the legacy HS256 arrangement, and it
 * is worth not giving up by accident.
 *
 * **Verified locally, not by calling Supabase.** A token arrives on every request, including
 * every frame of a long-lived event stream; asking an auth server about each one would add a
 * round trip to the hot path and make Supabase's availability our own. The JWKS is fetched
 * once and cached, and `jose` refetches when it sees an unknown key id — which is exactly what
 * a key rotation looks like.
 */

export interface AuthenticatedUser {
  /** `auth.users.id`, which `public.users.id` mirrors. The identity everything hangs off. */
  readonly id: string
  readonly email?: string
  /** The raw claims, for `set local request.jwt.claims` when a query must run under RLS. */
  readonly claims: JWTPayload
}

export class InvalidToken extends Error {}

export interface JwtVerifierOptions {
  /** The Supabase project URL, e.g. `https://abc.supabase.co`. */
  readonly projectUrl: string
  /** Injected in tests so verification can be exercised without a network. */
  readonly keySet?: ReturnType<typeof createRemoteJWKSet>
  readonly now?: () => number
}

export class JwtVerifier {
  private readonly keySet: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly opts: JwtVerifierOptions) {
    this.keySet =
      opts.keySet ?? createRemoteJWKSet(new URL(`${opts.projectUrl}/auth/v1/.well-known/jwks.json`))
  }

  /**
   * Resolves a bearer token to the user it belongs to.
   *
   * Everything about the answer comes from the token's signature: the id is taken from `sub`
   * and never from a header, a query parameter or a request body. That is the difference
   * between authentication and a suggestion.
   */
  async verify(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = authorization?.replace(/^Bearer\s+/i, '').trim()
    if (!token) throw new InvalidToken('no bearer token')

    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, this.keySet, {
        // Supabase sets `aud: 'authenticated'` for a signed-in user. Checking it stops a token
        // minted for some other audience — a service key, another product on the same
        // project — from being accepted as a person.
        audience: 'authenticated',
        ...(this.opts.now ? { currentDate: new Date(this.opts.now()) } : {}),
      }))
    } catch (error) {
      // Deliberately uniform. Whether the signature was wrong, the token expired, or the key id
      // was unknown is useful to an attacker probing and useless to a user, who can only sign
      // in again either way.
      throw new InvalidToken(error instanceof Error ? error.name : 'token rejected')
    }

    const id = typeof payload.sub === 'string' ? payload.sub : undefined
    if (!id) throw new InvalidToken('token has no subject')

    // `role` is Supabase's own claim. `service_role` is a machine key with RLS bypass; it must
    // never be mistaken for a person, because every authorization decision below assumes the
    // subject is one.
    if (payload['role'] !== 'authenticated') {
      throw new InvalidToken('not an end-user token')
    }

    return {
      id,
      ...(typeof payload['email'] === 'string' ? { email: payload['email'] } : {}),
      claims: payload,
    }
  }
}
