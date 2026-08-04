import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

describe("estimateCostUsd", () => {
  it("computes cost from prompt/completion tokens with no caching", () => {
    const cost = estimateCostUsd({
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // $1/MTok input + $5/MTok output
    expect(cost).toBe(6);
  });

  it("applies the cache write premium (1.25x input rate)", () => {
    const cost = estimateCostUsd({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1_000_000,
    });
    expect(cost).toBe(1.25);
  });

  it("applies the cache read discount (0.1x input rate)", () => {
    const cost = estimateCostUsd({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
    });
    expect(cost).toBe(0.1);
  });

  it("returns 0 for a run with no usage at all", () => {
    expect(estimateCostUsd({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBe(0);
  });
});
