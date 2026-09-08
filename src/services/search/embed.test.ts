import { describe, expect, it } from "vitest";
import { AuthenticationError, BadRequestError, PermissionDeniedError, RateLimitError, InternalServerError } from "openai";
import { classifyEmbedError, EmbedInputError, planEmbedRequests, toVectorLiteral } from "./embed";
import { countEmbeddingTokens } from "@/lib/llm/embeddings";

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

  // The cases below are shaped like what @langchain/openai's
  // wrapOpenAIClientError actually produces (verified against its installed
  // source), not the raw OpenAI SDK error classes above — embedTexts calls
  // through LangChain's OpenAIEmbeddings now, and these are the wrapper
  // shapes classifyEmbedError must still classify correctly.

  it("classifies a wrapped context-overflow error (no SDK class, name-only) as 'input'", () => {
    // wrapOpenAIClientError's context-overflow branch constructs a brand-new
    // ContextOverflowError — not `instanceof BadRequestError` even though
    // the underlying failure was a 400. This is the one case the structural
    // check exists for.
    const err = { name: "ContextOverflowError", message: "maximum context length exceeded" };
    expect(classifyEmbedError(err)).toBe("input");
  });

  it("classifies a plain Error named InsufficientQuotaError (no status) as 'auth'", () => {
    const err = Object.assign(new Error("quota exceeded"), { name: "InsufficientQuotaError" });
    expect(classifyEmbedError(err)).toBe("auth");
  });

  it("classifies a non-instanceof object shaped like a nested quota error as 'auth'", () => {
    const err = { status: 429, error: { code: "insufficient_quota" } };
    expect(classifyEmbedError(err)).toBe("auth");
  });

  it("classifies a wrapped timeout (plain Error, name-only) as 'transient'", () => {
    // wrapOpenAIClientError's timeout branch also constructs a plain Error
    // with no SDK class — falls through to the default, same as any other
    // unrecognized shape.
    const err = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    expect(classifyEmbedError(err)).toBe("transient");
  });

  it("still classifies a real BadRequestError as 'input' even with a troubleshooting URL appended", () => {
    // addLangChainErrorFields mutates .message in place on the SAME object
    // (verified against source) rather than constructing a new one —
    // instanceof must survive that.
    const err = new BadRequestError(400, {}, "bad request\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/x/\n", makeHeaders());
    expect(classifyEmbedError(err)).toBe("input");
  });
});

describe("countEmbeddingTokens", () => {
  it("is deterministic for the same text", async () => {
    const text = "This is a short chunk of text about the project status.";
    expect(await countEmbeddingTokens(text)).toBe(await countEmbeddingTokens(text));
  });

  it("returns a positive count for non-empty text and 0 for empty text", async () => {
    expect(await countEmbeddingTokens("hello world")).toBeGreaterThan(0);
    expect(await countEmbeddingTokens("")).toBe(0);
  });
});
