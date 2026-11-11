import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerRevisionFixture, ownedRevisableTask } from './support/review-entry-fixture';

test('review admission records a recoverable wait for an unavailable origin host', async () => {
  const f = ownerRevisionFixture();
  try {
    const { task, engine, store } = await ownedRevisableTask(f);
    engine.hostAvailable = () => false;
    await engine.dispatchOwner.performReviewEntryAdmission(store.task(task.id));
    const waiting = store.task(task.id);
    assert.match(waiting.reason, /Waiting for origin host host/);
    assert.equal(waiting.resolution.stop?.reason, 'lifecycle');
    assert.notEqual(waiting.phase, 'needs_attention');
    assert.equal(f.creates.length, 0);
    await engine.stop();
  } finally { f.close(); }
});
