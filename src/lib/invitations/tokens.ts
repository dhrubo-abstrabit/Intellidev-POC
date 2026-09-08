import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * How long an invitation stays usable. Seven days: long enough to survive a
 * weekend and a holiday Monday, short enough that a forwarded link stops
 * working before anyone has forgotten it was sent.
 *
 * A constant rather than a column default on purpose — `invitations.expires_at`
 * is NOT NULL with no default, so the value is always explicit at the call
 * site and changing the policy never needs a migration.
 */
export const INVITE_TTL_DAYS = 7;

/**
 * 256 bits from the OS CSPRNG, base64url so it survives a URL without
 * escaping.
 *
 * The entropy is load-bearing, not decorative. `accept_invitation()`
 * deliberately does not require the accepting user's email to match the
 * invited one — the token IS the credential — so its only protection against
 * being guessed is its size. It is also why `invite_preview` can safely report
 * *why* an invitation is unusable (expired, revoked, accepted) instead of a
 * uniform "not found": at this width, enumeration is not a threat model, it is
 * arithmetic.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The stored form: SHA-256, formatted as the `\x…` hex literal Postgres
 * expects for a `bytea` sent over PostgREST.
 *
 * The plaintext is emailed and never persisted, so a database leak yields no
 * usable invitations — which is the reason the column is a hash rather than
 * the token itself.
 */
export function hashInviteToken(token: string): string {
  return `\\x${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/**
 * Constant-time comparison, for any path that compares two tokens in Node
 * rather than letting Postgres do it. Not used by the accept flow — that
 * hashes and matches in SQL — but present so nobody reaches for `===` if one
 * is ever needed.
 */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** When an invitation created now should stop working. */
export function inviteExpiryFromNow(): string {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
