import type { FetchDeadline } from "./types";

/**
 * Wraps a wall-clock budget behind the FetchDeadline interface so connector
 * code never touches Date.now() directly and stays easy to reason about.
 * `budgetMs` should leave headroom under the caller's actual timeout — e.g.
 * run-sync.ts uses 45_000 against the route's 60s maxDuration, reserving the
 * remainder for the raw_events/normalized_events writes and cursor upsert
 * that happen after fetchSince returns.
 */
export function createDeadline(budgetMs: number): FetchDeadline {
  const startedAt = Date.now();
  const deadlineAt = startedAt + budgetMs;
  return {
    expired(): boolean {
      return Date.now() >= deadlineAt;
    },
    remainingMs(): number {
      return Math.max(0, deadlineAt - Date.now());
    },
  };
}

/**
 * Slices a fixed share off a parent deadline, for a connector that has to
 * time-share ONE FetchContext.deadline across several sub-fetches (the
 * merged `google` connector splits its budget between Gmail/Drive/Chat).
 *
 * The slice is computed ONCE, at carve time, and then runs on its own clock
 * — it is deliberately NOT a live view onto the parent. A live view would
 * shrink as the parent burned down and a sub-connector's "do I have enough
 * budget for one more page?" checks would keep passing on an ever-smaller
 * share, which is exactly the starvation this exists to prevent. The caller
 * still re-reads the parent between sub-fetches, so overall overrun is
 * bounded by the parent, not by this.
 *
 * `shareOfRemaining` above 1 is clamped to the parent's whole remaining
 * budget; below 0 it clamps to zero (an already-expired slice).
 */
export function carveDeadline(parent: FetchDeadline, shareOfRemaining: number): FetchDeadline {
  const parentRemainingMs = parent.remainingMs();
  const share = Number.isFinite(shareOfRemaining) ? Math.max(0, shareOfRemaining) : 0;
  return createDeadline(Math.min(parentRemainingMs, parentRemainingMs * share));
}
