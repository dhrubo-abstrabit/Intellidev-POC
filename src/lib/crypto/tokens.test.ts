import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const KEY_V1 = randomBytes(32).toString("base64");
const KEY_V2 = randomBytes(32).toString("base64");

beforeAll(() => {
  process.env.TOKEN_ENC_KEYS = `1:${KEY_V1},2:${KEY_V2}`;
  process.env.TOKEN_ENC_ACTIVE_VERSION = "1";
});

// Imported after env vars are set, since the module lazily reads+caches them
// on first use rather than at import time.
const { sealTokens, openTokens, needsRotation } = await import("@/lib/crypto/tokens");

describe("sealTokens / openTokens", () => {
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const credentialId = "22222222-2222-2222-2222-222222222222";
  const bundle = { access_token: "xoxb-secret", refresh_token: "xoxe-secret", expires_in: 3600 };

  it("round-trips the plaintext bundle", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    const opened = openTokens(sealed, workspaceId, credentialId);
    expect(opened).toEqual(bundle);
  });

  it("produces ciphertext that does not contain the plaintext secret", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    expect(sealed.ciphertext.toString("base64")).not.toContain("xoxb-secret");
    expect(sealed.ciphertext.toString("utf8")).not.toContain("xoxb-secret");
  });

  it("uses a fresh IV on every call (no nonce reuse)", () => {
    const a = sealTokens(bundle, workspaceId, credentialId);
    const b = sealTokens(bundle, workspaceId, credentialId);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects decryption under a different workspace id (AAD binding)", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    const otherWorkspaceId = "99999999-9999-9999-9999-999999999999";
    expect(() => openTokens(sealed, otherWorkspaceId, credentialId)).toThrow();
  });

  it("rejects decryption under a different credential id (AAD binding)", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    const otherCredentialId = "33333333-3333-3333-3333-333333333333";
    expect(() => openTokens(sealed, workspaceId, otherCredentialId)).toThrow();
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => openTokens({ ...sealed, ciphertext: tampered }, workspaceId, credentialId)).toThrow();
  });

  it("does not flag a secret sealed under the current active version", () => {
    const sealed = sealTokens(bundle, workspaceId, credentialId);
    expect(needsRotation(sealed)).toBe(false);
  });

  it("flags a secret sealed under a non-active key version as needing rotation", async () => {
    // Reset the module registry so the next dynamic import re-reads env vars
    // instead of returning the already-cached keyring/activeVersion state.
    vi.resetModules();
    process.env.TOKEN_ENC_ACTIVE_VERSION = "2";
    const rotated = await import("@/lib/crypto/tokens");
    const sealedUnderV1 = { keyVersion: 1 as const };
    expect(rotated.needsRotation(sealedUnderV1)).toBe(true);

    process.env.TOKEN_ENC_ACTIVE_VERSION = "1";
    vi.resetModules();
  });
});
