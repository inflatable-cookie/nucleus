import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/responsible-lifecycle-fixture';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * Papercut 6895edaa: nucleus#1164's worker waited on its one timed run of 541
 * test files under a Monitor and ended its turn. Nucleus read that as a stopped
 * run: it sent the callback reminder, recorded `missing_callback` and spent
 * three coordinators while the worker was doing exactly the right thing.
 *
 * The thread's own provider timeline still shows the job running, so the thread
 * is waiting on its own work, not stopped without a callback.
 */
test('6895edaa: a worker waiting on its own running job is waiting, not a missing callback', async () => {
  const f = fixture();
  try {
    // The recorded shape: the worker ended its turn while its one timed run is
    // still going in the background under the provider's Monitor tool.
    f.store.update(f.submitted.id, {
      phase: 'working', completion: null, reason: 'Worker running',
    }, 'test_worker_ended_turn', 'worker ended its turn to wait on its own job');
    f.idle('worker');
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    f.adapter.agentTimelinePage = async () => toolTimelinePage([{
      timestamp: startedAt,
      item: { type: 'tool_call', callId: 'timed-run-1', name: 'Monitor', status: 'running',
        detail: { type: 'shell', command: 'effigy test unit -- 541 files' } },
    }]);
    // First pass stamps the idle grace; the next one would remind and escalate.
    await f.engine.wake();
    await f.engine.wake();
    const task = f.current();
    assert.equal(task.resolution.incident, null, 'the waiting thread is not a missing-callback incident');
    assert.equal(f.events('missing_callback').length, 0);
    assert.equal(f.events('callback_reminder').length, 0);
    assert.equal(f.coordinatorRuns().length, 0, 'no coordinator is launched while the job is visibly running');
    assert.match(task.reason, /waiting on its own running job/i);
    assert.match(task.reason, /Monitor/);
  } finally { await f.close(); }
});
