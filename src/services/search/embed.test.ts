import { describe, expect, it } from "vitest";
import { AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError, InternalServerError } from "openai";
import { classifyEmbedError, EmbedInputError, planEmbedRequests, toVectorLiteral } from "./embed";

function makeHeaders(): Headers {
  return new Headers();
}

describe("toVectorLiteral", () => {
  it("formats a number array as a pgvector text literal", () => {
    expect(toVectorLiteral([1, 2.5, -3])).toBe("[1,2.5,-3]");
  });

  it("formats an empty array", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});

describe("planEmbedRequests", () => {
  it("returns no batches for empty input", () => {
    expect(planEmbedRequests([])).toEqual([]);
  });

  it("packs short texts into a single batch", () => {
    const batches = planEmbedRequests(["a", "b", "c"]);
    expect(batches).toHaveLength(1);
    expect(batches[0].texts).toEqual(["a", "b", "c"]);
    expect(batches[0].indices).toEqual([0, 1, 2]);
  });

  it("never exceeds the per-request input-count cap", () => {
    const texts = Array.from({ length: 300 }, (_, i) => `chunk ${i}`);
    const batches = planEmbedRequests(texts);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.texts.length).toBeLessThanOrEqual(128);
    }
    // every original index appears exactly once, across all batches
    const allIndices = batches.flatMap((b) => b.indices).sort((a, b) => a - b);
    expect(allIndices).toEqual(texts.map((_, i) => i));
  });

  it("splits on the estimated-token budget for a few very long (but individually valid) inputs", () => {
    // ~20,000 bytes each -> ~6,000 estimated tokens each; several of these
    // should force a new batch well before the 128-input count cap would.
    const longText = "word ".repeat(4000);
    const texts = Array.from({ length: 20 }, () => longText);
    const batches = planEmbedRequests(texts);
    expect(batches.length).toBeGreaterThan(1);
  });

  it("throws EmbedInputError for a single input over the per-input byte limit", () => {
    const tooLong = "x".repeat(25_000);
    expect(() => planEmbedRequests(["short", tooLong])).toThrow(EmbedInputError);
  });
});

describe("classifyEmbedError", () => {
  it("classifies a 400 as 'input'", () => {
    const err = new BadRequestError(400, {}, "bad request", makeHeaders());
    expect(classifyEmbedError(err)).toBe("input");
  });

  it("classifies a 401 as 'auth'", () => {
    const err = new AuthenticationError(401, {}, "invalid api key", makeHeaders());
    expect(classifyEmbedError(err)).toBe("auth");
  });

  it("classifies a 403 as 'auth'", () => {
    const err = new PermissionDeniedError(403, {}, "forbidden", makeHeaders());
    expect(classifyEmbedError(err)).toBe("auth");
  });

  it("classifies a plain 429 (no insufficient_quota) as 'transient'", () => {
    const err = new RateLimitError(429, {}, "rate limited", makeHeaders());
    expect(classifyEmbedError(err)).toBe("transient");
  });

  it("classifies a 429 with error.code === 'insufficient_quota' as 'auth'", () => {
    const err = new RateLimitError(429, { error: { code: "insufficient_quota" } }, "quota exceeded", makeHeaders());
    expect(classifyEmbedError(err)).toBe("auth");
  });

  it("classifies a 5xx as 'transient'", () => {
    const err = new InternalServerError(500, {}, "server error", makeHeaders());
    expect(classifyEmbedError(err)).toBe("transient");
  });

  it("classifies a plain network error as 'transient'", () => {
    expect(classifyEmbedError(new Error("ECONNRESET"))).toBe("transient");
  });
});
