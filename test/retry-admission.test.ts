import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { retryAdmission, retrySpecialRoute } from '../core/recovery/retry-routes';
import { RETAINED_WORKER_PROFILE_REASON } from '../shared/contracts';

test('retry admissions preserve instruction and special-route precedence', () => {
  const task = { phase: 'needs_attention', reason: '', resolution: {}, agentId: 'a', workspaceId: 'w', prHead: 'h' } as unknown as Task;
  const base = { stage: 'instruction' as const, revise: false, operator: false, remap: false };
  const cases: Array<[Partial<Parameters<typeof retryAdmission>[1]>, string | null]> = [
    [{ instruction: 'go' }, 'An instruction on a parked restart applies only to a retained-worker remap; use move to=work with the instruction otherwise'],
    [{ instruction: 'go', operator: true, remap: true }, null],
    [{ reviewerInstruction: 'review' }, 'A reviewer instruction is only valid for an owner restart role=reviewer'],
    [{ stage: 'reviewer-delivery', operator: true, reviewerInstruction: 'review' }, 'A reviewer instruction requires a retry that returns the task to a fresh review; this retry has no fresh reviewer to receive it'],
  ];
  for (const [changes, expected] of cases) assert.equal(retryAdmission(task, { ...base, ...changes }), expected);
  const revision = { role: 'revision', released: true, agentId: 'a', workspaceId: 'w', completion: { status: 'ready_for_review' } } as Run;
  const routes: Array<[Task, Parameters<typeof retrySpecialRoute>[1], boolean, Run | null, ReturnType<typeof retrySpecialRoute>]> = [
    [{ ...task, resolution: { ...task.resolution, mergeIntent: {} as Task['resolution']['mergeIntent'] } }, 'merge', false, null, { refuse: 'An uncertain merge requires an operator decision before reconciliation resumes' }],
    [{ ...task, resolution: { ...task.resolution, mergeIntent: {} as Task['resolution']['mergeIntent'] } }, 'merge', true, null, 'merge'],
    [{ ...task, reason: 'PR head changed after the completion callback' }, 'revision', true, revision, 'revision'],
    [{ ...task, reason: RETAINED_WORKER_PROFILE_REASON }, 'profile', false, null, { refuse: 'Retained worker profile eligibility requires explicit operator retry' }],
    [{ ...task, reason: RETAINED_WORKER_PROFILE_REASON }, 'profile', true, null, 'profile'],
    [task, 'hook', true, null, 'pass'],
  ];
  for (const [t, stage, operator, run, expected] of routes) assert.deepEqual(retrySpecialRoute(t, stage, operator, false, run), expected);
});
