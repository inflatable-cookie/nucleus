import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { collectOwnerVerbFacts, ownerTaskNext } from '../core/verbs/owner-verbs';
import { submissionSchema, summarizeTask, syncHoldProjection, taskDetailView, visibleTaskSummaries, type Task } from '../shared/contracts';
import { blockingHold, dispatchWaitFence, taskStateLabel } from '../shared/task-state';

/**
 * Derived presentation only (Queue reliability): a dispatch hold on a task that
 * has not started is its current wait, whatever stored `reason` still names. The
 * stored origin, owner, holds and dispatch eligibility are never rewritten here.
 */
const head = 'a'.repeat(40), at = '2026-10-27T00:00:00.000Z';
const STALE = 'Chatterbox routing: origin 0b355fd4 was not found in workspace project-c';
const DISPATCH = 'Dispatch held by operator: planning owes a ruling on the cleared origin';
const MERGE = 'Merge held by operator: external receipt pending';
const fence = (reason: string) => ({ owner: 'operator', reason, at, generation: 1, until: null });

function seed(store: Store, id: string, patch: Partial<Task>) {
  const inserted = store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath: '/app', planningCommit: head, handoffPath: `${id}.md`, originAgentId: '0b355fd4',
  }), 'host', 'handoff', head);
  return store.update(inserted.id, { notificationAgentId: '56e9c969', originError: '', originLookupError: '', ...patch });
}
const nextOf = (store: Store, id: string) => ownerTaskNext(collectOwnerVerbFacts(store, store.task(id))).stop;
/** Everything the derivation must leave alone: origin, owner, fences and dispatch eligibility. */
const authority = (task: Task) => ({
  originAgentId: task.originAgentId, notificationAgentId: task.notificationAgentId, originError: task.originError,
  originLookupError: task.originLookupError, holds: task.holds, held: task.held, reason: task.reason, phase: task.phase,
});

test('a queued dispatch hold shows its live reason over a stale stored reason, and next agrees', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'stale-hold', {
      phase: 'queued', reason: STALE, ...syncHoldProjection({ dispatch: fence('Dispatch held by operator: planning owes a ruling on the cleared origin') }),
    });
    const before = authority(store.task(task.id));
    const summary = summarizeTask(store.task(task.id));
    assert.equal(blockingHold(summary), 'dispatch');
    assert.equal(dispatchWaitFence(summary)?.reason, DISPATCH, 'the card names the live fence');
    assert.equal(taskStateLabel(summary), 'Waiting on Tom');
    assert.equal(dispatchWaitFence(taskDetailView(store.task(task.id)))?.reason, DISPATCH, 'the detail names the same fence');
    const stop = nextOf(store, task.id);
    assert.equal(stop?.kind, 'hold');
    assert.equal(stop?.detail, DISPATCH, 'next names the same fence as the card');
    assert.equal(stop?.owner, 'operator');
    assert.match(stop?.evidence ?? '', /^dispatch hold generation 1/);
    assert.deepEqual(authority(store.task(task.id)), before, 'the stored record is untouched by the read');
  } finally { store.close(); }
});

test('with both fences on a queued task the dispatch fence is the wait and the merge fence stays visible', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'both-holds', {
      phase: 'queued', reason: STALE, ...syncHoldProjection({ dispatch: fence(DISPATCH), merge: fence(MERGE) }),
    });
    const summary = summarizeTask(store.task(task.id));
    // A merge fence blocks only a task ready to merge, so a queued task is dispatch-blocked alone.
    assert.equal(blockingHold(summary), 'dispatch');
    assert.equal(dispatchWaitFence(summary)?.reason, DISPATCH);
    assert.equal(summary.holds?.merge?.reason, MERGE, 'the merge fence stays on the summary for its chip and detail line');
    assert.equal(taskStateLabel(summary), 'Waiting on Tom', 'the dispatch wait names its owner');
    const stop = nextOf(store, task.id);
    assert.equal(stop?.detail, DISPATCH, 'next names the dispatch fence, not the merge fence');
    assert.match(stop?.evidence ?? '', /^dispatch hold generation/);
    assert.equal(taskDetailView(store.task(task.id)).holds?.merge?.reason, MERGE);
  } finally { store.close(); }
});

test('a merge-only hold on a reviewing task is not a dispatch wait and does not replace its activity', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'merge-review', {
      phase: 'reviewing', reason: 'Reviewer run is reading the diff', ...syncHoldProjection({ merge: fence(MERGE) }),
    });
    const summary = summarizeTask(store.task(task.id));
    assert.equal(blockingHold(summary), null);
    assert.equal(dispatchWaitFence(summary), null, 'the card keeps the stored activity text');
    assert.equal(taskStateLabel(summary), 'Reviewing · merge held');
    assert.equal(nextOf(store, task.id)?.detail, MERGE, 'next still reports the owner gate with its merge reason');
    assert.match(nextOf(store, task.id)?.evidence ?? '', /^merge hold generation/);
  } finally { store.close(); }
});

test('a merge hold on a task ready to merge is a merge wait, never a dispatch fence', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'merge-ready', { phase: 'verifying', reason: 'Running required checks', ...syncHoldProjection({ merge: fence(MERGE) }) });
    const summary = summarizeTask(store.task(task.id));
    assert.equal(blockingHold(summary), 'merge');
    assert.equal(dispatchWaitFence(summary), null);
  } finally { store.close(); }
});

test('a genuine unresolved origin error on an unheld queued task stays on the record and names no hold', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'real-origin-error', { phase: 'queued', reason: 'Waiting for dispatch', originError: 'Origin thread 0b355fd4 not found' });
    const summary = summarizeTask(store.task(task.id));
    assert.equal(dispatchWaitFence(summary), null);
    assert.equal(summary.originError, 'Origin thread 0b355fd4 not found', 'the routing error still reaches the board');
    assert.equal(dispatchWaitFence(taskDetailView(store.task(task.id))), null);
    assert.equal(taskStateLabel(summary), 'Queued', 'no hold is invented');
  } finally { store.close(); }
});

test('an unheld working task keeps its phase and stored reason', () => {
  const store = new Store(':memory:');
  try {
    const task = seed(store, 'unheld', { phase: 'working', reason: 'Worker is editing' });
    const summary = summarizeTask(store.task(task.id));
    assert.equal(dispatchWaitFence(summary), null);
    assert.equal(taskStateLabel(summary), 'Working');
    assert.equal(summary.reason, 'Worker is editing');
  } finally { store.close(); }
});

test('a held board card links to the task that releases its hold', () => {
  const store = new Store(':memory:');
  try {
    const prerequisite = seed(store, 'prerequisite', { phase: 'queued', number: 248, reference: 'project-c#248' });
    const waiting = seed(store, 'waiting', {
      phase: 'queued',
      dependsOn: [prerequisite.id],
      ...syncHoldProjection({ dispatch: { ...fence('Waiting for release'), until: { kind: 'task', taskId: prerequisite.id } } }),
    });
    assert.deepEqual(waiting.holdUntil, { kind: 'task', taskId: prerequisite.id });
    assert.equal(prerequisite.reference, 'project-c#248');
    const card = visibleTaskSummaries([prerequisite, waiting]).find(task => task.id === waiting.id)!;
    assert.equal(card.waitingOn, 'project-c#248');
    assert.equal(taskStateLabel(card), 'Waiting on project-c#248');
  } finally { store.close(); }
});
