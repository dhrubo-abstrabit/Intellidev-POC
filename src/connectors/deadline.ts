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
