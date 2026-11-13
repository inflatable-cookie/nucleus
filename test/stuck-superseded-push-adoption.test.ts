import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, base, head } from './support/responsible-lifecycle-fixture';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { taskControlInputSchema, type Run } from '../shared/contracts';

/**
 * Papercut b7a6fb99: barge#061's revision run 42e81e8d pushed a clean head
 * (b69cf66) and was superseded before reporting. Nucleus's `prHead` stayed
 * stale, `restart role=worker` looped on "Retained progress cannot be bound
 * without its authenticated released author report and source proof", and
 * `next` did not point at `move to=review`, the exit that worked.
 *
 * When the forge and the clean task checkout both report the pushed head and no
 * work is unresolved, that head is observation: the stale record is refreshed
 * and `next` offers `move to=review` at it.
 */
test('b7a6fb99: a superseded run\'s clean pushed head is adopted and next offers move to=review', async () => {
  const f = fixture();
  try {
    const pushed = 'c'.repeat(40);
    f.setHead(pushed);
    const revisionId = 'revision-42e81e8d';
    f.store.putRun({
      id: revisionId, taskId: f.submitted.id, role: 'revision', generation: 1, head: base, base,
      agentId: 'worker', workspaceId: 'workspace', profile: f.author, status: 'finished',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(), lastObservedAt: new Date().toISOString(),
      active: false, idleSince: new Date().toISOString(), completion: null, released: true,
    } as unknown as Run);
    const current = f.current();
    // The recorded shape: the superseded run's newest result is a ready report on
    // the revision run, the initial worker run has no row, and prHead is stale.
    f.store.update(f.submitted.id, {
      phase: 'changes_requested',
      reason: 'Retained progress cannot be bound without its authenticated released author report and source proof',
      completion: { ...current.completion!, runId: revisionId, head, prNumber: 1, status: 'ready_for_review' },
      resumePrNumber: 1,
      resolution: { ...current.resolution, currentRunId: null },
    }, 'test_superseded_push', 'a superseded revision pushed a clean head before it was released');
    f.idle('worker');
    const before = f.current();
    await f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.submitted.id, version: before.version, action: 'restart', role: 'worker',
      reason: 'Continue the work the superseded run pushed',
    }));
    await f.engine.wake();
    const adopted = f.current();
    assert.equal(adopted.prHead, pushed, 'the forge and the clean checkout agree on the pushed head');
    assert.ok(f.events('pushed_head_adopted').some(event => event.detail.includes(head) && event.detail.includes(pushed)),
      'the adoption is recorded as observation');
    const next = ownerTaskNext(collectOwnerVerbFacts(f.store, adopted));
    const review = next.verbs.find(view => view.verb === 'move' && view.available && view.args?.to === 'review');
    assert.ok(review, 'next offers move to=review at the adopted head');
    assert.equal(next.prHead, pushed);
  } finally { await f.close(); }
});
