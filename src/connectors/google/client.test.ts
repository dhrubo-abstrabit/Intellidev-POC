import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorAuthError } from "@/connectors/errors";
import type { ConnectorCredentials } from "@/connectors/types";
import { googleFetch, GoogleBudgetExhaustedError } from "./client";

// Same rationale as lib/nango/client.test.ts: no HTTP mocking library in
// this repo, so googleFetch (now a thin adapter over nangoProxy) is tested
// by stubbing global.fetch directly.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const credentials: ConnectorCredentials = {
  connectionId: "conn-1",
  providerConfigKey: "google",
  externalAccountId: "sub-1",
  getAccessToken: async () => "unused-by-proxy-calls",
};

beforeEach(() => {
  vi.stubEnv("NANGO_SERVER_URL", "http://localhost:3003");
  vi.stubEnv("NANGO_SECRET_KEY", "test-secret-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("googleFetch", () => {
  it("passes the default googleapis.com host straight through with no override", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return jsonResponse(200, { ok: true });
      }),
    );

    const result = await googleFetch<{ ok: boolean }>("https://www.googleapis.com/drive/v3/about?fields=user", {
      credentials,
      deadline: createDeadline(10_000),
    });

    expect(result).toEqual({ ok: true });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Base-Url-Override"]).toBeUndefined();
    expect(headers["Provider-Config-Key"]).toBe("google");
    expect(headers["Connection-Id"]).toBe("conn-1");
  });

  it("overrides the base URL for a non-default Google host (Gmail/Chat/People)", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse(200, { ok: true });
      }),
    );

    await googleFetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      credentials,
      deadline: createDeadline(10_000),
    });

    expect(capturedUrl).toBe("http://localhost:3003/proxy/gmail/v1/users/me/profile");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Base-Url-Override"]).toBe("https://gmail.googleapis.com");
  });

  it("translates maxAttempts into Nango's retries count (attempts after the first)", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return jsonResponse(200, { ok: true });
      }),
    );

    await googleFetch("https://www.googleapis.com/x", { credentials, deadline: createDeadline(10_000), maxAttempts: 1 });
    expect((capturedInit?.headers as Record<string, string>).Retries).toBe("0");
  });

  it("maps a 401 to ConnectorAuthError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "invalid token" })));
    await expect(
      googleFetch("https://www.googleapis.com/x", { credentials, deadline: createDeadline(10_000) }),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it("throws GoogleBudgetExhaustedError immediately if the deadline is already expired", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      googleFetch("https://www.googleapis.com/x", { credentials, deadline: createDeadline(-1) }),
    ).rejects.toBeInstanceOf(GoogleBudgetExhaustedError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
