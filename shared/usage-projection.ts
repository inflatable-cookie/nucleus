/**
 * The pressure projection (Spec 059): pure logic over one subscription's
 * windows and its recent stored samples. Per window the uniform pace is
 * `u / e` — used fraction over elapsed fraction — blended with recent burn
 * from the samples; the dial is `clamp(log2 pace, -1, 1)` (centre on track,
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
}

/** One stored sample used for the recent-burn blend. */
export interface UsageBurnSample {
  windowId: string;
  usedFraction: number;
  sampledAt: string;
}

export interface UsageProjectionInput {
  now: number;
  windows: readonly UsageProjectionWindow[];
  /** Samples within the recent-burn horizon; the caller filters the window. */
  burn?: readonly UsageBurnSample[];
  /** How far back recent burn counts; one hour (Spec 059). */
  burnHorizonMs?: number;
}

/** The dial dead zone around pace 1 that still reads "on track" (about ±3.5%). */
export const USAGE_ON_TRACK_EPSILON = 0.05;
/** A window earlier in its life than this fraction has its dial damped toward centre. */
export const USAGE_DAMPING_ELAPSED = 0.05;
const DEFAULT_BURN_HORIZON_MS = 60 * 60 * 1000;

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

/** Recent burn as a pace (usage fraction per window), or null when samples cannot say. */
function recentBurnPace(
  window: UsageProjectionWindow,
  burn: readonly UsageBurnSample[],
  now: number,
  horizonMs: number,
): number | null {
  const elapsed = usageWindowElapsed(window, now);
  if (elapsed === null) return null;
  const windowMs = usageWindowLengthMs(window);
  if (!finite(windowMs)) return null;
  const relevant = burn
    .filter((sample) => sample.windowId === window.windowId)
    .map((sample) => ({
      at: Date.parse(sample.sampledAt),
      used: sample.usedFraction,
    }))
    .filter((sample) => finite(sample.at) && finite(sample.used))
    .filter((sample) => sample.at >= now - horizonMs && sample.at <= now)
    .sort((a, b) => a.at - b.at);
  if (relevant.length < 2) return null;
  const first = relevant[0]!;
  const last = relevant[relevant.length - 1]!;
  const dtMs = last.at - first.at;
  if (dtMs <= 0) return null;
  const du = last.used - first.used;
  // Fractions per window-time; a window sampled across less than a quarter of
  // the horizon says little, so it never overrules the uniform pace alone.
  if (dtMs < horizonMs / 4) return null;
  return du / (dtMs / windowMs);
}

/** Project one window, or null when its shape carries too little data to project. */
export function projectUsageWindow(
  window: UsageProjectionWindow,
  now: number,
  burn: readonly UsageBurnSample[] = [],
  burnHorizonMs = DEFAULT_BURN_HORIZON_MS,
): UsageWindowProjection | null {
  const used = clamp(window.usedFraction, 0, 1);
  const elapsed = usageWindowElapsed(window, now);
  // Fully used pins right whatever the clock says.
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
  const uniform = used / elapsed;
  const recent = recentBurnPace(window, burn, now, burnHorizonMs);
  const pace =
    recent !== null && recent >= 0
      ? clamp(0.5 * uniform + 0.5 * recent, 0, 1e6)
      : uniform;
  const dialRaw = clamp(Math.log2(Math.max(pace, 1e-9)), -1, 1);
  const dial =
    elapsed < USAGE_DAMPING_ELAPSED
      ? dialRaw * (elapsed / USAGE_DAMPING_ELAPSED)
      : dialRaw;
  // Time to 100% only counts when it lands before this window's own reset —
  // pace above 1 is exactly that; otherwise the reset arrives first.
  const windowMs = usageWindowLengthMs(window);
  const exhaustsInMs =
    pace > 1 && finite(windowMs) ? ((1 - used) * windowMs) / pace : null;
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
  const horizon = input.burnHorizonMs ?? DEFAULT_BURN_HORIZON_MS;
  const projected = input.windows
    .map((window) =>
      projectUsageWindow(window, input.now, input.burn ?? [], horizon),
    )
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
  // Binding: whichever hits 100% earliest before its own reset; with none
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
        candidate.exhaustsInMs !== null &&
        candidate.pace !== null &&
        candidate.pace > 1,
    )
    .map((candidate) => ({
      candidate,
      at: input.now + (candidate.exhaustsInMs ?? 0),
    }))
    .filter((entry) => {
      const reset = resetsByWindow.get(entry.candidate.windowId);
      return !finite(reset) || entry.at < reset;
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
  const windowMsByName = new Map(
    input.windows.map((window) => [window.windowId, window]),
  );
  const bindingWindow = windowMsByName.get(binding.windowId);
  const projectedUse =
    bindingWindow && binding.pace !== null
      ? clamp(
          bindingWindow.usedFraction +
            binding.pace *
              (1 - (usageWindowElapsed(bindingWindow, input.now) ?? 0)),
          0,
          1,
        )
      : null;
  return {
    state,
    bindingWindowId: binding.windowId,
    bindingWindowName: binding.name,
    projectedUseAtReset: projectedUse,
    dial: binding.dial,
    windows: projected,
  };
}
