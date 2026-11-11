import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acceptControl, fixture, nativeReviewer } from './support/review-continuation-fixture';
import { checkoutPlacement, placeTask, placementControl } from './support/reviewer-placement';

test('a checkout root that changes during the awaited exact-head proof refuses before send', async () => {
  for (const change of ['head advanced', 'branch switched', 'checkout removed'] as const) {
    const placement = checkoutPlacement(), f = fixture();
    try {
      placeTask(f, placement);
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: placement.checkout });
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `placement-race-${change}`, placement.head);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      f.setVerifyBarrier(async () => { enter(); await blocked; });
      const pending = acceptControl(f, placementControl(f, 'restart'));
      await entered;
      if (change === 'head advanced') {
        writeFileSync(join(placement.checkout, 'raced.txt'), 'raced\n');
        placement.git(placement.checkout, 'add', '.');
        placement.git(placement.checkout, ...placement.identity, 'commit', '-m', 'raced during the exact-head proof');
      }
      if (change === 'branch switched') placement.git(placement.checkout, 'checkout', '-b', 'raced-branch');
      if (change === 'checkout removed') rmSync(placement.checkout, { recursive: true, force: true });
      release();
      const outcome = await pending;
      assert.notEqual(outcome.state, 'succeeded', change);
      assert.match(outcome.diagnostic, /no delivery was sent/, change);
      assert.equal(f.reviewerDeliveries.length, 0, change);
      assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'refused', change);
      assert.equal(f.current().resolution.currentRunId, f.runId, change);
    } finally { await f.close(); placement.close(); }
  }
});

/**
 * The placement proof is the last awaited proof, so a checkout that changes
 * during the reviewer identity refresh that follows the exact-head fence is
 * still refused: the final delivery boundary never sends on placement evidence
 * gathered before an await.
 */
test('a checkout root that changes during the final reviewer identity refresh refuses before send', async () => {
  for (const change of ['head advanced', 'branch switched', 'checkout removed'] as const) {
    const placement = checkoutPlacement(), f = fixture();
    try {
      placeTask(f, placement);
      nativeReviewer(f, { checkout: placement.checkout, projectRootPath: placement.checkout, onRefresh: count => {
        // Refresh 1 is the delivery preflight; refresh 2 follows the awaited
        // exact-head fence and precedes the final placement proof.
        if (count !== 2) return;
        if (change === 'head advanced') {
          writeFileSync(join(placement.checkout, 'raced.txt'), 'raced\n');
          placement.git(placement.checkout, 'add', '.');
          placement.git(placement.checkout, ...placement.identity, 'commit', '-m', 'raced during the identity refresh');
        }
        if (change === 'branch switched') placement.git(placement.checkout, 'checkout', '-b', 'raced-branch');
        if (change === 'checkout removed') rmSync(placement.checkout, { recursive: true, force: true });
      } });
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `placement-refresh-race-${change}`, placement.head);
      const outcome = await acceptControl(f, placementControl(f, 'restart'));
      assert.notEqual(outcome.state, 'succeeded', change);
      assert.match(outcome.diagnostic, /no delivery was sent/, change);
      assert.equal(f.reviewerDeliveries.length, 0, change);
      assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'refused', change);
      assert.equal(f.current().resolution.currentRunId, f.runId, change);
    } finally { await f.close(); placement.close(); }
  }
});

/**
 * The placement proof samples the workspace descriptor before its awaited Git
 * reads, so it re-reads the descriptor afterwards and re-asserts the Git
 * evidence synchronously. This case arms the change inside the awaited
 * exact-head fence, so the descriptor moves while the FINAL proof's Git reads are
 * running: removing only the final re-read makes this case send, and the refusal
 * is asserted to name the final phase so it cannot pass on a preflight refusal.
 */
test('a workspace descriptor that changes during the final placement proof refuses before send', async () => {
  for (const change of ['root moved', 'directory changed', 'record archived'] as const) {
    const placement = checkoutPlacement(), f = fixture();
    try {
      placeTask(f, placement);
      // The change is armed inside the awaited exact-head fence, which runs after
      // the delivery preflight's placement proof and before the final one, so the
      // next descriptor read is the final proof's own first read and the mutation
      // lands while that proof's awaited Git reads are running.
      let armed = false;
      const options: { checkout?: string; recordDirectory?: string; projectRootPath?: string | null; onDescriptor?: () => void } = {
        checkout: placement.checkout, projectRootPath: placement.checkout,
        onDescriptor: () => {
          if (!armed) return;
          armed = false;
          queueMicrotask(() => {
            if (change === 'root moved') options.projectRootPath = join(placement.root, 'elsewhere');
            if (change === 'directory changed') options.recordDirectory = join(placement.root, 'moved');
            if (change === 'record archived') options.projectRootPath = null;
          });
        },
      };
      nativeReviewer(f, options);
      f.setVerifyBarrier(async () => { armed = true; });
      await f.report({ covered: ['Diff'], remaining: ['Proofs'] }, `placement-descriptor-${change.replaceAll(' ', '-')}`, placement.head);
      const outcome = await acceptControl(f, placementControl(f, 'restart'));
      assert.notEqual(outcome.state, 'succeeded', change);
      // The refusal must come from the final boundary, not from the delivery
      // preflight: the preflight proof passed and only the final proof re-read
      // the descriptor after its awaited Git reads.
      assert.match(outcome.diagnostic, /during exact-head verification/, change);
      assert.match(outcome.diagnostic, /no delivery was sent/, change);
      assert.equal(f.reviewerDeliveries.length, 0, change);
      assert.equal(f.run().reviewDeliveries?.at(-1)?.status, 'refused', change);
      assert.equal(f.current().resolution.currentRunId, f.runId, change);
    } finally { await f.close(); placement.close(); }
  }
});
