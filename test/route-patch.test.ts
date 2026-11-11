import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { routePatch } from '../core/verbs/route';

test('route patch keeps other live slots and advances eligible roles', () => {
  type Facts = Parameters<typeof routePatch>[0];
  const task = { phase: 'reviewing', resolution: { currentRunId: null, review: null }, coordinatorGeneration: 2,
    completion: null, agentId: null, agentIntent: null, runId: null } as unknown as Task;
  const base: Facts = { current: task, role: 'reviewer', profileId: 'p', reason: 'reason', replaceLive: false,
    live: false, currentRun: null, hasUnreleasedRun: false, waitingOnRole: false, requests: {}, includeThinking: false,
    thinking: undefined, lifted: null, continuation: 'continue', replacementRefusal: null };
  const cases: Array<[Partial<Facts>, Record<string, unknown>]> = [
    [{}, { profileRequests: {}, phase: 'awaiting_review', reason: 'Owner routed the reviewer profile; selecting the next reviewer on p',
      resolution: { currentRunId: null, review: null, reviewerAgentId: null, reviewerProfile: null, integrationTurn: null, attention: false } }],
    [{ currentRun: { role: 'revision', released: false } as Run }, { profileRequests: {} }],
    [{ current: { ...task, phase: 'merging' } }, { profileRequests: {} }],
    [{ role: 'coordinator' }, { profileRequests: {}, coordinatorAgentId: '', coordinatorGeneration: 3,
      reason: 'Owner routed the coordinator profile; the next coordinator run uses p' }],
    [{ role: 'coordinator', hasUnreleasedRun: true }, { profileRequests: {} }],
    [{ role: 'worker', current: { ...task, phase: 'working', completion: { status: 'ready_for_review' } as Task['completion'] } }, { profileRequests: {} }],
    [{ role: 'worker', current: { ...task, phase: 'working', agentId: 'a' } },
      { profileRequests: {}, replacementProfile: { profileId: 'p', reason: 'reason' },
        failoverReason: 'Operator-approved retained worker remap. reason. Continue the existing task: continue',
        phase: 'changes_requested', reason: 'Owner routed the worker profile; selecting the next worker run on p',
        resolution: { currentRunId: null, review: null, attention: false, recoveryActive: false, recoveryAttempts: 0,
          recovery: null, stalledTurnStop: null, pendingWorkerInstruction: 'continue', prePrResumeInstruction: null } }],
    [{ role: 'worker', current: { ...task, phase: 'working', agentId: 'a' }, replacementRefusal: { rule: 'signoff_pending', detail: 'pending' } }, { profileRequests: {} }],
  ];
  for (const [changes, expected] of cases) assert.deepEqual(routePatch({ ...base, ...changes }), expected);
});
