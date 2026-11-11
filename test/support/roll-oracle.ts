/**
 * The host-run roll oracle's pure measurement core (Spec 035, "Endpoint across
 * a roll"). Split from test/host-run-roll.test.ts so deterministic pure-sample
 * regressions can pin the measurement rules without spawning a service; the
 * real rolls in that file remain the endpoint-behavior proof and substitute no
 * synthetic evidence for it.
 */
import assert from "node:assert/strict";

/**
 * The observer's own bound: a silent stretch longer than this inside a
 * measured window means the probe cannot prove what the endpoint did, so the
 * observation fails instead of passing on a missing sample. It is a property
 * of this probe, not a contract budget; the healthy cadence is one attempt
 * every ~5-15 ms against the contract's 500 ms handoff bound.
 */
export const PROBE_COVERAGE_MS = 100;

export interface ProbeSample { at: number; ok: boolean; code?: string }

/** One measured roll window, for naming where a lifetime refusal landed. */
export interface RollWindow { roll: number; from: number; to: number }

/**
 * Gap between the last accept before the first refusal in the window and the
 * first accept after it — but only when the probe provably covered the window:
 * a sample lands at each edge within the coverage bound and no consecutive
 * silence inside the window exceeds it. Without that proof a refusal could
 * hide between sparse samples, so the window fails rather than reporting a
 * vacuous gap of zero. Both interval edges are measured across the window
 * edges, never only inside: the covered chain includes the bounded
 * pre-window sample, so a refusal that straddles the window start is measured
 * through it, and the recovery is searched through the window end across the
 * observer's continuing lifetime — the probe kept sampling after `to`, so a
 * short interval that straddles the end is measured instead of failing on the
 * window's own boundary. Walking either way follows the probe's own dense
 * samples and stops at a hole longer than the coverage bound, where that
 * interval edge is unobserved. A refusal that never recovered anywhere in the
 * observed lifetime, and an unmeasurable interval edge, stay failures;
 * neither is turned into a pass or a vacuous zero.
 */
export function gapIn(samples: ProbeSample[], from: number, to: number): number {
  const inside = samples.filter(sample => sample.at >= from && sample.at <= to);
  const before = samples.findLast(sample => sample.at < from);
  const chain = [...(before ? [before] : []), ...inside];
  const first = chain[0], last = chain.at(-1);
  if (!first || !last) assert.fail("the probe recorded no samples inside the roll window");
  assert.ok(first.at >= from - PROBE_COVERAGE_MS && first.at <= from + PROBE_COVERAGE_MS,
    `the probe's first window sample is ${Math.abs(first.at - from).toFixed(0)} ms from the window start; the roll was not observed`);
  assert.ok(last.at >= to - PROBE_COVERAGE_MS,
    `the probe's last window sample is ${(to - last.at).toFixed(0)} ms short of the window end; the roll was not observed to its end`);
  for (let index = 1; index < chain.length; index++) {
    const silence = chain[index].at - chain[index - 1].at;
    assert.ok(silence <= PROBE_COVERAGE_MS,
      `the probe went ${silence.toFixed(0)} ms without a sample inside the roll window; the endpoint gap cannot be proven from this observation`);
  }
  const firstFail = chain.findIndex(sample => !sample.ok);
  if (firstFail < 0) return 0;
  // chain[k] is samples[start + k]: the pre-window sample when present, else
  // the first sample at or after the window start. Walk back from the first
  // refusal to the last accept, across the window edge when the interval
  // straddles one; every consecutive silence along that path must stay within
  // the coverage bound, so a hole makes the interval's start unobserved and
  // the window fails instead of measuring across unobserved time.
  const start = before ? samples.indexOf(before) : samples.findIndex(sample => sample.at >= from);
  let lastOk: ProbeSample | undefined;
  for (let index = start + firstFail; index >= 0; index--) {
    const sample = samples[index]!;
    if (sample.ok) { lastOk = sample; break; }
    if (index > 0 && sample.at - samples[index - 1]!.at > PROBE_COVERAGE_MS) {
      assert.fail(`the refusal interval's start cannot be measured: the probe went ${(sample.at - samples[index - 1]!.at).toFixed(0)} ms without a sample before the first refusal; the observation does not cover the interval's start`);
    }
  }
  assert.ok(lastOk, "the probe recorded no accept before the refusal; the gap has no measured start and is not a pass");
  // And forward from the first refusal to the first recovery, through the
  // window's end edge across the observer's continuing lifetime, under the
  // same density rule: a refusal that recovers just past the window end is
  // measured in full, a refusal that never recovers anywhere in the observed
  // lifetime fails, and a probe hole leaves the recovery unmeasured.
  let nextOk: ProbeSample | undefined;
  for (let index = start + firstFail; index < samples.length; index++) {
    const sample = samples[index]!;
    if (sample.ok) { nextOk = sample; break; }
    if (index + 1 < samples.length && samples[index + 1]!.at - sample.at > PROBE_COVERAGE_MS) {
      assert.fail(`the refusal interval's recovery cannot be measured: the probe went ${(samples[index + 1]!.at - sample.at).toFixed(0)} ms without a sample after the refusal; the observation does not cover the interval's end`);
    }
  }
  assert.ok(nextOk, "the refusal never recovered to an accept anywhere in the observed lifetime; the endpoint did not come back");
  return nextOk.at - lastOk.at;
}

/** Bounded per-attempt evidence for the follower's reconnect refusals. */
export function describeFollowerRefusals(refused: Array<{ code: string; at: number }>): string {
  if (refused.length === 0) return "none";
  const shown = refused.slice(0, 10).map(refusal => `${refusal.code} at +${refusal.at.toFixed(0)} ms`).join(", ");
  return refused.length > 10 ? `${shown}, and ${refused.length - 10} more` : shown;
}

/**
 * Bounded evidence for the lifetime refusal assertions: every refusal interval
 * across the probe's whole lifetime — the measured windows and the margins
 * between them included — named by phase, with its duration, error codes and
 * the measured accepts on each side. Diagnostic text only: the caller's
 * assertion still fails on every refusal it did not already fail on.
 */
export function describeRefusals(samples: ProbeSample[], windows: RollWindow[]): string {
  if (!samples.some(sample => !sample.ok)) return "";
  const t0 = samples[0]?.at ?? 0;
  const lines: string[] = [];
  for (let index = 0; index < samples.length && lines.length < 10; index++) {
    if (samples[index]!.ok) continue;
    let end = index;
    while (end + 1 < samples.length && !samples[end + 1]!.ok) end++;
    const startedAt = samples[index]!.at, endedAt = samples[end]!.at;
    const lastOk = samples.slice(0, index).findLast(sample => sample.ok);
    const nextOk = samples.slice(end + 1).find(sample => sample.ok);
    const codes = [...new Set(samples.slice(index, end + 1).map(sample => sample.code).filter(Boolean))].join(",") || "unknown";
    const insideWindow = windows.find(window => startedAt >= window.from && startedAt <= window.to)
      ?? windows.find(window => endedAt >= window.from && endedAt <= window.to);
    const previousWindow = windows.filter(window => window.to < startedAt).at(-1);
    const nextWindow = windows.find(window => window.from > startedAt);
    const phase = insideWindow
      ? `inside roll ${insideWindow.roll}'s measured window`
      : previousWindow && nextWindow
        ? `between roll ${previousWindow.roll}'s and roll ${nextWindow.roll}'s windows, ${(startedAt - previousWindow.to).toFixed(0)} ms after roll ${previousWindow.roll}'s window end`
        : previousWindow
          ? `${(startedAt - previousWindow.to).toFixed(0)} ms after roll ${previousWindow.roll}'s window end`
          : nextWindow
            ? `${(nextWindow.from - startedAt).toFixed(0)} ms before roll ${nextWindow.roll}'s window start`
            : "outside every measured window";
    lines.push(`refusal ${lines.length + 1}: ${(endedAt - startedAt).toFixed(0)} ms of ${codes} starting +${(startedAt - t0).toFixed(0)} ms into the probe, ${phase}; last accept ${lastOk ? `+${(lastOk.at - t0).toFixed(0)} ms` : "none"}, next accept ${nextOk ? `+${(nextOk.at - t0).toFixed(0)} ms` : "none observed"}`);
    index = end;
  }
  const total = samples.filter(sample => !sample.ok).length;
  const more = lines.length < 10 ? "" : "; truncated at 10 intervals";
  return `${total} refused sample${total === 1 ? "" : "s"} in the probe's lifetime${more}: ${lines.join(" | ")}${more}`;
}
