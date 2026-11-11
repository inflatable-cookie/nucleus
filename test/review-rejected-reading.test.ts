import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { reviewAllowanceText } from '../shared/contracts';
import { fixture } from './support/review-continuation-fixture';

// Task 536: the final checkpoint allowance says how many were used, and a
// reading refused past that allowance is kept as evidence, never as a checkpoint.
test('the checkpoint allowance reads used of allowed', () => {
  assert.equal(reviewAllowanceText(2, 6), '2 of 6 checkpoints used');
  assert.equal(reviewAllowanceText(6, 6), '6 of 6: this turn must end with a verdict');
});

test('the final-allowance continuation names the count, and a refused over-budget reading is kept as evidence', async () => {
  const f = fixture(); try {
    f.store.setMeta('reviewContinuationLimit', 1);
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    await f.engine.performTaskControl({ taskId: f.submitted.id, version: f.current().version, action: 'restart', role: 'reviewer', reason: 'Continue the checkpointed review' } as never);
    assert.equal(f.reviewerDeliveries.length, 1, 'the first checkpoint was continued once');
    const continuation = f.reviewerDeliveries[0]!.text;
    assert.match(continuation, /Checkpoint allowance: 1 of 1: this turn must end with a verdict/);
    assert.match(continuation, /a further review_in_progress checkpoint is refused/);
    assert.doesNotMatch(continuation, /A new review_in_progress checkpoint ends this turn/);

    // The continued reviewer reads on and reports past the allowance.
    f.states.set('review-agent', { ...f.states.get('review-agent')!, status: 'idle', active: false });
    await f.report({ covered: ['Diff', 'Tests'], remaining: ['Docs'], notes: 'Docs are next' }, 'ckpt-2');
    for (let pass = 0; pass < 3; pass++) await f.engine.wake();

    assert.equal(f.run().reviewCheckpoints?.length, 1, 'the refused reading is not an accepted checkpoint');
    assert.equal(f.reviewerDeliveries.length, 1, 'and it sends nothing');
    const readings = f.run().reviewRejectedReadings ?? [];
    assert.equal(readings.length, 1, 'the refused reading is kept on the run');
    assert.equal(readings[0]!.eventId, 'ckpt-2');
    assert.equal(readings[0]!.head, f.run().head);
    assert.deepEqual(readings[0]!.checkpoint, { covered: ['Diff', 'Tests'], remaining: ['Docs'], notes: 'Docs are next' });

    // The owner's restart view says what was kept and where.
    const restart = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(entry => entry.verb === 'restart');
    assert.match(restart?.note ?? '', /\(2 covered, 1 remaining items, at [^)]+\) is kept on run [^ ]+ as evidence, not as a checkpoint/);
  } finally { await f.close(); }
});

test('next shows the checkpoint allowance used of allowed while the reviewer can still continue', async () => {
  const f = fixture(); try {
    await f.report({ covered: ['Diff'], remaining: ['Tests'] }, 'ckpt-1');
    const restart = ownerTaskNext(collectOwnerVerbFacts(f.store, f.current())).verbs.find(entry => entry.verb === 'restart');
    assert.match(restart?.note ?? '', /Checkpoint allowance: 1 of 6 checkpoints used\./);
  } finally { await f.close(); }
});
