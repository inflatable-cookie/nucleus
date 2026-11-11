import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { HostRunScheduler } from '../core/host-runs/host-run-scheduler';

test('a run admitted before the idle latch cannot launch after it', async () => {
  const store = new Store(':memory:');
  const scheduler = new HostRunScheduler(store, { capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] }) });
  let latched = false;
  scheduler.setLaunchPredicate(() => !latched);
  let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  try {
    scheduler.submit({ id: 'idle-fence', epoch: 1, caller: 'test', repository: { origin: 'https://github.com/example/project', path: '/fixture' }, selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000 }, {
      launch: async run => { await gate; scheduler.markLaunched(run.id); finished(); },
    });
    assert.equal(scheduler.get('idle-fence')?.state, 'admitted');
    latched = true;
    proceed();
    await done;
    const result = scheduler.get('idle-fence');
    assert.equal(result?.state, 'settled');
    assert.equal(result?.settlement?.outcome, 'cancelled');
    assert.equal(result?.launchedAt, null);
  } finally { scheduler.stop(); store.close(); }
});
