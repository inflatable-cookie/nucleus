import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyReviewAtHead, appliedMergeVerdict } from '../core/recovery/task-reasons';
import type { Task } from '../shared/contracts';

test('only a ready review at a named exact head approves the PR', () => {
  for (const status of ['ready_to_merge', 'changes_required', 'review_in_progress']) {
    for (const prHead of [null, 'a', 'b']) for (const head of [null, 'a', 'b']) {
      const task = { prHead, resolution: { review: { status, head } } } as Task;
      assert.equal(readyReviewAtHead(task), status === 'ready_to_merge' && Boolean(prHead) && head === prHead);
    }
  }
  const accepted = { prHead: 'a', resolution: { ownerAcceptances: [{ head: 'a', kind: 'operator_source' }] } } as Task;
  assert.equal(readyReviewAtHead(accepted), false);
  assert.equal(appliedMergeVerdict(accepted, 'a'), true);
  assert.equal(appliedMergeVerdict(accepted, 'b'), false);
});
