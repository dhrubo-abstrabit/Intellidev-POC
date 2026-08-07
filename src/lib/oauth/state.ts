import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { oauthStateEnv } from "@/lib/env";
import type { OAuthProvider } from "./providers";

/**
 * The OAuth `state` param is the CSRF defense for the whole connect flow —
 * without it, an attacker can trick a logged-in user into completing an
 * OAuth grant for the attacker's account, landing it on the victim's
 * project. We sign a payload (which project this connect attempt is for,
 * which provider it's for, plus a nonce) with an HMAC so the callback route
 * can verify the `state` it gets back hasn't been forged, replayed against a
 * different provider's callback, or gone stale.
 *
 * Generic across every connector — this replaces connectors/slack/state.ts,
 * whose four original test cases moved to state.test.ts unchanged. The one
 * behavioral addition is the `provider` field: without it, a state token
 * minted for `slack` would verify successfully against the `gmail`
 * callback, since the signature alone doesn't say which provider it was
 * issued for.
 */
export interface OAuthState {
  provider: OAuthProvider;
  workspaceId: string;
  projectId: string;
  nonce: string;
  issuedAt: number;
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes — generous enough for a slow OAuth consent screen

function sign(payload: string): string {
  return createHmac("sha256", oauthStateEnv().stateSecret).update(payload).digest("base64url");
}

export function createOAuthState(provider: OAuthProvider, workspaceId: string, projectId: string): string {
  const state: OAuthState = {
    provider,
    workspaceId,
    projectId,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

/**
 * Verifies signature and freshness, but NOT single-use — the caller is
 * responsible for nonce replay protection if that matters for their flow
 * (we don't track issued nonces server-side, so a captured `state` is valid
 * until it expires; the short TTL above is the primary mitigation, plus the
 * RLS-backed `projects` re-check every callback route performs). The
 * `provider` match is NOT checked here — callers must compare
 * `state.provider` against the route's own `provider` param themselves, so
 * a mismatch can be reported with route-specific context (see
 * api/oauth/[provider]/callback/route.ts).
 */
export function verifyOAuthState(token: string): OAuthState | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let state: OAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (Date.now() - state.issuedAt > MAX_STATE_AGE_MS) return null;
  return state;
}
