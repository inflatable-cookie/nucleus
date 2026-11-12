import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundQuantum, TASK_QUANTUM_BOUND_MS } from '../core/scheduling/quantum-bound';
import { isTransportFailure } from '../shared/transport';

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
