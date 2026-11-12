import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incidentKey } from '../core/recovery/incident';
import type { Task } from '../shared/contracts';

const task = (prHead: string) => ({
  id: 'task-pending-check', phase: 'verifying', prHead, completion: null,
  resolution: { currentRunId: null },
} as unknown as Task);

test('pending-check incident identity survives check-status wording changes at the same head', () => {
  const head = 'a'.repeat(40);
  const queued = incidentKey(task(head), null,
    "Required check 'build' (queued, no runner yet) has been pending past its deadline (16m elapsed, bound 15m); job URL: https://github.com/example/repo/actions/runs/9/job/1");
  const running = incidentKey(task(head), null,
    "Required check 'build' (in_progress for 22m) has been pending past its deadline (22m elapsed, bound 15m); job URL: https://github.com/example/repo/actions/runs/9/job/1");
  const generic = incidentKey(task(head), null, 'PR checks are pending');

  assert.equal(queued.cause, running.cause, 'elapsed time and queued/running labels do not create a new check incident');
  assert.equal(queued.cause, generic.cause, 'generic and detailed pending wording share the same head-bound incident');
  assert.notEqual(queued.id, incidentKey(task('b'.repeat(40)), null, 'PR checks are pending').id,
    'a different reviewed head has a different pending-check incident');
});
