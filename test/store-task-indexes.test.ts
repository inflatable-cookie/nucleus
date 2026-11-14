import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { submissionSchema, type Task } from '../shared/contracts';
import { taskStopRecord } from '../shared/task-stop';

// The task read model's real boundary: the dispatch and board indexes it maintains
// incrementally, read through the store's own public lists after ordinary writes.
// These assert the answers the old full scans gave, including the facts that are
// *not* derived from text.

function fixture() {
  const store = new Store(':memory:');
  const add = (repoPath = '/fixture', initial: Partial<Task> = {}) => store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Task', repoPath, planningCommit: 'a'.repeat(40),
    handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40), initial);
  return { store, add };
}

const ids = (tasks: Task[]) => tasks.map(task => task.id);

test('ready heads keep priority order per repository, papercuts beside ordinary requests', () => {
  const f = fixture();
  try {
    const first = f.add('/project-a');
    const urgent = f.add('/project-a');
    f.store.update(urgent.id, { queuePriority: 1 });
    const cut = f.add('/project-a', { papercutTask: true });
    const otherRepo = f.add('/project-b');
    // One ordinary head, the papercut beside it, and the repository's oldest request for
    // fair rotation; the answer is newest first.
    assert.deepEqual(ids(f.store.readyQueueHeads(1, '/project-a')), [cut.id, urgent.id, first.id]);
    assert.deepEqual(ids(f.store.readyQueueHeads(1, '/project-b')), [otherRepo.id]);
    // The fair-rotation helper reads repository heads from every repository that has one.
    assert.equal(f.store.readyQueueHeads(10).length, 4);
    // A started request appears only when the caller asks for started work.
    f.store.update(cut.id, { workspaceIntent: true });
    assert.deepEqual(ids(f.store.readyQueueHeads(10, '/project-a', true)), [cut.id]);
  } finally { f.store.close(); }
});

test('a route wait is read from the typed stop, never from the reason text', () => {
  const f = fixture();
  try {
    const textOnly = f.add('/project-a');
    f.store.update(textOnly.id, { reason: 'No eligible worker profile' });
    // Text alone is not a route stop: the request still takes its place in the queue.
    assert.ok(ids(f.store.readyQueueHeads(10)).includes(textOnly.id));
    assert.equal(f.store.routingRetryAllowed(f.store.task(textOnly.id)), false);

    const typed = f.add('/project-a');
    const task = f.store.task(typed.id);
    f.store.update(typed.id, { reason: 'No eligible worker profile',
      resolution: { ...task.resolution, stop: taskStopRecord('route_unavailable', 'No eligible worker profile') } });
    // A fresh route wait is retried once; recording the attempt sets the task aside.
    assert.equal(f.store.routingRetryAllowed(f.store.task(typed.id)), true);
    f.store.markRoutingAttempt(typed.id);
    assert.equal(f.store.routingRetryAllowed(f.store.task(typed.id)), false);
    assert.ok(!ids(f.store.readyQueueHeads(10)).includes(typed.id));
    // A changed routing catalog earns the task one fresh attempt.
    f.store.setRoutingEpoch('catalog-changed');
    assert.equal(f.store.routingRetryAllowed(f.store.task(typed.id)), true);
    assert.ok(ids(f.store.readyQueueHeads(10)).includes(typed.id));
  } finally { f.store.close(); }
});

test('the board band keeps obligated finished work and drops settled history', () => {
  const f = fixture();
  try {
    const live = f.add('/project-a');
    const queued = f.add('/project-a');
    const settled = f.add('/project-a');
    f.store.update(settled.id, { phase: 'done' });
    const obligated = f.add('/project-a');
    f.store.update(obligated.id, { phase: 'done', originError: 'origin thread is missing' });
    assert.deepEqual(new Set(ids(f.store.boardTasks(10))), new Set([live.id, queued.id, obligated.id]));
    assert.deepEqual(f.store.boardQueuePage('/project-a', 0, 10).tasks.map(task => task.id).sort(), [live.id, queued.id].sort());
    assert.deepEqual(f.store.boardQueueCounts(), [{ repoPath: '/project-a', count: 2 }]);
    assert.ok(ids(f.store.uiTasks()).includes(obligated.id));
    assert.ok(!ids(f.store.uiTasks()).includes(settled.id));
  } finally { f.store.close(); }
});

test('hold wake timers are indexed per task and re-indexed when the fence moves', () => {
  const f = fixture();
  try {
    const held = f.add('/project-a');
    const now = Date.now();
    f.store.update(held.id, { holdUntil: { kind: 'time', at: new Date(now + 60_000).toISOString() } });
    assert.deepEqual(ids(f.store.dueHoldTasks(now)), []);
    assert.deepEqual(ids(f.store.dueHoldTasks(now + 90_000)), [held.id]);
    // A later fence replaces the earlier timer: the task is due once, at the new time.
    f.store.update(held.id, { holdUntil: { kind: 'time', at: new Date(now + 120_000).toISOString() } });
    assert.deepEqual(ids(f.store.dueHoldTasks(now + 90_000)), []);
    assert.deepEqual(ids(f.store.dueHoldTasks(now + 150_000)), [held.id]);
  } finally { f.store.close(); }
});

test('a task-targeted hold wakes when its target settles, without a sweep', () => {
  const f = fixture();
  try {
    const target = f.add('/project-a');
    const waiting = f.add('/project-a');
    f.store.update(waiting.id, { holdUntil: { kind: 'task', taskId: target.id } });
    assert.deepEqual(ids(f.store.dueHoldTasks(Date.now())), []);
    f.store.update(target.id, { phase: 'done' });
    assert.deepEqual(ids(f.store.dueHoldTasks(Date.now())), [waiting.id]);
  } finally { f.store.close(); }
});

test('origin workspace groups keep the newest recorded workspace and exclude the operator', () => {
  const f = fixture();
  try {
    f.add('/project-a', { originWorkspaceId: 'ws-old' });
    const newer = f.add('/project-a', { originWorkspaceId: 'ws-new' });
    const bare = f.add('/project-a');
    assert.equal(f.store.originWorkspaces().get('origin'), 'ws-new');
    // Queued rows group by their recorded workspace, so an origin pass reads one group per
    // workspace instead of one lookup per task.
    assert.deepEqual(f.store.queuedOriginGroups().map(group => [group.owner, group.workspaceId, group.ids.size]).sort(),
      [['origin', null, 1], ['origin', 'ws-new', 1], ['origin', 'ws-old', 1]].sort());
    // The newest task that recorded a workspace is the fallback; clearing it falls back again.
    f.store.update(newer.id, { originWorkspaceId: null });
    assert.equal(f.store.originWorkspaces().get('origin'), 'ws-old');
    // A finished queued row leaves both indexes, and a cleared workspace joins the bare group.
    f.store.update(bare.id, { phase: 'done' });
    assert.deepEqual(new Set(f.store.queuedOriginGroups().map(group => JSON.stringify([group.workspaceId, group.ids.size]))),
      new Set([JSON.stringify([null, 1]), JSON.stringify(['ws-old', 1])]));
  } finally { f.store.close(); }
});

test('the operational visit set holds only queued rows with an obligation', () => {
  const f = fixture();
  try {
    const inert = f.add('/project-a');
    const obligated = f.add('/project-a', { workspaceIntent: true });
    const dispatched = f.add('/project-a');
    f.store.update(dispatched.id, { phase: 'working' });
    const visited = ids(f.store.maintenanceTasks(true));
    assert.ok(visited.includes(obligated.id));
    assert.ok(visited.includes(dispatched.id));
    assert.ok(!visited.includes(inert.id));
    // The full audit set still visits the inert queued row.
    assert.ok(ids(f.store.maintenanceTasks()).includes(inert.id));
    // An obligation that arrives later moves the row into the set.
    f.store.update(inert.id, { agentIntent: true });
    assert.ok(ids(f.store.maintenanceTasks(true)).includes(inert.id));
    f.store.update(inert.id, { agentIntent: false });
    assert.ok(!ids(f.store.maintenanceTasks(true)).includes(inert.id));
  } finally { f.store.close(); }
});

test('queued lane statistics count queued rows per lane and repository, newest activity last', () => {
  const f = fixture();
  try {
    for (const key of ['one', 'two'])
      f.store.upsertLane({ key, title: key, aim: key, repositories: [{ origin: 'owner/repository', path: '/project-a' }] });
    const a = f.add('/project-a', { lanes: ['one', 'two'] });
    f.add('/project-b', { lanes: ['one'] });
    assert.deepEqual(f.store.laneViews({}).map(view => [view.key, view.liveByPhase.queued ?? 0]).sort(), [['one', 2], ['two', 1]]);
    f.store.update(a.id, { phase: 'done' });
    assert.deepEqual(f.store.laneViews({}).map(view => [view.key, view.liveByPhase.queued ?? 0]).sort(), [['one', 1], ['two', 0]]);
  } finally { f.store.close(); }
});

test('a live snapshot page follows its opaque cursor and keeps a stable order', () => {
  const f = fixture();
  try {
    const created = [f.add('/project-a'), f.add('/project-a'), f.add('/project-b')];
    const first = f.store.liveSnapshot({ limit: 2 });
    assert.equal(first.tasks.length, 2);
    assert.ok(first.hasMore && first.cursor);
    const second = f.store.liveSnapshot({ limit: 2, cursor: first.cursor! });
    assert.equal(second.tasks.length, 1);
    assert.equal(second.hasMore, false);
    assert.deepEqual(new Set([...first.tasks, ...second.tasks].map(task => task.id)), new Set(created.map(task => task.id)));
    assert.throws(() => f.store.liveSnapshot({ cursor: 'not-a-cursor' }), /Invalid snapshot cursor/);
    // A project filter names only its own repository's live fleet.
    assert.deepEqual(ids(f.store.liveSnapshot({ project: f.store.projects()[0]!.key }).tasks as unknown as Task[]).length, 2);
  } finally { f.store.close(); }
});

test('identity lookup answers only a proven host and never a fleet history', () => {
  const f = fixture();
  try {
    const task = f.add('/project-a');
    f.store.update(task.id, { agentId: 'agent-1' });
    assert.deepEqual(f.store.taskIdsForIdentities({ agentId: 'agent-1' }), [task.id]);
    assert.deepEqual(f.store.taskIdsForIdentities({ agentId: 'agent-1', hostId: 'host' }), [task.id]);
    assert.deepEqual(f.store.taskIdsForIdentities({ agentId: 'agent-1', hostId: 'other-host' }), []);
    assert.deepEqual(f.store.taskIdsForIdentities({ agentId: 'unknown' }), []);
  } finally { f.store.close(); }
});
