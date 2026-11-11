import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOwnerVerbFacts, ownerPendingEffects } from '../core/verbs/owner-verbs';
import { reviewContinuationLocalRefusal } from '../core/resolution';
import { runSchema } from '../shared/contracts';
import { fixture } from './support/review-continuation-fixture';

// Simplify map D25: nothing writes `run.reviewContinuation` and nothing settles
// one. An old record still parses, offers no effect, and fails closed on delivery.
test('a stored legacy continuation parses, offers no effect and refuses a new reviewer delivery', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    const run = f.run();
    const input = { runId: run.id, head: run.head, checkpointOrdinal: 1 };
    assert.equal('refusal' in reviewContinuationLocalRefusal(f.store, f.current(), run, input, { paused: false }), false, 'the checkpoint can be continued without the record');

    const legacy = runSchema.parse({ ...run, reviewContinuation: { id: 'legacy', ordinal: 1, head: run.head, eventId: 'ckpt-1', runId: run.id, remaining: ['Tests'], path: '/checkpoint',
      status: 'uncertain', createdAt: new Date().toISOString(), deliveredAt: null, attempts: 1, error: 'reply was lost' } });
    f.store.putRun(legacy);
    assert.equal(f.run().reviewContinuation?.id, 'legacy');
    assert.deepEqual(ownerPendingEffects(collectOwnerVerbFacts(f.store, f.current())).filter(item => item.effect.includes('legacy')), []);
    const refused = reviewContinuationLocalRefusal(f.store, f.current(), f.run(), input, { paused: false });
    assert.match('refusal' in refused ? refused.refusal : '', /legacy continuation intent is retained/);
  } finally { await f.close(); }
});
