import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorAuthError } from "@/connectors/errors";
import { googleFetch, GoogleBudgetExhaustedError } from "./client";

// This repo has no HTTP mocking library (no msw/nock) — googleFetch is the
// one module in the Google connectors that genuinely can't be tested as a
// pure function, so it stubs vitest's built-in global.fetch rather than
// introducing a new dependency for one file.
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleFetch", () => {
  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    const calls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push(Date.now());
        if (calls.length === 1) {
          return jsonResponse(429, { error: { message: "rate limited" } }, { "Retry-After": "0" });
        }
        return jsonResponse(200, { ok: true });
      }),
    );

    const result = await googleFetch<{ ok: boolean }>("https://example.test/x", {
      accessToken: "t",
      deadline: createDeadline(10_000),
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("retries a 403 with reason rateLimitExceeded, but NOT a 403 with insufficientPermissions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { error: { message: "quota", errors: [{ reason: "rateLimitExceeded" }] } }),
      ),
    );
    await expect(
      googleFetch("https://example.test/x", { accessToken: "t", deadline: createDeadline(10_000), maxAttempts: 2 }),
    ).rejects.toThrow(/403/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // it DID retry once before exhausting maxAttempts

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { error: { message: "denied", errors: [{ reason: "insufficientPermissions" }] } }),
      ),
    );
    await expect(
      googleFetch("https://example.test/x", { accessToken: "t", deadline: createDeadline(10_000), maxAttempts: 3 }),
    ).rejects.toThrow(/403/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // did NOT retry — genuine permission denial
  });

  it("maps a 401 to ConnectorAuthError without retrying", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: { message: "invalid token" } })));
    await expect(
      googleFetch("https://example.test/x", { accessToken: "t", deadline: createDeadline(10_000) }),
    ).rejects.toBeInstanceOf(ConnectorAuthError);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("throws GoogleBudgetExhaustedError instead of sleeping past the remaining deadline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(429, { error: { message: "rate limited" } }, { "Retry-After": "9999" })),
    );
    await expect(
      googleFetch("https://example.test/x", { accessToken: "t", deadline: createDeadline(50) }),
    ).rejects.toBeInstanceOf(GoogleBudgetExhaustedError);
  });

  it("throws GoogleBudgetExhaustedError immediately if the deadline is already expired", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      googleFetch("https://example.test/x", { accessToken: "t", deadline: createDeadline(-1) }),
    ).rejects.toBeInstanceOf(GoogleBudgetExhaustedError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
