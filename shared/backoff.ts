/**
 * Bounded retry delays. Every automatic retry schedule computes its delay here,
 * so no schedule can grow without a ceiling.
 */

/** A stepped schedule: `attempt` 0 takes the first step and the last step repeats. */
export function steppedDelay(steps: readonly number[], attempt: number): number {
  return steps[Math.min(Math.max(0, attempt), steps.length - 1)]!;
}

/** A doubling delay from `baseMs`, capped at `maxMs` and at 64 times the base. `failures` counts from 1. */
export function doublingDelay(baseMs: number, maxMs: number, failures: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(failures - 1, 0), 6));
}
