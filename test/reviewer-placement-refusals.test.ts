import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptControl, fixture, nativeReviewer, type ReviewContinuationFixture } from './support/review-continuation-fixture';
import { checkoutPlacement, placeTask, placementControl, type CheckoutPlacement } from './support/reviewer-placement';

/**
 * Placement refusals for a retained reviewer continuation (task 496).
 *
 * A project root equal to a checkout is not authority by itself. Every scenario
 * here keeps the ordinary lifecycle — an authenticated checkpoint, the owner
 * restart and the real adapter continuation — and proves the checkout-root
 * placement refuses before send when the recorded task, run, workspace,
 * directory, canonical Git source, branch or head do not independently agree.
 */

test('a checkout root that is not this retained task source refuses before send', async () => {
  const foreignPlacements: CheckoutPlacement[] = [];
  const cases: Array<{ name: string; reason: RegExp; setup: (f: ReviewContinuationFixture, placement: CheckoutPlacement) => void }> = [
    { name: 'unrelated project root', reason: /changed project placement/, setup: (f, placement) =>
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: join(placement.root, 'elsewhere') }) },
    { name: 'a checkout of a different repository', reason: /not a worktree of the task repository/, setup: (f, placement) => {
      // The task names this repository; its recorded checkout belongs to another one.
      const foreign = checkoutPlacement();
      foreignPlacements.push(foreign);
      f.store.update(f.submitted.id, { directory: foreign.checkout });
      nativeReviewer(f, { checkout: foreign.checkout, projectRootPath: foreign.checkout });
    } },
    { name: 'moved workspace directory', reason: /missing or changed/, setup: (f, placement) =>
      nativeReviewer(f, { checkout: placement.checkout, recordDirectory: join(placement.root, 'moved'),
        projectRootPath: placement.checkout }) },
    { name: 'archived workspace record', reason: /missing or changed/, setup: (f, placement) =>
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: null }) },
    { name: 'removed checkout directory', reason: /missing or changed/, setup: (f, placement) => {
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: placement.checkout });
      rmSync(placement.checkout, { recursive: true, force: true });
    } },
    { name: 'checkout on another branch', reason: /not the reviewed branch and head/, setup: (f, placement) => {
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: placement.checkout });
      placement.git(placement.checkout, 'checkout', '-b', 'another-branch');
    } },
    { name: 'checkout at a later head', reason: /not the reviewed branch and head/, setup: (f, placement) => {
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: placement.checkout });
      writeFileSync(join(placement.checkout, 'later.txt'), 'later\n');
      placement.git(placement.checkout, 'add', '.');
      placement.git(placement.checkout, ...placement.identity, 'commit', '-m', 'a later unpublished change');
    } },
  ];
  for (const c of cases) {
    const placement = checkoutPlacement(), f = fixture();
    try {
      placeTask(f, placement);
      c.setup(f, placement);
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `placement-refusal-${c.name.replaceAll(" ", "-")}`, placement.head);
      const outcome = await acceptControl(f, placementControl(f, 'restart'));
      assert.notEqual(outcome.state, 'succeeded', c.name);
      assert.match(outcome.diagnostic, c.reason, c.name);
      assert.match(outcome.diagnostic, /no delivery was sent/, c.name);
      assert.equal(f.reviewerDeliveries.length, 0, c.name);
      assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'refused', c.name);
      assert.equal(f.run().reviewCheckpoints?.length, 1, c.name);
      assert.equal(f.run().completion, null, c.name);
      assert.equal(f.current().resolution.currentRunId, f.runId, c.name);
      assert.equal(f.states.get('review-agent')!.workspaceId, 'workspace', 'no reader was replaced');
    } finally { await f.close(); placement.close(); foreignPlacements.splice(0).forEach(foreign => foreign.close()); }
  }
});
