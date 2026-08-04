import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.stubEnv("SLACK_CLIENT_ID", "test-client-id");
vi.stubEnv("SLACK_CLIENT_SECRET", "test-client-secret");
vi.stubEnv("SLACK_OAUTH_STATE_SECRET", "test-state-secret-at-least-16-bytes");

const { createSlackOAuthState, verifySlackOAuthState } = await import("./state");

describe("Slack OAuth state", () => {
  it("round-trips workspaceId/projectId through sign and verify", () => {
    const token = createSlackOAuthState("ws-1", "proj-1");
    const verified = verifySlackOAuthState(token);
    expect(verified?.workspaceId).toBe("ws-1");
    expect(verified?.projectId).toBe("proj-1");
  });

  it("rejects a tampered payload", () => {
    const token = createSlackOAuthState("ws-1", "proj-1");
    const [, signature] = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ workspaceId: "ws-evil", projectId: "proj-1", nonce: "x", issuedAt: Date.now() }), "utf8").toString("base64url");
    expect(verifySlackOAuthState(`${tamperedPayload}.${signature}`)).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifySlackOAuthState("not-a-valid-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createSlackOAuthState("ws-1", "proj-1");
    const [payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.issuedAt = Date.now() - 11 * 60 * 1000; // 1 minute past the 10-minute TTL
    const rePayload = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

    // Re-sign so this exercises the TTL check specifically, not the signature check.
    const signature = createHmac("sha256", "test-state-secret-at-least-16-bytes")
      .update(rePayload)
      .digest("base64url");

    expect(verifySlackOAuthState(`${rePayload}.${signature}`)).toBeNull();
  });
});
