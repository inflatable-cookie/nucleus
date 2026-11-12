import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundQuantum, TASK_QUANTUM_BOUND_MS } from '../core/scheduling/quantum-bound';
import { isTransportFailure } from '../shared/transport';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';

// A quantum that never returns (a lane held by one stuck task) must not hold the
// sweep window: the window settles at the bound and names the outage once.
test('a hung task quantum settles at its bound and reports one outage', async () => {
  const hung = new Promise<void>(() => {});
  let outages = 0;
  const started = Date.now();
  await boundQuantum(hung, () => { outages++; }, 25);
  assert.equal(outages, 1);
  assert.ok(Date.now() - started < 1000, 'the window must not wait for the hung quantum');
});

test('a window with one hung quantum still completes the others', async () => {
  const hung = new Promise<void>(() => {});
  const fast = Promise.resolve();
  const reported: string[] = [];
  const window = [
    boundQuantum(hung, () => reported.push('hung'), 25),
    boundQuantum(fast, () => reported.push('fast'), 25),
  ];
  await Promise.all(window);
  assert.deepEqual(reported, ['hung']);
});

test('a quantum that returns in time reports nothing, and its own failure never reaches the sweep', async () => {
  let outages = 0;
  await boundQuantum(Promise.resolve(), () => { outages++; }, 25);
  await boundQuantum(Promise.reject(new Error('quantum fault')), () => { outages++; }, 25);
  assert.equal(outages, 0);
});

test('the production bound is two minutes', () => {
  assert.equal(TASK_QUANTUM_BOUND_MS, 120_000);
});

test('T3 transport and timeout errors classify as transport failures, never attention', () => {
  assert.equal(isTransportFailure(new Error('T3Code transport: orchestration.subscribeThread')), true);
  assert.equal(isTransportFailure(new Error('T3Code timeout: orchestration.subscribeShell')), true);
  assert.equal(isTransportFailure(new Error('T3CompatibilityError: authenticated host connection is unavailable')), true);
  assert.equal(isTransportFailure(new Error('T3Code protocol: orchestration.subscribeThread')), false);
});

// The #1148 wedge through the real engine lanes: a task whose lane is held by a
// call that never returns keeps its quantum queued forever. A window that waits
// on that quantum unbounded never reaches the next task.
function laneFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-quantum-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const engine = new Engine(store, {} as Adapter, 0);
  return { engine, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a task whose lane never returns does not hold the window: the next task still runs and the stuck one is an outage', async () => {
  const f = laneFixture();
  try {
    let releaseStuck!: () => void;
    void f.engine.scheduleLane('task:stuck', 1, () => new Promise<void>(r => { releaseStuck = r; }));
    const quantum = f.engine.scheduleTaskQuantum('stuck');
    let fastRan = false;
    const outages: string[] = [];
    // The window's shape: one bounded wait per quantum, all awaited together.
    await Promise.all([
      boundQuantum(quantum, () => outages.push('stuck'), 25),
      boundQuantum(f.engine.scheduleLane('task:fast', 1, () => { fastRan = true; }), () => outages.push('fast'), 25),
    ]);
    assert.equal(fastRan, true, 'the fast task must run while the stuck lane is held');
    assert.deepEqual(outages, ['stuck'], 'only the stuck task is an outage');
    releaseStuck();
  } finally { await f.close(); }
});
