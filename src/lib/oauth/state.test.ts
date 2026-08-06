import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("OAUTH_STATE_SECRET", "test-state-secret-at-least-16-bytes");

const { createOAuthState, verifyOAuthState } = await import("./state");

describe("OAuth state", () => {
  it("round-trips workspaceId/projectId/provider through sign and verify", () => {
    const token = createOAuthState("slack", "ws-1", "proj-1");
    const verified = verifyOAuthState(token);
    expect(verified?.workspaceId).toBe("ws-1");
    expect(verified?.projectId).toBe("proj-1");
    expect(verified?.provider).toBe("slack");
  });

  it("rejects a tampered payload", () => {
    const token = createOAuthState("slack", "ws-1", "proj-1");
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ provider: "slack", workspaceId: "ws-evil", projectId: "proj-1", nonce: "x", issuedAt: Date.now() }),
      "utf8",
    ).toString("base64url");
    expect(verifyOAuthState(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifyOAuthState("not-a-valid-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createOAuthState("slack", "ws-1", "proj-1");
    const [payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.issuedAt = Date.now() - 11 * 60 * 1000; // 1 minute past the 10-minute TTL
    const rePayload = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    // Re-sign so this exercises the TTL check specifically, not the signature check.
    const signature = createHmac("sha256", "test-state-secret-at-least-16-bytes").update(rePayload).digest("base64url");

    expect(verifyOAuthState(`${rePayload}.${signature}`)).toBeNull();
  });

  it("does not itself enforce a provider match — a state minted for one provider verifies fine on its own", () => {
    // The provider check is the CALLER's job (api/oauth/[provider]/callback
    // compares state.provider against the route's own `provider` param) —
    // this test pins that verifyOAuthState only proves authenticity/freshness,
    // not "was this issued for the provider you're about to use it with".
    const token = createOAuthState("google_drive", "ws-1", "proj-1");
    const verified = verifyOAuthState(token);
    expect(verified?.provider).toBe("google_drive");
    expect(verified?.provider).not.toBe("slack");
  });

  it("a payload with a tampered provider field fails signature verification", () => {
    const token = createOAuthState("slack", "ws-1", "proj-1");
    const [payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.provider = "google_drive"; // attacker tries to relabel a Slack-issued state as Drive's
    const tamperedPayload = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    expect(verifyOAuthState(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("falls back to SLACK_OAUTH_STATE_SECRET when OAUTH_STATE_SECRET is unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("SLACK_OAUTH_STATE_SECRET", "fallback-secret-at-least-16-bytes");
    vi.resetModules();
    const { createOAuthState: create, verifyOAuthState: verify } = await import("./state");
    const token = create("slack", "ws-1", "proj-1");
    expect(verify(token)?.workspaceId).toBe("ws-1");
    vi.unstubAllEnvs();
    vi.stubEnv("OAUTH_STATE_SECRET", "test-state-secret-at-least-16-bytes");
  });
});
