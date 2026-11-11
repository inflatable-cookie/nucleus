import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psTimeMs } from '../core/machine/process-group';
import { awaitForeignReplacement, awaitStandbyProgress, STANDBY_READY_BUDGET_MS, STANDBY_READY_CAP_MS, STANDBY_READY_STALL_MS, type StandbyWaitProbe } from '../service/install/standby';

/**
 * A deterministic standby on a fake monotonic clock: `cpu(t)` is its cumulative
 * CPU at time t (null when unmeasurable), `readyAt` and `exitAt` are when it
 * reports loaded or exits. Sleeping advances the clock.
 */
function standby(options: { cpu: (t: number) => number | null; readyAt?: number; exitAt?: number; exitDuringSampleAt?: number; ticks?: number[]; replacedExitAt?: number }) {
  let t = 1_000_000;
  const start = t;
  const at = () => t - start;
  let samples = 0;
  const probe: StandbyWaitProbe = {
    ready: () => options.readyAt !== undefined && at() >= options.readyAt,
    alive: () => options.exitAt === undefined || at() < options.exitAt,
    replacedExited: () => options.replacedExitAt !== undefined && at() >= options.replacedExitAt,
    cpuMs: async () => {
      samples++;
      const value = options.cpu(at());
      // The process exits while `ps` runs: the reading arrives after the exit.
      if (options.exitDuringSampleAt !== undefined && at() >= options.exitDuringSampleAt) t += 1;
      return value;
    },
    now: () => t,
    sleep: async ms => { t += ms; },
    tick: () => { options.ticks?.push(t - start); },
  };
  return { probe, samples: () => samples };
}
const defaults = { stallMs: STANDBY_READY_STALL_MS, capMs: STANDBY_READY_CAP_MS, budgetMs: STANDBY_READY_BUDGET_MS, pollMs: 25 };
const busy = (t: number) => Math.floor(t / 2);

test('defaults: 5 s stall window, 120 s hard cap, 20 s wall-clock budget only when CPU is unmeasurable', () => {
  assert.equal(STANDBY_READY_STALL_MS, 5_000);
  assert.equal(STANDBY_READY_CAP_MS, 120_000);
  assert.equal(STANDBY_READY_BUDGET_MS, 20_000);
});

test('a standby whose CPU keeps advancing is waited for past the old 20 s wall-clock bound', async () => {
  const { probe } = standby({ cpu: busy, readyAt: 45_000 });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.warm, true);
  assert.equal(result.cause, 'ready');
  assert.ok(result.waitedMs >= 45_000 && result.waitedMs < 45_100, `waited ${result.waitedMs} ms`);
});

test('a standby whose CPU stops advancing is drained past one stall window after its last progress', async () => {
  // Loads for 8 s, then stops using CPU without reporting (blocked or hung).
  const { probe } = standby({ cpu: t => Math.floor(Math.min(t, 8_000) / 2) });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.cause, 'stalled');
  assert.equal(result.warm, false);
  assert.ok(result.waitedMs >= 13_000 && result.waitedMs <= 13_300, `stalled ${result.waitedMs} ms after start`);
});

test('a first CPU reading is a baseline, not progress: a flat standby stalls one window after the wait starts', async () => {
  const { probe } = standby({ cpu: () => 4_000 });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.cause, 'stalled');
  assert.ok(result.waitedMs >= 5_000 && result.waitedMs <= 5_300, `waited ${result.waitedMs} ms`);
  assert.equal(result.cpuMs, 4_000);
});

test('an unmeasurable reading is never progress', async () => {
  // Measurable at first, then every reading fails: the stall clock keeps running from the last real increase.
  const { probe } = standby({ cpu: t => t < 3_000 ? Math.floor(t / 2) : null });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.cause, 'stalled');
  assert.ok(result.waitedMs >= 7_750 && result.waitedMs <= 8_300, `waited ${result.waitedMs} ms`);
});

test('when CPU is never measurable, the 20 s wall-clock budget applies unchanged', async () => {
  const { probe } = standby({ cpu: () => null });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.cause, 'unmeasured_budget');
  assert.equal(result.cpuMs, null);
  assert.ok(result.waitedMs >= 20_000 && result.waitedMs <= 20_050, `waited ${result.waitedMs} ms`);
});

test('a standby that keeps using CPU but never reports is drained at the hard cap, which never re-arms', async () => {
  const { probe } = standby({ cpu: busy });
  const result = await awaitStandbyProgress(probe, defaults);
  assert.equal(result.cause, 'cap');
  assert.ok(result.waitedMs >= 120_000 && result.waitedMs <= 120_050, `capped at ${result.waitedMs} ms`);
});

test('an exited standby ends the wait at once, including an exit observed while a reading was in flight', async () => {
  const exited = await awaitStandbyProgress(standby({ cpu: busy, exitAt: 3_000 }).probe, defaults);
  assert.equal(exited.cause, 'exited');
  assert.ok(exited.waitedMs >= 3_000 && exited.waitedMs <= 3_050);
  const duringSample = standby({ cpu: busy, exitAt: 2_000, exitDuringSampleAt: 1_990 });
  const result = await awaitStandbyProgress(duringSample.probe, defaults);
  assert.equal(result.cause, 'exited');
  assert.equal(result.warm, false);
});

test('a ready marker wins over every bound, and the configured bounds scale the same rules', async () => {
  const scaled = { stallMs: 300, capMs: 1_000, budgetMs: 300, pollMs: 25 };
  assert.equal((await awaitStandbyProgress(standby({ cpu: busy, readyAt: 900 }).probe, scaled)).cause, 'ready', 'busy past the 300 ms budget and stall window');
  assert.equal((await awaitStandbyProgress(standby({ cpu: busy }).probe, scaled)).cause, 'cap');
  assert.equal((await awaitStandbyProgress(standby({ cpu: () => 7 }).probe, scaled)).cause, 'stalled');
  assert.equal((await awaitStandbyProgress(standby({ cpu: () => null }).probe, scaled)).cause, 'unmeasured_budget');
  const sampled = standby({ cpu: busy, readyAt: 10_000 });
  await awaitStandbyProgress(sampled.probe, defaults);
  assert.ok(sampled.samples() <= 45, `CPU is sampled at most every 250 ms (${sampled.samples()} readings in 10 s)`);
});

test('the wait ticks at least every 250 ms for as long as it lasts, so a spawn claim stays fresh past 45 s (Sol #593)', async () => {
  const ticks: number[] = [];
  await awaitStandbyProgress(standby({ cpu: busy, readyAt: 90_000, ticks }).probe, defaults);
  assert.ok(ticks.length >= 90_000 / 250 - 1, `${ticks.length} ticks in 90 s`);
  const gaps = ticks.slice(1).map((at, i) => at - ticks[i]!);
  assert.ok(Math.max(...gaps) <= 250, `the longest gap between ticks is ${Math.max(...gaps)} ms`);
  assert.ok(ticks.at(-1)! >= 89_750, 'ticks continue to the end of the wait');
});

test('ps CPU time parses Linux and macOS formats, including macOS total minutes past 99 (Sol #593)', () => {
  assert.equal(psTimeMs('0:01.50'), 1_500);
  assert.equal(psTimeMs('12:34'), 754_000);
  assert.equal(psTimeMs(' 01:02:03 '), 3_723_000);
  assert.equal(psTimeMs('2-01:00:00'), 176_400_000);
  assert.equal(psTimeMs('100:00.00'), 6_000_000, 'macOS prints total minutes with no hours field');
  assert.equal(psTimeMs('1234:05.67'), 74_045_670);
  assert.equal(psTimeMs(''), null);
  assert.equal(psTimeMs('n/a'), null);
});

test('the wait ends when the replaced service has already exited, even while the standby keeps using CPU (Sol #593 concurrent bridge)', async () => {
  // Another bridge drained the old service: the standby takes over, removes its marker and keeps working.
  const result = await awaitStandbyProgress(standby({ cpu: busy, replacedExitAt: 4_000 }).probe, defaults);
  assert.equal(result.cause, 'old_exited');
  assert.equal(result.warm, false);
  assert.ok(result.waitedMs >= 4_000 && result.waitedMs <= 4_050, `waited ${result.waitedMs} ms`);
});

/** A fake foreign owner: a replacement appearing at `replacedAt`, a claim fresh until `claimUntil`. */
function foreign(options: { replacedAt?: number; claimUntil?: number }) {
  let t = 5_000_000; const start = t; const at = () => t - start;
  return {
    probe: {
      replacement: async () => options.replacedAt !== undefined && at() >= options.replacedAt ? 'client' : null,
      claimFresh: () => options.claimUntil === undefined || at() < options.claimUntil,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    },
    at,
  };
}
const capMs = STANDBY_READY_CAP_MS + 60_000 + 20_000;

test('papercut a6c9a2ac: a waiter keeps waiting for a fresh foreign claim past the plain readiness budget', async () => {
  const f = foreign({ replacedAt: 70_000 });
  const result = await awaitForeignReplacement(f.probe, capMs, 250);
  assert.equal(result.cause, 'replaced');
  assert.equal(result.client, 'client');
  assert.ok(f.at() >= 70_000 && f.at() < 70_300, `waited ${f.at()} ms, past the 20 s readiness budget`);
});

test('papercut a6c9a2ac: a released or stale claim with no replacement ends the wait at once', async () => {
  const released = foreign({ claimUntil: 10_000 });
  const result = await awaitForeignReplacement(released.probe, capMs, 250);
  assert.equal(result.cause, 'claim_released');
  assert.equal(result.client, null);
  assert.ok(released.at() >= 10_000 && released.at() < 10_300, `returned ${released.at()} ms in`);
  // An owner that finishes as it releases its claim is still picked up.
  const finished = foreign({ claimUntil: 10_000, replacedAt: 10_000 });
  assert.equal((await awaitForeignReplacement(finished.probe, capMs, 250)).cause, 'replaced');
});

test('papercut a6c9a2ac: the hard cap is fixed at entry and never re-armed by a claim that stays fresh', async () => {
  const f = foreign({});
  const result = await awaitForeignReplacement(f.probe, capMs, 250);
  assert.equal(result.cause, 'cap');
  assert.equal(result.client, null);
  assert.ok(f.at() >= capMs && f.at() < capMs + 300, `capped at ${f.at()} ms (cap ${capMs})`);
});
