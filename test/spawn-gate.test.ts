import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPAWN_CONCURRENCY, spawnGate, withSpawnSlot } from '../core/dispatch/spawn-gate';

/**
 * Spec 012: with no global lane cap, the processes Git and hooks spawn are
 * bounded where they are spawned. Excess work waits at this gate, not for a
 * lane slot.
 */
test('concurrently spawned processes share one fixed internal bound', async () => {
  let running = 0, peak = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = () => withSpawnSlot(async () => {
    running++; peak = Math.max(peak, running);
    await gate;
    running--;
  });
  const started = Array.from({ length: SPAWN_CONCURRENCY + 4 }, work);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(peak, SPAWN_CONCURRENCY, 'no more than the fixed limit spawn at once');
  assert.equal(spawnGate.queued, 4, 'excess work waits at the gate');
  release();
  await Promise.all(started);
  assert.equal(running, 0);
  assert.equal(spawnGate.queued, 0);
});

test('a nested spawn inside a held slot runs inline instead of deadlocking', async () => {
  let nested = 0;
  const outer = Array.from({ length: SPAWN_CONCURRENCY }, () => withSpawnSlot(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    await withSpawnSlot(async () => { nested++; });
  }));
  await Promise.all(outer);
  assert.equal(nested, SPAWN_CONCURRENCY, 'every nested spawn ran rather than waiting for a slot it already held');
});

test('a rejected spawn releases its slot', async () => {
  await assert.rejects(withSpawnSlot(async () => { throw new Error('spawn failed'); }), /spawn failed/);
  assert.equal(spawnGate.inFlight, 0, 'a failed spawn frees the slot');
});
