import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, head } from './support/review-continuation-fixture';

test('a previously deferred bound continuation drains during pause', async () => {
  const f = fixture();
  try {
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'running', active: true });
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    f.store.setMeta('paused', true);
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    const task = f.current();
    f.engine.deferOwnerVerb(task, { taskId: task.id, version: task.version, action: 'restart', role: 'reviewer', reason: 'Continue' }, 'paused',
      { runId: f.runId, checkpointOrdinal: 1, head });
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
    assert.equal(f.current().resolution.deferredVerb, null);
    await f.engine.wake();
    assert.equal(f.reviewerDeliveries.length, 1);
  } finally { await f.close(); }
});
