import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationInputHash } from '../core/store/store';
import { taskControlInputSchema, type Task } from '../shared/contracts';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';

/**
 * A terminal `retry_effect` waits for its own cleanup occurrence, not for the
 * shared cleanup queue to empty (2026-10-23: the three discard operations
 * stayed `running` after their archives landed, because every audit pass
 * re-enqueues every done task). A replayed operation whose own archive already
 * landed settles from that recorded outcome instead of refusing as stale.
 */

const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);

test('a terminal archive retry settles once its own occurrence is processed while the shared queue keeps refilling', async t => {
  const f = await terminalArchiveFixture(t);
  const lifecycle = (f.engine as unknown as { lifecycle: { archive: (task: Task, retry?: string) => Promise<void> } }).lifecycle;
  const archive = lifecycle.archive.bind(lifecycle);
  let refills = 0;
  // Another cleanup item re-enqueues itself every time it is processed, as the audit pass does for done tasks.
  lifecycle.archive = async (task, retry) => {
    if (retry === 'refill') { refills++; await new Promise(resolve => setImmediate(resolve)); f.engine.enqueueCleanup(task.id, 'refill'); return; }
    return archive(task, retry);
  };
  f.engine.enqueueCleanup(f.task().id, 'refill');
  const archived = await within(f.retry(), 10_000, 'the retry');
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.ok(refills >= 1, 'the shared queue was still refilling');
});

test('a replayed archive retry whose own archive landed settles from that outcome; without that proof it still refuses as stale', async t => {
  const f = await terminalArchiveFixture(t);
  const control = { taskId: f.task().id, version: f.task().version, action: 'retry_effect' as const, effect: 'workspace_archive.ws',
    caller: 'operator (board)', reason: 'Retry after repairing the archive blocker' };
  const payload = { type: 'task_control' as const, control };
  const acceptance = f.store.acceptOperation({ key: 'replay-archive', kind: 'task_control', inputHash: operationInputHash(payload),
    taskId: control.taskId, expectedVersion: control.version, payload, hostId: f.store.task(control.taskId).hostId }); // Queue #912: accepted operations record their task's host
  assert.ok('accepted' in acceptance);
  const operationId = acceptance.operation.id;
  // The first run: the archive lands, then the process stops before the operation settles.
  f.store.putOperation({ ...acceptance.operation, state: 'running', startedAt: new Date().toISOString(), attempts: 1 });
  await f.engine.performTaskControl(taskControlInputSchema.parse(control), operationId);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  assert.notEqual(f.task().version, control.version, 'the task moved on, so the replayed version is stale');
  // Without its operation the stale version refuses, as before.
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(control)), /Task changed/);
  // Its own operation replays to the recorded outcome, with nothing re-enqueued.
  const archivesBefore = f.remote.archives.length;
  const replayed = await f.engine.performTaskControl(taskControlInputSchema.parse(control), operationId);
  assert.deepEqual(replayed.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(f.remote.archives.length, archivesBefore, 'no native archive replay');
  // The service-start resume settles the operation from that outcome.
  f.engine.resumeOperations();
  await within((async () => { while (f.store.operation(operationId)?.state === 'running') await new Promise(resolve => setTimeout(resolve, 20)); })(), 10_000, 'the resumed operation');
  assert.equal(f.store.operation(operationId)?.state, 'succeeded');
  // An operation accepted after the archive landed has no such proof: it refuses as stale.
  const later = { ...control, reason: 'A later retry' };
  const laterPayload = { type: 'task_control' as const, control: later };
  const laterAcceptance = f.store.acceptOperation({ key: 'replay-archive-later', kind: 'task_control', inputHash: operationInputHash(laterPayload),
    taskId: later.taskId, expectedVersion: later.version, payload: laterPayload, hostId: f.store.task(later.taskId).hostId });
  assert.ok('accepted' in laterAcceptance);
  f.store.putOperation({ ...laterAcceptance.operation, state: 'running', startedAt: new Date().toISOString(), attempts: 1 });
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(later), laterAcceptance.operation.id), /Task changed/);
});

test('Sol #611 P2: a replay never borrows an archive it did not cause, and its stored control must be this request', async t => {
  const f = await terminalArchiveFixture(t);
  // Workspace ws archives before any operation exists.
  await f.retry();
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  const accept = (key: string, control: Record<string, unknown>) => {
    const payload = { type: 'task_control' as const, control };
    const acceptance = f.store.acceptOperation({ key, kind: 'task_control', inputHash: operationInputHash(payload),
      taskId: f.task().id, expectedVersion: control.version as number, payload });
    assert.ok('accepted' in acceptance);
    f.store.putOperation({ ...acceptance.operation, state: 'running', startedAt: new Date().toISOString(), attempts: 1 });
    return acceptance.operation.id;
  };
  const control = { taskId: f.task().id, version: f.task().version, action: 'retry_effect' as const, effect: 'workspace_archive.ws',
    caller: 'operator (board)', reason: 'A stale retry of an already archived workspace' };
  const operationId = accept('borrow', control);
  await new Promise(resolve => setTimeout(resolve, 5));
  // Another workspace archives after the operation was accepted.
  f.store.event(f.task().id, 'workspace_archived', 'workspace_archived; workspace other-ws');
  f.store.event(f.task().id, 'workspace_contents_discarded', JSON.stringify({ workspaceId: 'other-ws' }));
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(control), operationId), /pending|Task changed/,
    'the later archive of another workspace is not this operation\'s outcome');
  // A stored control that is not this request is not its operation either.
  const otherId = accept('other-control', { ...control, effect: 'workspace_archive.other-ws', reason: 'Another effect' });
  f.store.event(f.task().id, 'workspace_archived', 'workspace_archived; workspace ws');
  await assert.rejects(f.engine.performTaskControl(taskControlInputSchema.parse(control), otherId), /pending|Task changed/);
});
