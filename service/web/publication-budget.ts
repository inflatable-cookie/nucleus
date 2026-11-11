/** Below this a publication is cheap enough to run on every request. */
export const PUBLICATION_BUDGET_FREE_MS = 100;
/** A slow publication may take at most about a fifth of the executor's time. */
export const PUBLICATION_BUDGET_FACTOR = 4;
/** The longest a board can lag behind a slow publication. */
export const PUBLICATION_BUDGET_MAX_GAP_MS = 10_000;

/**
 * Keeps board publication from starving the executor. A board of 400 queued tasks
 * took long enough to build that publishing after every request and every second
 * left the worker 8% idle, and reviews, merges and reads waited minutes behind it
 * (2026-11-05). After a slow publication the next non-essential one waits; the
 * one-second tick publishes when it is due, so the board stays current.
 */
export function publicationBudget(now: () => number = () => performance.now()) {
  let nextAt = 0;
  return {
    due: () => now() >= nextAt,
    spent(ms: number) {
      nextAt = ms < PUBLICATION_BUDGET_FREE_MS ? 0 : now() + Math.min(ms * PUBLICATION_BUDGET_FACTOR, PUBLICATION_BUDGET_MAX_GAP_MS);
    },
  };
}
