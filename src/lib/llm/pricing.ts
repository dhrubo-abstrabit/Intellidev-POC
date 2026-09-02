import type { LLMUsage } from "./types";

interface ModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
  /** gpt-5.6-luna re-rates the WHOLE request — input AND output, not just
   * the overage — once total input tokens (ordinary + cached + cache-write)
   * exceed this threshold. Absent = a single flat tier, as on every
   * Anthropic model this app has used so far. */
  longContext?: { thresholdInputTokens: number; rates: Omit<ModelRates, "longContext"> };
}

/**
 * Rate table keyed by MODEL ID, not provider+model — model ids are unique
 * in practice, and keying by provider+model would let the two llm_runs
 * columns silently disagree with each other.
 *
 * Claude Haiku 4.5: $1/$5 per MTok (input/output), with the standard
 * Anthropic cache multipliers — a 5-minute cache write costs 1.25x the base
 * input rate, a cache read costs 0.1x.
 *
 * gpt-5.6-luna: $0.20/$1.20 per MTok short-context, cache write $0.25/MTok
 * (1.25x input, matching Anthropic's own multiplier), cache read $0.02/MTok
 * (0.1x). Long-context tier (total input > 272,000 tokens) re-rates the
 * whole request to $0.40/$1.80/$0.50/$0.04 — confirmed via OpenAI's own
 * pricing page 2026-09-01.
 *
 * In both cases `usage.promptTokens` is already non-cached input only (see
 * the invariant documented on LLMUsage in types.ts) — these three terms
 * never double-count regardless of which provider produced the usage.
 */
const RATES: Record<string, ModelRates> = {
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
  "gpt-5.6-luna": {
    inputPerMTok: 0.2,
    outputPerMTok: 1.2,
    cacheWritePerMTok: 0.25,
    cacheReadPerMTok: 0.02,
    longContext: {
      thresholdInputTokens: 272_000,
      rates: { inputPerMTok: 0.4, outputPerMTok: 1.8, cacheWritePerMTok: 0.5, cacheReadPerMTok: 0.04 },
    },
  },
};

/**
 * Computes the cost of ONE call's usage against its OWN model's rates.
 *
 * `model` is required, not optional — this is what makes the historical bug
 * (generate.ts hardcoding "claude-haiku-4-5" into every llm_runs row
 * regardless of which provider actually ran) structurally impossible to
 * reintroduce: there is no path to a cost number without naming the model
 * that produced the usage being priced.
 *
 * Must be called PER CALL, then summed as dollars — never on aggregated
 * usage (see generate.ts). Pricing gpt-5.6-luna's long-context tier by
 * total tokens ACROSS several ordinary-sized chunks would wrongly bill the
 * whole total at the long-context rate the moment the sum crosses 272K,
 * even though no single call actually reasoned over that much text.
 *
 * Returns null (never throws) for an unknown model — llm_runs.cost_usd is
 * nullable specifically so a pricing gap doesn't fail an otherwise
 * successful run; null is the honest value here, not 0.
 */
export function estimateCostUsd(usage: LLMUsage, model: string): number | null {
  const base = RATES[model];
  if (!base) {
    console.warn(`[llm] estimateCostUsd: no rate table entry for model "${model}" — cost_usd will be recorded as null`);
    return null;
  }

  const totalInputTokens = usage.promptTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  const rates = base.longContext && totalInputTokens > base.longContext.thresholdInputTokens ? base.longContext.rates : base;

  const cost =
    (usage.promptTokens / 1_000_000) * rates.inputPerMTok +
    (usage.completionTokens / 1_000_000) * rates.outputPerMTok +
    (usage.cacheCreationTokens / 1_000_000) * rates.cacheWritePerMTok +
    (usage.cacheReadTokens / 1_000_000) * rates.cacheReadPerMTok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
