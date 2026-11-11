import test, { type TestContext } from "node:test";

/**
 * Wall-clock oracles run in a separate serial lane so process CPU samples and
 * endpoint-gap observations include only the fixture under test: a service
 * roll, a store oracle or a responsiveness probe measures the host as much as
 * the code, and under the parallel suite's fixture contention it measures
 * starvation instead. Files that import this module are selected into
 * `npm run test:timing` by their source marker; their serial tests skip the
 * parallel suite and run there once, alone, one test at a time.
 * Only explicitly marked performance assertions may be inconclusive under load;
 * fixture, functional, timeout and runner failures always fail the lane.
 */
export const TIMING_PREFIX = "timing: ";

/**
 * The skip gate every serial oracle registers under: live in the timing lane
 * (QUEUE_TEST_LANE=timing, set by scripts/test-timing.mjs), skipped with the lane command in
 * the parallel suite. The skip is visible in TAP, never a silent loss.
 */
export function serialTestOptions(): { skip: string | false } {
  return { skip: process.env.QUEUE_TEST_LANE === "timing" ? false : "serial wall-clock oracle; runs alone in npm run test:timing" };
}

export function timingTest(name: string, fn: (t: TestContext) => void | Promise<void>): void;
export function timingTest(name: string, options: { timeout?: number; skip?: string | false }, fn: (t: TestContext) => void | Promise<void>): void;
export function timingTest(name: string, optionsOrFn: unknown, maybeFn?: unknown): void {
  const [options, fn] = typeof optionsOrFn === "function"
    ? [{}, optionsOrFn as (t: TestContext) => void | Promise<void>]
    : [optionsOrFn as { timeout?: number; skip?: string | false }, maybeFn as (t: TestContext) => void | Promise<void>];
  test(TIMING_PREFIX + name, { ...serialTestOptions(), ...options }, fn);
}

/** Mark only a measured wall-clock or CPU budget assertion, never fixture setup. */
export function performanceAssert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    const error = new Error(message);
    Object.assign(error, { code: "NUCLEUS_PERFORMANCE_ORACLE" });
    throw error;
  }
}
