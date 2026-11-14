import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectUsage,
  projectUsageWindow,
  usageWindowElapsed,
  USAGE_ON_TRACK_EPSILON,
} from "../shared/usage-projection";
import type { UsageProjectionWindow } from "../shared/usage-projection";

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;
// Wednesday noon inside a week that resets the following Saturday: exactly half the window elapsed.
const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const RESET = NOW + 3.5 * 24 * HOUR;

function window(
  overrides: Partial<UsageProjectionWindow> = {},
): UsageProjectionWindow {
  return {
    windowId: "weekly",
    name: "Weekly",
    usedFraction: 0.5,
    windowSeconds: WEEK / 1000,
    windowStartsAt: null,
    resetsAt: new Date(RESET).toISOString(),
    ...overrides,
  };
}

test("a window on pace lands at the centre of the dial", () => {
  // Half the window elapsed, half the usage: pace 1, dial 0, no exhaustion.
  const half = window({ usedFraction: 0.5 });
  assert.equal(usageWindowElapsed(half, NOW), 0.5);
  const projected = projectUsageWindow(half, NOW);
  assert.ok(projected);
  assert.equal(projected.pace, 1);
  assert.equal(Math.abs(projected.dial!), 0);
  assert.equal(
    projected.exhaustsInMs,
    null,
    "on pace there is no exhaustion before the reset",
  );
  const subscription = projectUsage({ now: NOW, windows: [half] });
  assert.equal(subscription.state, "on_track");
  assert.equal(subscription.bindingWindowId, "weekly");
  assert.equal(subscription.projectedUseAtReset, 1);
});

test("spare: slower burn than the window leaves green on the left", () => {
  const projected = projectUsageWindow(window({ usedFraction: 0.25 }), NOW);
  assert.ok(projected);
  assert.equal(projected.pace, 0.5);
  assert.ok(projected.dial! < -USAGE_ON_TRACK_EPSILON);
  assert.ok(projected.dial! >= -1);
  const subscription = projectUsage({
    now: NOW,
    windows: [window({ usedFraction: 0.25 })],
  });
  assert.equal(subscription.state, "spare");
  assert.equal(subscription.projectedUseAtReset, 0.5);
});

test("run-out: faster burn than the window turns red and names the exhaustion time", () => {
  const projected = projectUsageWindow(window({ usedFraction: 0.8 }), NOW);
  assert.ok(projected);
  assert.equal(projected.pace, 1.6);
  assert.ok(
    Math.abs(projected.dial! - Math.log2(1.6)) < 1e-9,
    "the dial is log2 of the pace",
  );
  // (1 - 0.8) * week / 1.6 = 0.875 days (21 hours) until 100%.
  assert.ok(Math.abs(projected.exhaustsInMs! - 0.875 * 24 * HOUR) < 1000);
  const subscription = projectUsage({
    now: NOW,
    windows: [window({ usedFraction: 0.8 })],
  });
  assert.equal(subscription.state, "will_run_out");
  assert.equal(subscription.bindingWindowId, "weekly");
  // The projection keeps its over-shot for the dial's "+X% over" label:
  // 0.8 used at pace 1.6 lands at 160%, not clamped to 100.
  assert.ok(Math.abs(subscription.projectedUseAtReset! - 1.6) < 1e-9);
});

test("early samples hold a neutral pace through the first 5% of a window", () => {
  // Four minutes into a week with 1% used is too little evidence to extrapolate.
  const fourMinutes = 4 * 60_000;
  const early = window({
    usedFraction: 0.01,
    resetsAt: new Date(NOW + WEEK - fourMinutes).toISOString(),
  });
  const raw = Math.log2(0.01 / (fourMinutes / WEEK));
  assert.ok(
    raw > 1,
    "the raw pace must exceed the dial range for this case to say anything",
  );
  const projected = projectUsageWindow(early, NOW);
  assert.ok(projected);
  assert.ok(projected.pace! < 1);
  assert.ok(Math.abs(projected.dial!) <= USAGE_ON_TRACK_EPSILON);
  assert.equal(projected.exhaustsInMs, null);
});

test("2% used one hour after a weekly reset does not project a runout", () => {
  const oneHourAfterReset = window({
    usedFraction: 0.02,
    resetsAt: new Date(NOW + WEEK - HOUR).toISOString(),
  });
  const projection = projectUsage({ now: NOW, windows: [oneHourAfterReset] });
  assert.equal(projection.state, "on_track");
  assert.ok(projection.windows[0]!.pace! < 1);
  assert.equal(projection.windows[0]!.exhaustsInMs, null);
});

test("used fraction ahead of elapsed fraction is red regardless of recent samples", () => {
  const usage = window({
    usedFraction: 0.57,
    resetsAt: new Date(NOW + 0.58 * WEEK).toISOString(),
  });
  const first = projectUsage({ now: NOW, windows: [usage] });
  const afterQuietHour = projectUsage({ now: NOW, windows: [usage] });
  assert.ok(first.dial! > USAGE_ON_TRACK_EPSILON);
  assert.equal(first.state, "will_run_out");
  assert.ok(Math.abs(first.windows[0]!.pace! - 0.57 / 0.42) < 1e-9);
  assert.deepEqual(afterQuietHour, first);
});

test("several windows bind to whichever hits 100% earliest before its own reset", () => {
  const short = window({
    windowId: "5-hour",
    name: "5-hour",
    usedFraction: 0.9,
    windowSeconds: (5 * HOUR) / 1000,
    resetsAt: new Date(NOW + 2 * HOUR).toISOString(),
  });
  const weekly = window({ usedFraction: 0.8 });
  const subscription = projectUsage({ now: NOW, windows: [weekly, short] });
  assert.equal(subscription.state, "will_run_out");
  assert.equal(subscription.bindingWindowId, "5-hour");
  assert.equal(subscription.bindingWindowName, "5-hour");
  assert.ok(
    Math.abs(subscription.dial! - Math.log2(1.5)) < 1e-9,
    "the dial is the binding window's",
  );
  assert.ok(subscription.windows.length === 2);
});

test("fully used pins right at zero time to exhaustion", () => {
  const full = window({ usedFraction: 1 });
  const projected = projectUsageWindow(full, NOW);
  assert.ok(projected);
  assert.equal(projected.dial, 1);
  assert.equal(projected.exhaustsInMs, 0);
  const subscription = projectUsage({ now: NOW, windows: [full] });
  assert.equal(subscription.state, "will_run_out");
  assert.equal(subscription.projectedUseAtReset, 1);
});

test("a fully used window pins until its known reset, or indefinitely without one", () => {
  for (const resetsAt of [new Date(NOW + HOUR).toISOString(), null]) {
    const exhausted = window({ usedFraction: 1, resetsAt });
    const projected = projectUsageWindow(exhausted, NOW);
    assert.ok(projected);
    assert.equal(projected.dial, 1);
    assert.equal(projected.exhaustsInMs, 0);
    const subscription = projectUsage({ now: NOW, windows: [exhausted] });
    assert.equal(subscription.state, "will_run_out");
    assert.equal(subscription.bindingWindowId, "weekly");
    assert.equal(subscription.dial, 1);
    assert.equal(subscription.projectedUseAtReset, 1);
  }
  const reset = window({ usedFraction: 1, resetsAt: new Date(NOW - HOUR).toISOString() });
  const projection = projectUsage({ now: NOW, windows: [reset] });
  assert.equal(projection.state, "spare");
  assert.equal(projection.projectedUseAtReset, 0);
});

test("a reset full window no longer binds ahead of an active fast window", () => {
  const exhausted = window({
    windowId: "spent",
    name: "Spent",
    usedFraction: 1,
    resetsAt: new Date(NOW - HOUR).toISOString(),
  });
  const fast = window({ usedFraction: 0.8 });
  const subscription = projectUsage({ now: NOW, windows: [fast, exhausted] });
  assert.equal(subscription.state, "will_run_out");
  assert.equal(subscription.bindingWindowId, "weekly");
});

test("no usable window projects unknown, never zero", () => {
  const noReset = window({ resetsAt: null });
  assert.equal(usageWindowElapsed(noReset, NOW), null);
  assert.equal(projectUsageWindow(noReset, NOW), null);
  const subscription = projectUsage({ now: NOW, windows: [noReset] });
  assert.equal(subscription.state, "unknown");
  assert.equal(subscription.bindingWindowId, null);
  assert.equal(subscription.dial, null);
});

test("a billing period can carry the window length instead of windowSeconds", () => {
  const period = window({
    windowId: "credits",
    name: "Credits",
    windowSeconds: null,
    windowStartsAt: new Date(NOW - 15 * 24 * HOUR).toISOString(),
    resetsAt: new Date(NOW + 15 * 24 * HOUR).toISOString(),
  });
  assert.equal(usageWindowElapsed(period, NOW), 0.5);
  const projected = projectUsageWindow({ ...period, usedFraction: 0.25 }, NOW);
  assert.ok(projected);
  assert.equal(projected.pace, 0.5);
});

test("a window whose reset passed projects as unused from that reset", () => {
  const stale = window({ resetsAt: new Date(NOW - HOUR).toISOString() });
  const projection = projectUsage({ now: NOW, windows: [stale] });
  assert.equal(projection.state, "spare");
  assert.equal(projection.dial, -1);
  assert.equal(projection.projectedUseAtReset, 0);
  assert.equal(projection.windows[0]!.pace, 0);
});

test("a confirmed not-started window projects as unused without a reset", () => {
  const inactive = window({
    windowId: "five_hour",
    name: "5-hour",
    usedFraction: 0,
    windowSeconds: 5 * 60 * 60,
    resetsAt: null,
    notStarted: true,
  });
  const projection = projectUsage({ now: NOW, windows: [inactive] });
  assert.equal(projection.state, "spare");
  assert.equal(projection.projectedUseAtReset, 0);
  assert.equal(projection.windows[0]!.dial, -1);
});

test("a window older than its own length never counts as started", () => {
  const ahead = window({ resetsAt: new Date(NOW + 2 * WEEK).toISOString() });
  assert.equal(usageWindowElapsed(ahead, NOW), null);
});
