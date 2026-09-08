import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_MODEL = "gpt-5.6-luna";

describe("estimateCostUsd — claude-haiku-4-5", () => {
  it("computes cost from prompt/completion tokens with no caching", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      ANTHROPIC_MODEL,
    );
    // $1/MTok input + $5/MTok output
    expect(cost).toBe(6);
  });

  it("applies the cache write premium (1.25x input rate)", () => {
    const cost = estimateCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 1_000_000 },
      ANTHROPIC_MODEL,
    );
    expect(cost).toBe(1.25);
  });

  it("applies the cache read discount (0.1x input rate)", () => {
    const cost = estimateCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 0 },
      ANTHROPIC_MODEL,
    );
    expect(cost).toBe(0.1);
  });

  it("returns 0 for a run with no usage at all", () => {
    expect(
      estimateCostUsd({ promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, ANTHROPIC_MODEL),
    ).toBe(0);
  });
});

describe("estimateCostUsd — gpt-5.6-luna", () => {
  // 100_000 tokens throughout this describe block — deliberately well under
  // the 272,000-token long-context threshold, so these cases exercise the
  // short-context rate tier and not the other one.
  it("computes short-context cost: $0.20/MTok input + $1.20/MTok output", () => {
    const cost = estimateCostUsd(
      { promptTokens: 100_000, completionTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      OPENAI_MODEL,
    );
    expect(cost).toBeCloseTo(0.02 + 0.12, 6);
  });

  it("applies the cache write rate ($0.25/MTok)", () => {
    const cost = estimateCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 100_000 },
      OPENAI_MODEL,
    );
    expect(cost).toBeCloseTo(0.025, 6);
  });

  it("applies the cache read rate ($0.02/MTok)", () => {
    const cost = estimateCostUsd(
      { promptTokens: 0, completionTokens: 0, cacheReadTokens: 100_000, cacheCreationTokens: 0 },
      OPENAI_MODEL,
    );
    expect(cost).toBeCloseTo(0.002, 6);
  });

  it("stays at short-context rates exactly at the 272,000-token boundary", () => {
    const cost = estimateCostUsd(
      { promptTokens: 272_000, completionTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      OPENAI_MODEL,
    );
    // 272_000 * 0.20/1e6 + 1_000_000 * 1.20/1e6 = 0.0544 + 1.2
    expect(cost).toBeCloseTo(0.0544 + 1.2, 6);
  });

  it("re-rates BOTH input and output once total input exceeds 272,000 tokens", () => {
    const cost = estimateCostUsd(
      { promptTokens: 272_001, completionTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      OPENAI_MODEL,
    );
    // long-context tier: $0.40/MTok input, $1.80/MTok output
    const expected = (272_001 / 1_000_000) * 0.4 + (1_000_000 / 1_000_000) * 1.8;
    expect(cost).toBeCloseTo(expected, 6);
    // and it must be MORE than what the short-context rate would have given,
    // proving the output side re-tiered too, not just input
    const shortContextEquivalent = (272_001 / 1_000_000) * 0.2 + 1.2;
    expect(cost!).toBeGreaterThan(shortContextEquivalent);
  });

  it("tier selection considers cached + cache-write tokens as part of total input", () => {
    const cost = estimateCostUsd(
      { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 100_000, cacheCreationTokens: 100_001 },
      OPENAI_MODEL,
    );
    // total input = 300_001 > 272_000 -> long-context cache rates ($0.50 write, $0.04 read)
    const expected = (100_000 / 1_000_000) * 0.4 + (100_001 / 1_000_000) * 0.5 + (100_000 / 1_000_000) * 0.04;
    expect(cost).toBeCloseTo(expected, 6);
  });
});

describe("estimateCostUsd — per-call pricing, not aggregate (anti-regression)", () => {
  it("three separately-priced 100K-token calls total less than one 300K-token call", () => {
    const perCallUsage = { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const summedSeparately = [1, 2, 3].reduce((sum) => sum + (estimateCostUsd(perCallUsage, OPENAI_MODEL) ?? 0), 0);

    const aggregatedUsage = { promptTokens: 300_000, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const pricedAsOneCall = estimateCostUsd(aggregatedUsage, OPENAI_MODEL)!;

    expect(summedSeparately).toBeLessThan(pricedAsOneCall);
  });
});

describe("estimateCostUsd — unknown model", () => {
  it("returns null rather than throwing", () => {
    expect(
      estimateCostUsd({ promptTokens: 1000, completionTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 }, "some-future-model"),
    ).toBeNull();
  });
});
