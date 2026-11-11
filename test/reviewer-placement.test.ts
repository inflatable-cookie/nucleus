import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptControl, fixture, nativeReviewer, type ReviewContinuationFixture } from './support/review-continuation-fixture';
import { checkoutPlacement, placeTask, placementControl, type CheckoutPlacement } from './support/reviewer-placement';

/**
 * Retained reader placement (task 496).
 *
 * Paseo registers a Queue-created checkout under the project rooted at the
 * canonical repository when it finds one, but the same retained task checkout
 * may legitimately be registered under a project rooted at that checkout. Both
 * placements are the same authenticated reader: the same run, agent, workspace,
 * head, checkpoint and callback binding. A root equal to a checkout is never
 * authority by itself, so the recorded binding and the checkout's own canonical
 * Git source are proved before and after the awaited exact-head proof. These
 * scenarios use real Git, the ordinary callback and owner-verb lifecycle and the
 * real adapter continuation.
 */

/** The one continuation a legitimate placement delivers. */
function assertSameReaderContinued(f: ReviewContinuationFixture, placement: CheckoutPlacement) {
  assert.equal(f.reviewerDeliveries.length, 1);
  const delivery = f.reviewerDeliveries[0];
  assert.equal(delivery.runId, f.runId);
  assert.match(delivery.messageId, /^ns-review-[a-f0-9]{64}$/);
  assert.equal(f.run().agentId, 'review-agent');
  assert.equal(f.run().workspaceId, 'workspace');
  assert.equal(f.current().workspaceId, f.run().workspaceId, 'no workspace was allocated or replaced');
  assert.equal(f.current().prHead, placement.head);
  assert.equal(f.run().head, placement.head);
  assert.equal(f.run().reviewCheckpoints?.length, 1, 'the checkpoint is neither renumbered nor replaced');
  assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'delivered');
  assert.equal(f.run().completion, null, 'a continuation is not a verdict');
  assert.equal(f.current().resolution.currentRunId, f.runId, 'the same reader stays current');
}

test('a checkpointed reviewer continues to the same reader under both legitimate project placements', async () => {
  const scenarios = [['canonical project root', 'restart'], ['checkout-root project', 'restart'], ['checkout-root project', 'move']] as const;
  for (const [placementKind, action] of scenarios) {
    const placement = checkoutPlacement(), f = fixture();
    try {
      placeTask(f, placement);
      nativeReviewer(f, { checkout: placement.checkout,
        projectRootPath: placementKind === 'canonical project root' ? placement.repo : placement.checkout });
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `placement-${action}`, placement.head);
      assert.equal(f.run().reviewCheckpoints?.length, 1);
      const outcome = await acceptControl(f, placementControl(f, action));
      assert.equal(outcome.state, 'succeeded', `${placementKind} ${action}: ${outcome.diagnostic}`);
      assertSameReaderContinued(f, placement);
    } finally { await f.close(); placement.close(); }
  }
});
