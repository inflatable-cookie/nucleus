import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_ACTION_ESCALATION_SUMMARY, NO_RESOLUTION_ACTION, OPERATOR_ROLE_REASSIGNMENT_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON,
  OPERATOR_WORKER_REMAP_REASON, creationFailureDetail, creationFailureSummary, escalationSummary,
  operatorReplacementPending, ownerArmedRetainedWorker, retainedProfileRemapPark, visibleTaskReason,
} from '../core/recovery/task-reasons';
import { RETAINED_WORKER_PROFILE_REASON, type Run, type Task } from '../shared/contracts';

test('one operator replacement list answers both the pending and the armed-worker question', () => {
  for (const reason of [OPERATOR_WORKER_REMAP_REASON, OPERATOR_STOPPED_REVISION_REMAP_REASON, OPERATOR_ROLE_REASSIGNMENT_REASON])
    assert.equal(operatorReplacementPending({ failoverReason: reason } as Task), true, reason);
  assert.equal(operatorReplacementPending({ failoverReason: 'Provider usage exhausted' } as Task), false);
  assert.equal(operatorReplacementPending({ failoverReason: '' } as Task), false);
  // The armed-window answer comes from the same list: an unknown failover reason never arms it.
  const armed = { phase: 'changes_requested', agentId: 'worker', runId: 'run', failoverReason: OPERATOR_WORKER_REMAP_REASON,
    replacementProfile: { id: 'profile' }, resolution: { currentRunId: null } } as unknown as Task;
  assert.equal(ownerArmedRetainedWorker(armed, []), true);
  assert.equal(ownerArmedRetainedWorker({ ...armed, failoverReason: 'Provider usage exhausted' } as Task, []), false);
  assert.equal(ownerArmedRetainedWorker(armed, [{ role: 'revision', agentId: 'worker', released: false } as unknown as Run]), false);
  assert.equal(ownerArmedRetainedWorker({ ...armed, resolution: { currentRunId: 'other' } } as unknown as Task, []), false);
});

test('a retained-profile park is the recorded reason, or an escalation after the park and before any resume', () => {
  assert.equal(retainedProfileRemapPark({ reason: `${RETAINED_WORKER_PROFILE_REASON}: profile is gone` } as Task, []), true);
  const parkedEvent = { id: 4, kind: 'needs_attention', detail: `${RETAINED_WORKER_PROFILE_REASON}: profile is gone` };
  const escalated = { reason: 'Coordinator recovery could not safely continue: stuck', phase: 'blocked', resolution: { recovery: { status: 'escalated' } } } as unknown as Task;
  assert.equal(retainedProfileRemapPark(escalated, [parkedEvent]), true);
  assert.equal(retainedProfileRemapPark(escalated, [parkedEvent, { id: 5, kind: 'worker_resume_requested', detail: '' }]), false);
  assert.equal(retainedProfileRemapPark(escalated, [parkedEvent, { id: 5, kind: 'revision_requested', detail: '' }]), false);
  // A park that is not an escalation, or an event that only mentions the reason, is not a park.
  assert.equal(retainedProfileRemapPark({ ...escalated, phase: 'working' } as Task, [parkedEvent]), false);
  assert.equal(retainedProfileRemapPark(escalated, [{ ...parkedEvent, kind: 'resolution' }]), false);
});

test('the creation-failure summary round-trips through its one writer and reader', () => {
  assert.equal(creationFailureSummary('transport lost'), 'Coordinator recovery unavailable: transport lost');
  assert.equal(creationFailureDetail(creationFailureSummary('transport lost')), 'transport lost');
  assert.equal(creationFailureDetail('Coordinator recovery could not safely continue: transport lost'), null);
  assert.equal(creationFailureDetail(''), null);
});

test('the no-action escalation summary is the text its reader compares', () => {
  assert.equal(NO_ACTION_ESCALATION_SUMMARY, escalationSummary(NO_RESOLUTION_ACTION));
  assert.equal(NO_ACTION_ESCALATION_SUMMARY, 'Coordinator recovery could not safely continue: No resolution action needs retry');
});

test('a visible reason is the trimmed text, or the stop detail when the text is empty', () => {
  assert.equal(visibleTaskReason('  Next step  ', { detail: 'stop detail' }), 'Next step');
  assert.equal(visibleTaskReason('   ', { detail: 'stop detail' }), 'stop detail');
  assert.equal(visibleTaskReason('', { detail: '' }), '');
});
