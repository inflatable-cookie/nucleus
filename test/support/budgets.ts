import assert from "node:assert/strict";

/**
 * Timeout for test hooks that are expected to finish. It is a ceiling, not a
 * measurement: a hook that finishes returns in milliseconds, so only a stalled
 * host ever uses it. It sits at the hook schema's maximum because a 30 s ceiling
 * was not enough: on 2026-09-29 a host at load ~57 stalled every test process for
 * about 30 s at once, and three unrelated tests in two files held at exactly the
 * ceiling (32.3 s each) with no code fault. Tests that exercise the timeout itself
 * set their own short value.
 */
export const HOOK_TEST_TIMEOUT_MS = 120_000;

/** Half the test-file budget; 30s was too short on a heavily loaded host. */
export const HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS = 60_000;

/**
 * Answer window for a mock that answers at once, and ceiling on the positive wait
 * after it. Neither is ever used up: both end when the answer lands, and a short
 * one only closes first on a busy host (real windows are about ten minutes).
 */
export const ANSWERING_WINDOW_MS = 30_000;

/** Poll a condition every 25 ms until it holds or the ceiling passes. */
export async function waitFor(check: () => boolean, timeoutMs = HOOK_TEST_TIMEOUT_MS, message = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail(`Timed out waiting for ${message}`);
}
