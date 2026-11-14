/**
 * The pressure projection (Spec 059): pure logic over one subscription's
 * windows. Per window the uniform pace is `u / e` — used fraction over elapsed
 * fraction — and the dial is `clamp(log2 pace, -1, 1)` (centre on track,
 * right red runs out, left green spare), damped toward centre early in a
 * window and pinned right once the window is fully used. The binding window
 * is whichever hits 100% earliest before its own reset.
 */
import type {
  UsagePressureState,
  UsageProjection,
  UsageWindowProjection,
} from "./schema/usage";

/** A window as the projection reads it: straight from a reading or a sample row. */
export interface UsageProjectionWindow {
  windowId: string;
  name: string;
  usedFraction: number;
  windowSeconds: number | null;
  windowStartsAt: string | null;
  resetsAt: string | null;
  notStarted?: boolean;
}

export interface UsageProjectionInput {
  now: number;
  windows: readonly UsageProjectionWindow[];
}

/** The dial dead zone around pace 1 that still reads "on track" (about ±3.5%). */
export const USAGE_ON_TRACK_EPSILON = 0.05;
/** Minimum elapsed fraction before window usage is extrapolated into pace. */
export const USAGE_DAMPING_ELAPSED = 0.05;
/**
 * The projected use at reset caps at twice the window: the dial pins at pace 2
 * (`log2 2 = 1`), so a projection past 200% carries no extra meaning.
 */
export const USAGE_PROJECTED_USE_CAP = 2;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** One window's length in ms, from its seconds or its own start and reset. */
export function usageWindowLengthMs(
  window: UsageProjectionWindow,
): number | null {
  if (finite(window.windowSeconds) && window.windowSeconds > 0)
    return window.windowSeconds * 1000;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null;
  const startsAt = window.windowStartsAt
    ? Date.parse(window.windowStartsAt)
    : null;
  if (!finite(resetsAt) || !finite(startsAt) || resetsAt <= startsAt)
    return null;
  return resetsAt - startsAt;
}

/** Elapsed fraction of one window, or null when the shape cannot say. */
export function usageWindowElapsed(
  window: UsageProjectionWindow,
  now: number,
): number | null {
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null;
  if (!finite(resetsAt) || resetsAt <= now) return null;
  const windowMs = usageWindowLengthMs(window);
  if (!finite(windowMs) || windowMs <= 0 || resetsAt - windowMs > now)
    return null;
  return clamp((windowMs - (resetsAt - now)) / windowMs, 0, 1);
}

/** Project one window, or null when its shape carries too little data to project. */
export function projectUsageWindow(
  window: UsageProjectionWindow,
  now: number,
): UsageWindowProjection | null {
  const used = clamp(window.usedFraction, 0, 1);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null;
  // A provider-confirmed null window is known to have no usage yet, although
  // there is no reset time until that window starts.
  if (window.notStarted && used <= 0)
    return {
      windowId: window.windowId,
      name: window.name,
      pace: 0,
      dial: -1,
      exhaustsInMs: null,
    };
  // The old reset is a known boundary. Once it passes, current usage is zero;
  // a new reset time is unknown until the provider supplies another sample.
  if (finite(resetsAt) && resetsAt <= now)
    return {
      windowId: window.windowId,
      name: window.name,
      pace: 0,
      dial: -1,
      exhaustsInMs: null,
    };
  const elapsed = usageWindowElapsed(window, now);
  // Fully used pins right until a known reset passes; with no reset it stays pinned.
  if (used >= 1) {
    return {
      windowId: window.windowId,
      name: window.name,
      pace: elapsed === null ? null : used / Math.max(elapsed, 1e-9),
      dial: 1,
      exhaustsInMs: 0,
    };
  }
  if (elapsed === null) return null;
  // No usage yet: the window cannot run out, however early it is.
  if (used <= 0)
    return {
      windowId: window.windowId,
      name: window.name,
      pace: 0,
      dial: -1,
      exhaustsInMs: null,
    };
  if (elapsed <= 0) return null;
  // Sparse early-window samples are too noisy to extrapolate. Hold a neutral
  // pace through the existing 5% damping interval; a full window still pins.
  const pace =
    elapsed < USAGE_DAMPING_ELAPSED
      ? (1 - used) / (1 - elapsed)
      : used / elapsed;
  const dialRaw = clamp(Math.log2(Math.max(pace, 1e-9)), -1, 1);
  const dial =
    elapsed < USAGE_DAMPING_ELAPSED
      ? dialRaw * (elapsed / USAGE_DAMPING_ELAPSED)
      : dialRaw;
  // Time to 100% only counts when it lands before this window's own reset —
  // pace above 1 is exactly that; otherwise the reset arrives first.
  const windowMs = usageWindowLengthMs(window);
  const exhaustsInMs =
    elapsed >= USAGE_DAMPING_ELAPSED && pace > 1 && finite(windowMs)
      ? ((1 - used) * windowMs) / pace
      : null;
  return {
    windowId: window.windowId,
    name: window.name,
    pace,
    dial,
    exhaustsInMs,
  };
}

/** Project a subscription's windows into the binding window and the pressure state. */
export function projectUsage(input: UsageProjectionInput): UsageProjection {
  const projected = input.windows
    .map((window) => projectUsageWindow(window, input.now))
    .filter((entry): entry is UsageWindowProjection => entry !== null);
  if (!projected.length) {
    return {
      state: "unknown",
      bindingWindowId: null,
      bindingWindowName: null,
      projectedUseAtReset: null,
      dial: null,
      windows: [],
    };
  }
  // Binding: whichever hits 100% earliest before its own reset; a fully used
  // window is exhausted now and binds regardless of its reset. With none
  // running out, the closest call (highest dial) names the dial.
  const resetsByWindow = new Map(
    input.windows.map((window) => [
      window.windowId,
      window.resetsAt ? Date.parse(window.resetsAt) : null,
    ]),
  );
  const runningOut = projected
    .filter(
      (candidate) =>
        candidate.exhaustsInMs === 0 ||
        (candidate.pace !== null &&
          candidate.pace > 1 &&
          candidate.exhaustsInMs !== null),
    )
    .map((candidate) => ({
      candidate,
      at: input.now + (candidate.exhaustsInMs ?? 0),
    }))
    .filter((entry) => {
      const reset = resetsByWindow.get(entry.candidate.windowId);
      return (
        entry.candidate.exhaustsInMs === 0 || !finite(reset) || entry.at < reset
      );
    })
    .sort((a, b) => a.at - b.at);
  const binding =
    runningOut[0]?.candidate ??
    [...projected].sort((a, b) => (b.dial ?? -1) - (a.dial ?? -1))[0]!;
  const state: UsagePressureState = runningOut.length
    ? "will_run_out"
    : Math.abs(binding.dial ?? 0) <= USAGE_ON_TRACK_EPSILON
      ? "on_track"
      : "spare";
  const bindingWindow = input.windows.find(
    (window) => window.windowId === binding.windowId,
  );
  const bindingReset = bindingWindow?.resetsAt
    ? Date.parse(bindingWindow.resetsAt)
    : null;
  // The projected share at reset keeps its over-projection (a pace above 1 lands
  // past 100%, the "+18% over" the dial label shows, schema-capped at 2); a fully
  // used window is already at 100% and cannot exceed it.
  const projectedUse =
    bindingWindow?.notStarted ||
    (finite(bindingReset) && bindingReset <= input.now)
      ? 0
      : !bindingWindow || binding.pace === null
      ? bindingWindow && bindingWindow.usedFraction >= 1
        ? 1
        : null
      : bindingWindow.usedFraction >= 1
        ? 1
        : clamp(
            bindingWindow.usedFraction +
              binding.pace *
                (1 - (usageWindowElapsed(bindingWindow, input.now) ?? 0)),
            0,
            USAGE_PROJECTED_USE_CAP,
          );
  return {
    state,
    bindingWindowId: binding.windowId,
    bindingWindowName: binding.name,
    projectedUseAtReset: projectedUse,
    dial: binding.dial,
    windows: projected,
  };
}
