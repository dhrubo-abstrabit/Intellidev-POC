import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { slackEnv } from "@/lib/env";

/**
 * The OAuth `state` param is the CSRF defense for the whole connect flow —
 * without it, an attacker can trick a logged-in user into completing an
 * OAuth grant for the attacker's Slack workspace, landing it on the
 * victim's project. We sign a payload (which project this connect attempt
 * is for, plus a nonce) with an HMAC so the callback route can verify the
 * `state` it gets back hasn't been forged or replayed.
 */
export interface SlackOAuthState {
  workspaceId: string;
  projectId: string;
  nonce: string;
  issuedAt: number;
}

const MAX_STATE_AGE_MS = 10 * 60 * 1000; // 10 minutes — generous enough for a slow OAuth consent screen

function sign(payload: string): string {
  return createHmac("sha256", slackEnv().SLACK_OAUTH_STATE_SECRET).update(payload).digest("base64url");
}

export function createSlackOAuthState(workspaceId: string, projectId: string): string {
  const state: SlackOAuthState = {
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
 * until it expires; the short TTL above is the primary mitigation).
 */
export function verifySlackOAuthState(token: string): SlackOAuthState | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let state: SlackOAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (Date.now() - state.issuedAt > MAX_STATE_AGE_MS) return null;
  return state;
}
