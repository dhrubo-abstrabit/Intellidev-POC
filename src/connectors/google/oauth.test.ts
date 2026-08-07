import { afterEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_SECRET", "test-client-secret");
vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "test-anon-key");

const { googleAuthorizeUrl, exchangeGoogleCode, refreshGoogleTokens } = await import("./oauth");

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// A fake, plausible id_token — [header].[payload].[signature], base64url.
// oauth.ts deliberately decodes this without verifying the signature (see
// its doc comment), so any well-formed payload segment is fine for tests.
function fakeIdToken(claims: Record<string, unknown>): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${seg({ alg: "none" })}.${seg(claims)}.sig`;
}

describe("googleAuthorizeUrl", () => {
  it("sets access_type=offline, prompt=consent, space-joined scopes, and the per-provider redirect_uri", () => {
    const url = new URL(
      googleAuthorizeUrl({ provider: "google_drive", scopes: ["https://www.googleapis.com/auth/drive.readonly"], state: "s" }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("openid email profile https://www.googleapis.com/auth/drive.readonly");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/api/oauth/google_drive/callback");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
  });

  it("never includes include_granted_scopes", () => {
    const url = new URL(googleAuthorizeUrl({ provider: "google_chat", scopes: ["x"], state: "s" }));
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("passes login_hint through only when provided", () => {
    const withHint = new URL(
      googleAuthorizeUrl({ provider: "google_drive", scopes: ["x"], state: "s", loginHint: "team@x.com" }),
    );
    expect(withHint.searchParams.get("login_hint")).toBe("team@x.com");
    const withoutHint = new URL(googleAuthorizeUrl({ provider: "google_chat", scopes: ["x"], state: "s" }));
    expect(withoutHint.searchParams.has("login_hint")).toBe(false);
  });
});

describe("exchangeGoogleCode", () => {
  it("throws MISSING_REFRESH_TOKEN when Google omits refresh_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          access_token: "at",
          scope: "https://www.googleapis.com/auth/drive.readonly",
          expires_in: 3600,
          id_token: fakeIdToken({ sub: "u1", email: "a@x.com" }),
        }),
      ),
    );
    await expect(
      exchangeGoogleCode("google_drive", "code", ["https://www.googleapis.com/auth/drive.readonly"]),
    ).rejects.toThrow(/MISSING_REFRESH_TOKEN/);
  });

  it("throws MISSING_SCOPES when a required scope wasn't granted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          scope: "openid email profile", // drive.readonly missing
          expires_in: 3600,
          id_token: fakeIdToken({ sub: "u1", email: "a@x.com" }),
        }),
      ),
    );
    await expect(
      exchangeGoogleCode("google_drive", "code", ["https://www.googleapis.com/auth/drive.readonly"]),
    ).rejects.toThrow(/MISSING_SCOPES/);
  });

  it("succeeds and extracts sub/email from the id_token when everything is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          access_token: "at",
          refresh_token: "rt",
          scope: "openid email profile https://www.googleapis.com/auth/drive.readonly",
          expires_in: 3600,
          id_token: fakeIdToken({ sub: "u1", email: "a@x.com" }),
        }),
      ),
    );
    const creds = await exchangeGoogleCode("google_drive", "code", ["https://www.googleapis.com/auth/drive.readonly"]);
    expect(creds.externalAccountId).toBe("u1");
    expect(creds.externalAccountLabel).toBe("a@x.com");
    expect(creds.tokens.refresh_token).toBe("rt");
    expect(creds.accessTokenExpiresAt).toBeInstanceOf(Date);
  });
});

describe("refreshGoogleTokens", () => {
  it("merges refresh_token forward when Google's refresh response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { access_token: "new-at", expires_in: 3600 })),
    );
    const refreshed = await refreshGoogleTokens({
      tokens: { access_token: "old-at", refresh_token: "rt-original", scope: "x" },
      externalAccountId: "u1",
    });
    expect(refreshed.tokens.access_token).toBe("new-at");
    expect(refreshed.tokens.refresh_token).toBe("rt-original");
  });

  it("maps invalid_grant to a PERMANENT ConnectorRefreshError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: "invalid_grant" })));
    await expect(refreshGoogleTokens({ tokens: { refresh_token: "rt" }, externalAccountId: "u1" })).rejects.toMatchObject({
      permanent: true,
    });
  });

  it("maps a 503 to a TRANSIENT ConnectorRefreshError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(503, { error: "backend_error" })));
    await expect(refreshGoogleTokens({ tokens: { refresh_token: "rt" }, externalAccountId: "u1" })).rejects.toMatchObject({
      permanent: false,
    });
  });

  it("throws a permanent error immediately when no refresh_token is stored", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(refreshGoogleTokens({ tokens: {}, externalAccountId: "u1" })).rejects.toMatchObject({ permanent: true });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
