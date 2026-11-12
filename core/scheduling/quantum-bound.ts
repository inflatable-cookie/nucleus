/** Longest a task quantum may hold a sweep window before the sweep moves on. */
export const TASK_QUANTUM_BOUND_MS = 120_000;

/**
 * Settles one task quantum no later than `bound` ms (planner ruling on #1148: a
 * stuck task never blocks the board). A quantum still running at the bound is
 * reported through `onTimeout` and no longer holds the sweep. Its task lane stays
 * held until the quantum really returns, so a later quantum for that task still
 * waits behind it. A quantum's own failure never reaches the sweep.
 */
export function boundQuantum(quantum: Promise<unknown>, onTimeout: () => void, bound = TASK_QUANTUM_BOUND_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      try { onTimeout(); } finally { resolve(); }
    }, bound);
  });
  return Promise.race([quantum.then(() => undefined, () => undefined), expired]).finally(() => clearTimeout(timer));
}
