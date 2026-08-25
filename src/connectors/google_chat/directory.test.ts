import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import type { ConnectorCredentials } from "@/connectors/types";
import { resolveSenderNames } from "./directory";

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

describe("resolveSenderNames", () => {
  it("returns an empty map without making a request when there are no sender ids", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const resolved = await resolveSenderNames([], { credentials, deadline: createDeadline(10_000) });
    expect(resolved.size).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("issues ONE batched request for multiple sender ids, deduped, routed through Nango's proxy", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.getAll("resourceNames")).toEqual(["people/111", "people/222"]);
      expect(parsed.searchParams.get("personFields")).toBe("names,emailAddresses");
      const headers = init.headers as Record<string, string>;
      expect(headers["Base-Url-Override"]).toBe("https://people.googleapis.com");
      expect(headers["Connection-Id"]).toBe("conn-1");
      return jsonResponse(200, {
        responses: [
          { requestedResourceName: "people/111", person: { names: [{ displayName: "Alice" }], emailAddresses: [{ value: "alice@x.com" }] } },
          { requestedResourceName: "people/222", person: { names: [{ displayName: "Bob" }] } },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveSenderNames(["users/111", "users/111", "users/222"], {
      credentials,
      deadline: createDeadline(10_000),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolved.get("users/111")).toEqual({ displayName: "Alice", email: "alice@x.com" });
    expect(resolved.get("users/222")).toEqual({ displayName: "Bob", email: undefined });
  });

  it("caps the number of ids resolved in one run", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const count = new URL(url).searchParams.getAll("resourceNames").length;
      expect(count).toBeLessThanOrEqual(30);
      return jsonResponse(200, { responses: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manyIds = Array.from({ length: 50 }, (_, i) => `users/${i}`);
    await resolveSenderNames(manyIds, { credentials, deadline: createDeadline(10_000) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips a response entry with no person (not found / outside the org)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { responses: [{ requestedResourceName: "people/111", status: { code: 5 } }] }),
      ),
    );
    const resolved = await resolveSenderNames(["users/111"], { credentials, deadline: createDeadline(10_000) });
    expect(resolved.size).toBe(0);
  });

  it("degrades to an empty map (never throws) when the API call fails — e.g. missing directory.readonly scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: { message: "insufficient scope" } })));
    const resolved = await resolveSenderNames(["users/111"], { credentials, deadline: createDeadline(10_000) });
    expect(resolved.size).toBe(0);
  });
});
