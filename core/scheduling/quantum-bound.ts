/** Longest a task quantum may hold a sweep window before the sweep moves on. */
export const TASK_QUANTUM_BOUND_MS = 120_000;

/** How a bounded quantum reports an outage, and where its observer's own fault goes. */
export interface QuantumBound {
  /** Longest the quantum may hold the window; the production bound by default. */
  bound?: number;
  /** Keeps a throwing timeout observer's fault, which the bound contains. */
  onFault?: (error: unknown) => void;
}

/**
 * Settles one task quantum no later than `bound` ms (planner ruling on #1148: a
 * stuck task never blocks the board). A quantum still running at the bound is
 * reported through `onTimeout` and no longer holds the sweep. Its task lane stays
 * held until the quantum really returns, so a later quantum for that task still
 * waits behind it. A quantum's own failure never reaches the sweep.
 *
 * The bound is the timer's owner, so it is also where the timeout observer's own
 * failure stops (nucleus#1469). An observer that throws — the production one
 * writes a SQLite event — would otherwise escape the timer as an uncaught
 * exception while this promise already resolved, so the reporting fault would
 * both kill the service and disappear. The throw is contained here, the quantum
 * still settles, and `onFault` receives it so the caller keeps the real fault
 * on its own durable diagnostic. A sink that also throws never re-enters the
 * timer either.
 */
export function boundQuantum(
  quantum: Promise<unknown>,
  onTimeout: () => void,
  { bound = TASK_QUANTUM_BOUND_MS, onFault }: QuantumBound = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (error) {
        try {
          onFault?.(error);
        } catch {
          /* a fault sink is the caller's channel; it never re-enters the timer */
        }
      } finally {
        resolve();
      }
    }, bound);
  });
  return Promise.race([quantum.then(() => undefined, () => undefined), expired]).finally(() => clearTimeout(timer));
}
