import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { blockedRetryRoute, retryRoute } from '../core/recovery/retry-routes';

test('blocked retry routes the completed role and reviewer instruction', () => {
  const task = { runId: 'worker', completion: null, resolution: {}, proofExecutions: [], prHead: 'head' } as unknown as Task;
  const run = (role: Run['role']) => ({ id: 'r', role, completion: { status: 'blocked' } } as Run);
  const cases: Array<[Run[], string | undefined, boolean, string | null, ReturnType<typeof blockedRetryRoute>]> = [
    [[], undefined, false, null, { kind: 'refuse', message: 'No resolution run to resume' }],
    [[run('reviewer')], undefined, false, null, { kind: 'route', phase: 'awaiting_review', reconciledReviewHead: null }],
    [[run('closeout')], undefined, false, null, { kind: 'route', phase: 'syncing', reconciledReviewHead: null }],
    [[run('revision')], undefined, false, null, { kind: 'route', phase: 'changes_requested', reconciledReviewHead: null }],
    [[run('revision')], 'review', true, null, { kind: 'route', phase: 'awaiting_review', reconciledReviewHead: null }],
    [[run('revision')], 'review', false, 'new-head', { kind: 'route', phase: 'awaiting_review', reconciledReviewHead: 'new-head' }],
    [[run('revision')], 'review', false, null, { kind: 'refuse', message: 'A reviewer instruction requires a blocked or errored reviewer result that returns the task to review' }],
  ];
  for (const [runs, instruction, accepted, head, expected] of cases) assert.deepEqual(blockedRetryRoute(task, runs, instruction, accepted, head), expected);
});


test('retry route selects parked work before generic attention recovery', () => {
  const base = { phase: 'needs_attention', resolution: { attention: true }, workspaceId: 'w', agentId: 'a', runId: 'r', profile: {}, completion: null } as unknown as Task;
  const cases: Array<[Task, boolean, ReturnType<typeof retryRoute>]> = [
    [base, true, 'revision'], [base, false, 'worker'],
    [{ ...base, directory: 'd', completion: { status: 'ready_for_review' } as Task['completion'] }, false, 'accepted-pr'],
    [{ ...base, phase: 'blocked' }, false, 'blocked'],
    [{ ...base, phase: 'verifying' }, false, 'retry'],
    [{ ...base, phase: 'verifying', resolution: { ...base.resolution, attention: false } }, false, 'no-action'],
  ];
  for (const [task, revise, expected] of cases) assert.equal(retryRoute(task, [], revise), expected);
});
