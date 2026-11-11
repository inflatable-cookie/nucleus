import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resolution } from '../core/resolution';
import type { Store } from '../core/store/store';
import type { Adapter } from '../core/host/adapter';
import type { Task } from '../shared/contracts';

test('recovery replay reads the current merge owner and returns its exact promise', async () => {
  // This boundary never reads storage or calls the adapter.
  const resolution = new Resolution({} as Store, {} as Adapter, () => [], () => false);
  const task = {} as Task;
  const replay = resolution.recoveryLifecycle.replayHeldAttention.bind(resolution.recoveryLifecycle);
  let calls = 0;
  let finish!: (task: Task) => void;
  const pending = new Promise<Task>(resolve => { finish = resolve; });
  resolution.mergePhase.replayHeldAttention = function (current) {
    assert.equal(this, resolution.mergePhase);
    assert.equal(current, task);
    calls++;
    return pending;
  };
  assert.equal(replay(task), pending, 'the handoff must add no promise or microtask turn');
  assert.equal(calls, 1, 'the current owner is called synchronously');
  finish(task);
  assert.equal(await pending, task);

  const failure = new Error('replay failed');
  const rejected = Promise.reject(failure);
  resolution.mergePhase.replayHeldAttention = () => rejected;
  assert.equal(replay(task), rejected, 'a retained entry reads a replaced owner at the call boundary');
  await assert.rejects(rejected, error => error === failure);
});
