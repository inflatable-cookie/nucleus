import assert from 'node:assert/strict';

/**
 * A background promise observed at creation. Its outcome is retained, never a
 * detached rejecting chain, so a test asserts ordinary completion later and a
 * failure path cannot raise a secondary unhandled rejection. A rejection with
 * any value, `null` and `undefined` included, is `ok: false`.
 */
export type BackgroundOutcome = { ok: true } | { ok: false; error: unknown };

export function observeOutcome(promise: Promise<unknown>): Promise<BackgroundOutcome> {
  return promise.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
}

/** Bounded rendering of a retained error that cannot itself throw. */
export function describeError(error: unknown): string {
  try {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch { return 'unrenderable error'; }
}

/** The requested background work completed: any failure, a stop included, fails the test. */
export async function assertCompleted(outcome: Promise<BackgroundOutcome>, label: string): Promise<void> {
  const settled = await outcome;
  if (!settled.ok) assert.fail(`${label} did not complete: ${describeError(settled.error)}`);
}

/** engine.ts STOPPED_BEFORE_DRAIN: the documented #609 waiter rejection when the engine stops first. */
export const STOPPED_BEFORE_DRAIN_MESSAGE = 'Nucleus engine stopped before the requested reconciliation drain covered the fleet';

/**
 * Cleanup after an earlier failure, once the fixture is stopped. Never waits on
 * unsettled work: a still-pending outcome is reported, not awaited. The exact
 * STOPPED_BEFORE_DRAIN is the expected consequence of stopping early; any other
 * failure is a bounded secondary diagnostic. Returns null when nothing to report.
 */
export async function cleanupDiagnostic(outcome: Promise<BackgroundOutcome> | undefined, label: string): Promise<string | null> {
  if (!outcome) return null;
  const pending = Symbol('pending');
  const settled = await Promise.race([outcome, new Promise<typeof pending>(resolve => setImmediate(() => resolve(pending)))]);
  if (settled === pending) return `${label} was still pending at cleanup`;
  if (settled.ok) return null;
  if (settled.error instanceof Error && settled.error.message === STOPPED_BEFORE_DRAIN_MESSAGE) return null;
  return `${label} failed: ${describeError(settled.error)}`;
}
