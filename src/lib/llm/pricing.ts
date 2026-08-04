import type { LLMUsage } from "./types";

/**
 * Claude Haiku 4.5 pricing: $1/$5 per MTok (input/output), with the standard
 * Anthropic cache multipliers — a 5-minute cache write costs 1.25x the base
 * input rate, a cache read costs 0.1x. `usage.promptTokens` is already
 * non-cached input only (the API reports cache tokens as separate additive
 * fields), so these three terms don't double-count.
 */
const INPUT_PER_MTOK = 1;
const OUTPUT_PER_MTOK = 5;
const CACHE_WRITE_PER_MTOK = INPUT_PER_MTOK * 1.25;
const CACHE_READ_PER_MTOK = INPUT_PER_MTOK * 0.1;

export function estimateCostUsd(usage: LLMUsage): number {
  const cost =
    (usage.promptTokens / 1_000_000) * INPUT_PER_MTOK +
    (usage.completionTokens / 1_000_000) * OUTPUT_PER_MTOK +
    (usage.cacheCreationTokens / 1_000_000) * CACHE_WRITE_PER_MTOK +
    (usage.cacheReadTokens / 1_000_000) * CACHE_READ_PER_MTOK;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
