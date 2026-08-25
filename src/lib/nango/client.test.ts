import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorAuthError } from "@/connectors/errors";

// Same rationale as connectors/google/client.test.ts: no HTTP mocking
// library in this repo, so nangoProxy is tested by stubbing global.fetch
// directly rather than adding msw/nock for one module.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubEnv("NANGO_SERVER_URL", "http://localhost:3003");
  vi.stubEnv("NANGO_SECRET_KEY", "test-secret-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("nangoProxy", () => {
  it("builds the proxy URL and sends the documented headers", async () => {
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

    const { nangoProxy } = await import("./client");
    const result = await nangoProxy<{ ok: boolean }>({
      connectionId: "conn-1",
      providerConfigKey: "google",
      endpoint: "/gmail/v1/users/me/profile",
      baseUrlOverride: "https://gmail.googleapis.com",
      deadline: createDeadline(10_000),
    });

    expect(result).toEqual({ ok: true });
    expect(capturedUrl).toBe("http://localhost:3003/proxy/gmail/v1/users/me/profile");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-secret-key");
    expect(headers["Provider-Config-Key"]).toBe("google");
    expect(headers["Connection-Id"]).toBe("conn-1");
    expect(headers["Base-Url-Override"]).toBe("https://gmail.googleapis.com");
    expect(headers.Retries).toBe("3"); // default — Nango owns retry/backoff, see D-007
  });

  it("omits Base-Url-Override when not provided", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return jsonResponse(200, { ok: true });
      }),
    );

    const { nangoProxy } = await import("./client");
    await nangoProxy({
      connectionId: "conn-1",
      providerConfigKey: "slack",
      endpoint: "/conversations.history",
      deadline: createDeadline(10_000),
    });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Base-Url-Override"]).toBeUndefined();
  });

  it("maps a 401 to ConnectorAuthError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "invalid token" })));
    const { nangoProxy } = await import("./client");
    await expect(
      nangoProxy({ connectionId: "c", providerConfigKey: "google", endpoint: "/x", deadline: createDeadline(10_000) }),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it("throws a generic error with status + body on other non-2xx responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));
    const { nangoProxy } = await import("./client");
    await expect(
      nangoProxy({ connectionId: "c", providerConfigKey: "google", endpoint: "/x", deadline: createDeadline(10_000) }),
    ).rejects.toThrow(/500/);
  });

  it("parses an empty body as undefined instead of throwing on JSON.parse", async () => {
    // Response forbids a body on 204/205/304, but the empty-body-safe parse
    // path only cares about an empty string, not the specific status.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    const { nangoProxy } = await import("./client");
    const result = await nangoProxy({
      connectionId: "c",
      providerConfigKey: "google",
      endpoint: "/x",
      deadline: createDeadline(10_000),
    });
    expect(result).toBeUndefined();
  });

  it("throws BudgetExhaustedError immediately if the deadline is already expired", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { nangoProxy, BudgetExhaustedError } = await import("./client");
    await expect(
      nangoProxy({ connectionId: "c", providerConfigKey: "google", endpoint: "/x", deadline: createDeadline(-1) }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("aborts and throws BudgetExhaustedError rather than waiting past the remaining budget", async () => {
    // A fetch that never resolves on its own — only the internal
    // AbortController firing (driven by the deadline) should end this call.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new DOMException("aborted", "AbortError");
            reject(err);
          });
        });
      }),
    );

    const { nangoProxy, BudgetExhaustedError } = await import("./client");
    // Budget of 600ms minus the 500ms reserve leaves ~100ms before abort fires.
    await expect(
      nangoProxy({ connectionId: "c", providerConfigKey: "google", endpoint: "/x", deadline: createDeadline(600) }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });
});
