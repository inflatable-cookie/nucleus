/**
 * Pure-sample regressions for the host-run roll oracle's measurement rules
 * (Spec 035, "Endpoint across a roll"): every covered refusal interval is
 * measured consistently, boundary intervals are measured through the covered
 * pre-window sample, and missing recovery, missing coverage and unmeasurable
 * interval starts stay failures. No service, no sockets, no wall clock: these
 * pin the oracle, while test/host-run-roll.test.ts proves the real endpoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRefusals, gapIn, PROBE_COVERAGE_MS, type ProbeSample, type RollWindow } from "./support/roll-oracle";

const ok = (at: number): ProbeSample => ({ at, ok: true });
const fail = (at: number, code = "ECONNREFUSED"): ProbeSample => ({ at, ok: false, code });

/** A dense ok run: one accept every 10 ms from `start`, `count` samples. */
const okRun = (start: number, count: number): ProbeSample[] => Array.from({ length: count }, (_, index) => ok(start + index * 10));

const window = (from: number, to: number): RollWindow => ({ roll: 1, from, to });

test("a refusal straddling the window start is measured through the covered pre-window sample", () => {
  // Last accept before the window, refusals from the first in-window sample:
  // the boundary interval is genuinely measurable, and searching for the last
  // accept only inside the window would wrongly reject it.
  const samples = [...okRun(0, 10), fail(100), fail(110), ok(120), ...okRun(130, 10)];
  const gap = gapIn(samples, 100, 240);
  assert.equal(gap, 30, "the gap spans the boundary accept at +90 ms to the first recovery at +120 ms");
});

test("a refusal interval that started before the window is measured from its last accept", () => {
  const samples = [...okRun(0, 5), fail(50), fail(60), fail(70), fail(80), ok(90), ...okRun(100, 20)];
  const gap = gapIn(samples, 75, 295);
  assert.equal(gap, 50, "the walk back through dense failing samples starts at the +40 ms accept");
});

test("an ordinary recovered in-window refusal measures last accept to first recovery", () => {
  const samples = [...okRun(0, 10), fail(100), fail(110), fail(120), ok(130), ...okRun(140, 10)];
  assert.equal(gapIn(samples, 0, 240), 40);
});

test("a window with no refusal measures zero", () => {
  assert.equal(gapIn(okRun(0, 25), 0, 240), 0);
});

test("a refusal that never recovers anywhere in the observed lifetime fails instead of passing", () => {
  const samples = [...okRun(0, 10), ...Array.from({ length: 15 }, (_, index) => fail(100 + index * 10))];
  assert.throws(() => gapIn(samples, 0, 240), /never recovered to an accept anywhere in the observed lifetime/);
});

test("a refusal straddling the window end is measured through the observer's continuing lifetime", () => {
  // The refusal begins 20 ms before the window end and recovers just past it:
  // the interval is fully observed, so it is measured in full instead of
  // failing on the window's own boundary.
  const samples = [...okRun(0, 10), ok(100), fail(110), fail(120), ok(130), ...okRun(140, 10)];
  assert.equal(gapIn(samples, 0, 130), 30, "last accept +100, first recovery +130");
});

test("a refusal whose recovery sits behind a probe hole fails instead of guessing", () => {
  const samples = [...okRun(0, 10), ok(100), fail(110), fail(600), ok(610), ...okRun(620, 10)];
  assert.throws(() => gapIn(samples, 0, 130), /recovery cannot be measured/);
});

test("sparse coverage inside the window fails instead of reporting a vacuous gap", () => {
  const samples = [ok(0), ok(90), fail(300), ok(310), ...okRun(320, 5)];
  assert.throws(() => gapIn(samples, 100, 400), /without a sample inside the roll window/);
});

test("an unmeasurable interval start, behind a probe hole, fails instead of guessing", () => {
  // The refusal runs from before the window, but the probe went silent for
  // longer than the coverage bound inside the failing run: the interval's
  // start is unobserved.
  const samples = [...okRun(0, 5), fail(50), fail(400), fail(410), ok(420), ...okRun(430, 20)];
  assert.throws(() => gapIn(samples, 405, 625), /start cannot be measured/);
});

test("a refusal with no accept ever observed has no measured start and is not a pass", () => {
  const samples = [fail(0), fail(10), ok(20), ...okRun(30, 10)];
  assert.throws(() => gapIn(samples, 5, 140), /no measured start/);
});

test("an unobserved window edge fails: the roll was not observed", () => {
  assert.throws(() => gapIn([ok(0), ...okRun(500, 5)], 200, 560), /first window sample is .* from the window start/);
  const samples = [...okRun(0, 10), fail(100)];
  assert.throws(() => gapIn(samples, 0, 340), /short of the window end/);
});

test("every covered refusal interval is named with phase, codes and neighbour accepts", () => {
  const samples = [
    ...okRun(0, 10),
    fail(100), fail(110), ok(120),
    ...okRun(130, 5),
    fail(350, "ENOENT"), fail(360, "ENOENT"),
    ...okRun(500, 10),
  ];
  const windows: RollWindow[] = [window(90, 200), window(500, 610)];
  windows[0]!.roll = 1;
  windows[1]!.roll = 2;
  const report = describeRefusals(samples, windows);
  assert.match(report, /4 refused samples/, "two intervals of two refused samples each");
  assert.match(report, /refusal 1: 10 ms of ECONNREFUSED starting \+100 ms into the probe, inside roll 1's measured window; last accept \+90 ms, next accept \+120 ms/);
  assert.match(report, /refusal 2: 10 ms of ENOENT starting \+350 ms into the probe, between roll 1's and roll 2's windows, 150 ms after roll 1's window end; last accept \+170 ms, next accept \+500 ms/);
});

test("a clean probe lifetime reports no refusal evidence", () => {
  assert.equal(describeRefusals(okRun(0, 10), [window(0, 100)]), "");
});

test("refusal evidence is bounded at exactly ten intervals", () => {
  const samples: ProbeSample[] = [];
  for (let index = 0; index < 12; index++) {
    const base = index * 40;
    samples.push(ok(base), fail(base + 10, `ERR_${index}`), ok(base + 20));
  }
  const report = describeRefusals(samples, [window(0, 10_000)]);
  assert.match(report, /truncated at 10 intervals/);
  assert.equal(report.split("refusal ").length - 1, 10, "at most ten intervals are printed");
  assert.match(report, /refusal 10: .*ERR_9/, "the tenth interval is present");
  assert.doesNotMatch(report, /ERR_10/);
  assert.doesNotMatch(report, /ERR_11/);
});

test("the coverage bound stays a probe property, not a contract budget", () => {
  assert.equal(PROBE_COVERAGE_MS, 100);
});
