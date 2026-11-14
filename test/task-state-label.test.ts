import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingHold, taskStateLabel, taskTitleStateLabel } from '../shared/task-state';
import { blockingHoldFence, type Task } from '../shared/contracts';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';

/**
 * A hold is the task's state only while it is what the task waits on (Tom,
 * 2026-10-26: "When a task is merge held, that's the only status I see ... even
 * when the task is otherwise working normally"). Otherwise the phase shows, with
 * the hold named on the board and an asterisk in the Paseo title.
 */
const merge = { merge: { owner: 'origin' } };
const dispatch = { dispatch: { owner: 'operator' } };

test('a merge hold on a task still doing its work shows the phase', () => {
  for (const [phase, label] of [['working', 'Working'], ['reviewing', 'Reviewing'], ['changes_requested', 'Changes'], ['awaiting_review', 'Review']] as const) {
    const task = { held: true, phase, holds: merge };
    assert.equal(blockingHold(task), null, phase);
    assert.equal(taskStateLabel(task), `${label} · merge held`);
    assert.equal(taskTitleStateLabel(task), `${label}*`);
  }
  assert.equal(taskWorkspaceTitle({ held: true, phase: 'working', holds: merge, title: 'Move every route', number: 769 } as never),
    'Working*: 769 Move every route');
});

test('operator hold identity includes the board caller label', () => {
  const task = { held: true, phase: 'blocked' as const, holds: { dispatch: { owner: 'Operator (Board)' } } };
  assert.equal(taskStateLabel(task), 'Waiting on Tom');
  assert.equal(taskTitleStateLabel(task), 'Waiting on Tom');
});

test('a delivered report waits for its planner without reading as blocked', () => {
  const task = { held: false, phase: 'report_ready' as const };
  assert.equal(taskStateLabel(task), 'Planner');
  assert.equal(taskTitleStateLabel(task), 'Planner');
});

test('a merge hold is the state once the task is ready to merge', () => {
  for (const phase of ['verifying', 'merging'] as const) {
    const task = { held: true, phase, holds: merge };
    assert.equal(blockingHold(task), 'merge');
    assert.equal(taskStateLabel(task), 'Merge held by planner');
    assert.equal(taskTitleStateLabel(task), 'Merge held by planner');
  }
  // The legacy single-kind field reads the same way.
  assert.equal(taskTitleStateLabel({ held: true, phase: 'merging', holdKind: 'merge' }), 'Merge held by planner');
  assert.equal(taskTitleStateLabel({ held: true, phase: 'working', holdKind: 'merge' }), 'Working*');
});

test('a dispatch hold is the state only before the task starts', () => {
  assert.equal(taskTitleStateLabel({ held: true, phase: 'queued', holds: dispatch }), 'Waiting on Tom');
  assert.equal(taskStateLabel({ held: true, phase: 'working', holds: dispatch }), 'Working · dispatch held');
  assert.equal(taskTitleStateLabel({ held: true, phase: 'working', holds: dispatch }), 'Working*');
  const both = { held: true, holds: { ...dispatch, ...merge } };
  assert.equal(taskStateLabel({ ...both, phase: 'queued' }), 'Waiting on Tom');
  assert.equal(taskStateLabel({ ...both, phase: 'reviewing' }), 'Reviewing · dispatch and merge held');
});

test('unheld, finished and unnamed holds keep their existing labels', () => {
  assert.equal(taskStateLabel({ held: false, phase: 'working' }), 'Working');
  assert.equal(taskTitleStateLabel({ held: false, phase: 'reviewing' }), 'Reviewing');
  assert.equal(taskStateLabel({ held: true, phase: 'working' }), 'Held by planner', 'a hold without a kind names its holder role');
  assert.equal(taskTitleStateLabel({ held: false, phase: 'done', holds: merge }), 'Done', 'a finished task carries no marker');
  assert.equal(taskStateLabel({ held: false, phase: 'working', disposition: { status: 'pending', kind: 'cancel' } }), 'Cancelling');
});

test('deliberate holds say what or who they are waiting for', () => {
  assert.equal(taskTitleStateLabel({ held: true, phase: 'queued', holdKind: 'dispatch', waitingOn: '#248' }), 'Waiting on #248');
  assert.equal(taskStateLabel({ held: true, phase: 'queued', holdKind: 'dispatch', hold: { owner: 'operator' } }), 'Waiting on Tom');
  assert.equal(taskStateLabel({ held: true, phase: 'queued', holdKind: 'dispatch', hold: { owner: 'planner-agent' } }), 'Held by planner');
  assert.equal(taskStateLabel({ held: false, phase: 'blocked' }), 'Blocked', 'a worker block without a holder remains actionable');
  assert.equal(taskTitleStateLabel({ held: false, phase: 'needs_attention', waitState: { state: 'needs_operator_input', owner: 'operator' } }), 'Waiting on Tom');
  assert.equal(taskTitleStateLabel({ held: false, phase: 'working', waitState: { state: 'needs_operator_input', owner: 'operator' } }), 'Working', 'a wait does not hide active task work');
  assert.equal(taskWorkspaceTitle({ held: true, phase: 'queued', title: 'Plan', number: 1, holdOwner: 'operator' } as never), 'Waiting on Tom: 001 Plan');
  assert.equal(taskWorkspaceTitle({ held: true, phase: 'queued', title: 'Plan', number: 1, holdUntil: { kind: 'task', taskId: 'target' } } as never,
    new Map([['target', 'project-c#248']])), 'Waiting on project-c#248: 001 Plan');
});

test('live held rows use their fence reason and owner in workspace titles', () => {
  const rows = {
    'project-c#240': { phase: 'needs_attention', held: true, holdOwner: 'task-owner', number: 240, title: 'F6-O2 X-S1: record Project-C prune leaves in a test-only harness', holds: {
      dispatch: { owner: 'task-owner', reason: 'active common admission248 is the prerequisite', until: { kind: 'task', taskId: '437631a3-c06c-4c77-a40e-ef76012cc915' } },
      merge: { owner: 'task-owner', reason: 'common248 precedes exact-head review' },
    } },
    'project-f#041': { phase: 'blocked', held: true, holdOwner: 'operator', number: 41, title: 'F6-O2 B-S1: record Project-F evaluator leaves in a test-only harness', holds: {
      merge: { owner: 'operator', reason: 'Proofs Queue cannot run; left for the planner or operator' },
    } },
    'project-e#269': { phase: 'blocked', held: true, holdOwner: 'task-owner', number: 269, title: 'Deck app 11b: Longhorn host, Project-K bars and bounded native shell', holds: {
      dispatch: { owner: 'task-owner', reason: 'Wait for Longhorn084 bundled-local API implementation and native proof' },
    } },
    'project-c#248': { phase: 'changes_requested', held: true, holdOwner: 'task-owner', number: 248, title: 'Close the shared private-build validation admission gate for capture tasks', holds: {
      merge: { owner: 'task-owner', reason: 'Merge remains held for corrected exact-head review' },
    } },
    'effigy#531': { phase: 'verifying', held: true, holdOwner: 'task-owner', number: 531, title: 'Enable private Discard workspace execution after custody qualification', holds: {
      merge: { owner: 'task-owner', reason: 'Actual receipts and final production-enable GO are absent' },
    } },
  } as const;
  const title = (row: typeof rows[keyof typeof rows]) => taskWorkspaceTitle(row as never,
    new Map([['437631a3-c06c-4c77-a40e-ef76012cc915', '#248']]));
  assert.equal(title(rows['project-c#240']), 'Waiting on #248: 240 F6-O2 X-S1: record Project-C prune leaves in a test-only harness');
  assert.equal(title(rows['project-f#041']), 'Waiting on Tom: 041 F6-O2 B-S1: record Project-F evaluator leaves in a test-only harness');
  assert.equal(title(rows['project-e#269']), 'Waiting on Longhorn release: 269 Deck app 11b: Longhorn host, Project-K bars and bounded native shell');
  assert.equal(title(rows['project-c#248']), 'Changes*: 248 Close the shared private-build validation admission gate for capture tasks');
  assert.equal(title(rows['effigy#531']), 'Merge held by planner: 531 Enable private Discard workspace execution after custody qualification');
});

test('terminal workspace title follows its phase even with a stale hold', () => {
  assert.equal(taskTitleStateLabel({ held: true, phase: 'done' }), 'Done');
  assert.equal(taskTitleStateLabel({ held: true, phase: 'cancelled' }), 'Cancelled');
});


test('server and client agree on the blocking fence across every phase', () => {
  const phases = ['queued', 'dispatching', 'working', 'awaiting_review', 'report_ready', 'blocked', 'error', 'needs_attention', 'cancelled', 'reviewing', 'changes_requested', 'verifying', 'merging', 'syncing', 'closing', 'done'] as const;
  const fence = { owner: 'operator', reason: 'waiting', generation: 1 };
  for (const phase of phases) for (const dispatch of [false, true]) for (const merge of [false, true]) {
    const task = { phase, held: dispatch || merge, holds: { ...(dispatch ? { dispatch: fence } : {}), ...(merge ? { merge: fence } : {}) } };
    assert.equal(blockingHoldFence(task as unknown as Task)?.kind ?? null, blockingHold(task), `${phase}/${dispatch}/${merge}`);
  }
  for (const phase of ['blocked', 'needs_attention'] as const) {
    const task = { phase, held: true, holds: { dispatch: fence, merge: fence } };
    assert.equal(blockingHoldFence(task as unknown as Task)?.fence, fence);
    assert.equal(blockingHold(task), 'dispatch');
  }
});
