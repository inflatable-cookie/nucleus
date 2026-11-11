import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../core/engine';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function lane() {
  const engine = Object.create(Engine.prototype) as Engine;
  let paused = false;
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const retries: string[] = [];
  const state = engine as any;
  Object.assign(state, {
    stopped: false, cleanupQueue: [], cleanupDraining: null,
    projectionEnqueued: new Map(), projectionDone: new Map(), projectionInFlight: new Set(), projectionWaiters: [],
    // #912: every task is host-scoped, and cleanup runs each effect inside its host.
    withHost: (_id: string, fn: () => unknown) => fn(), taskHostAvailable: () => true,
    store: { getMeta: () => paused, task: (id: string) => ({ id, hostId: "host" }) },
    scheduleCleanupRetry: (id: string) => retries.push(id),
    lifecycle: { archive: async (task: { id: string }, retry?: string) => {
      const key = `${task.id}:${retry ?? ''}`;
      starts.push(key);
      await new Promise<void>(resolve => releases.set(key, resolve));
      if (task.id === 'b') throw Error('archive failed');
    } },
  });
  return { engine, state, starts, releases, retries, pause: (value: boolean) => { paused = value; } };
}

test('cleanup runs four different tasks concurrently and serializes same-task retries', async () => {
  const f = lane();
  for (const id of ['a', 'b', 'c', 'd', 'e']) f.engine.enqueueCleanup(id);
  f.engine.enqueueCleanup('a', 'retry');
  await tick();
  assert.deepEqual(f.starts, ['a:', 'b:', 'c:', 'd:']);
  assert.equal(f.state.projectionInFlight.size, 4);
  f.releases.get('b:')!();
  await tick();
  assert.deepEqual(f.starts, ['a:', 'b:', 'c:', 'd:', 'e:']);
  assert.ok(f.retries.includes('b'), 'failure still schedules retry');
  f.releases.get('a:')!();
  await tick();
  assert.equal(f.starts.at(-1), 'a:retry');
  for (const key of ['c:', 'd:', 'e:', 'a:retry']) f.releases.get(key)!();
  await f.engine.drainCleanup();
  assert.equal(f.state.projectionInFlight.size, 0);
  assert.equal(f.state.projectionDone.get('cleanup:a:retry'), 1);
});

test('pause prevents new starts and queued work resumes after unpause', async () => {
  const f = lane();
  for (const id of ['a', 'b', 'c', 'd', 'e']) f.engine.enqueueCleanup(id);
  await tick();
  f.pause(true);
  for (const key of ['a:', 'b:', 'c:', 'd:']) f.releases.get(key)!();
  await f.engine.drainCleanup();
  assert.equal(f.starts.length, 4);
  f.pause(false);
  const drain = f.engine.drainCleanup();
  await tick();
  assert.equal(f.starts.at(-1), 'e:');
  f.releases.get('e:')!();
  await drain;
});

test('eight delayed cleanup fixtures finish in two waves instead of eight', async () => {
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 40));
  let started = performance.now();
  for (let i = 0; i < 8; i++) await delay();
  const serial = performance.now() - started;
  const f = lane();
  f.state.lifecycle.archive = async () => delay();
  started = performance.now();
  for (let i = 0; i < 8; i++) f.engine.enqueueCleanup(String(i));
  await f.engine.drainCleanup();
  const concurrent = performance.now() - started;
  console.log(`eight 40ms cleanup fixtures: serial ${serial.toFixed(0)}ms; concurrent ${concurrent.toFixed(0)}ms`);
  assert.ok(concurrent < serial * 0.75);
});
