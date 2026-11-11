/**
 * Workspace custody and the warm task projection.
 *
 * The shadow observer that used to exercise these paths is retired (Spec 034),
 * but the queries and acknowledgement ordering it happened to run are still
 * product: `workspaceUsedByOtherTaskRun` gates review views, workspace
 * retirement and archive retirements, and every task/run funnel must
 * acknowledge its projection clock before a synchronous `onTaskChange` reader
 * reads the task. These tests keep that coverage without the retired producer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { runSchema, submissionSchema, type Task } from '../shared/contracts';

function fixture(options: { tasks?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-workspace-ownership-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const total = options.tasks ?? 1;
  const tasks: Task[] = [];
  store.transaction(() => {
    for (let index = 0; index < total; index++)
      tasks.push(store.insert(submissionSchema.parse({ submissionId: index ? `task-${index}` : 'task',
        title: index ? `Task ${index}` : 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40),
        handoffPath: index ? `task-${index}.md` : 'task.md', originAgentId: 'origin' }), 'host', 'Approved handoff', 'a'.repeat(40)));
  });
  store.admissionCandidates();
  const parsing = store as unknown as { numberedTask: (data: string) => Task };
  const original = parsing.numberedTask.bind(store);
  let parses = 0;
  parsing.numberedTask = data => { parses++; return original(data); };
  return { dir, store, task: tasks[0], tasks, parses: () => parses,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

type ProjectionInternals = {
  taskProjection: Map<string, Task> | null;
  ensureTaskProjection(): void;
};
const internals = (store: Store) => (store as unknown as { tasksStore: ProjectionInternals }).tasksStore;

/** Counts projection rebuilds: a rebuild replaces the projected map object. */
function countProjectionRebuilds(store: Store) {
  const state = internals(store);
  const original = state.ensureTaskProjection.bind(state);
  let rebuilds = 0;
  state.ensureTaskProjection = () => {
    const before = state.taskProjection;
    original();
    if (state.taskProjection !== before) rebuilds++;
  };
  return { count: () => rebuilds, restore: () => { state.ensureTaskProjection = original; } };
}

test('workspace run ownership is one query across other unremoved tasks', () => {
  const { store, task, close } = fixture();
  try {
    const other = store.insert(submissionSchema.parse({ submissionId: 'other', title: 'Other', repoPath: '/repo',
      planningCommit: 'a'.repeat(40), handoffPath: 'other.md', originAgentId: 'origin' }), 'host', 'source', 'a'.repeat(40));
    store.putRun({ id: 'other-run', taskId: other.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'main', agentId: 'agent',
      workspaceId: 'shared', profile: null, status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, released: true } as never);
    assert.equal(store.workspaceUsedByOtherTaskRun(task.id, 'shared'), true, 'another task run names it');
    assert.equal(store.workspaceUsedByOtherTaskRun(other.id, 'shared'), false, 'the task its own run does not count');
    assert.equal(store.workspaceUsedByOtherTaskRun(task.id, 'elsewhere'), false);
    store.update(other.id, { removedAt: new Date().toISOString() });
    assert.equal(store.workspaceUsedByOtherTaskRun(task.id, 'shared'), false, 'a removed task owns nothing');
  } finally { close(); }
});

test('putRun acknowledges its clock before a synchronous task-change reader', () => {
  const f = fixture({ tasks: 3 });
  const counter = countProjectionRebuilds(f.store);
  const observed: Array<{ title: string; observedAt: string | null }> = [];
  const off = f.store.onTaskChange(() => {
    const task = f.store.task(f.task.id);
    observed.push({ title: task.title, observedAt: task.lastObservedAt });
  });
  try {
    const run = runSchema.parse({ id: 'run', taskId: f.task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', profile: null, lastObservedAt: null,
      active: true, idleSince: null, completion: null, released: false, createdAt: '2026-10-08T00:00:00.000Z' });
    f.store.putRun(run);
    const afterCreate = observed.length;
    f.store.putRun({ ...f.store.run(run.id)!, lastObservedAt: '2026-10-08T00:05:00.000Z' });
    assert.equal(observed.length, afterCreate + 1);
    assert.equal(counter.count(), 0, 'an observation-only run write acknowledges before its reader');
    f.store.putRun({ ...f.store.run(run.id)!, status: 'finished' });
    assert.equal(counter.count(), 0, 'a substantive run write acknowledges before its reader');
    f.store.update(f.task.id, { lastObservedAt: '2026-10-08T00:07:00.000Z' });
    assert.equal(counter.count(), 0, 'a later observation-only task write still reuses the projection');
    assert.equal(f.store.task(f.task.id).lastObservedAt, '2026-10-08T00:07:00.000Z');
    assert.equal(f.parses(), 0, 'no task row was re-parsed by the reader');
  } finally { off(); counter.restore(); f.close(); }
});

test('an observation-only task write acknowledges before a synchronous reader, and a foreign write still rebuilds', () => {
  const f = fixture({ tasks: 6 });
  const counter = countProjectionRebuilds(f.store);
  const reads: Array<{ title: string; observedAt: string | null }> = [];
  const off = f.store.onTaskChange(() => {
    const task = f.store.task(f.task.id);
    reads.push({ title: task.title, observedAt: task.lastObservedAt });
  });
  try {
    const projection = internals(f.store).taskProjection;
    assert.ok(projection, 'the projection is populated before the write');
    const observedAt = '2026-10-08T00:05:00.000Z';
    const updated = f.store.update(f.task.id, { lastObservedAt: observedAt });
    assert.equal(updated.version, f.task.version, 'an observation-only write spends no version');
    assert.equal(counter.count(), 0, 'the synchronous reader reused the incrementally updated projection');
    assert.equal(internals(f.store).taskProjection, projection, 'no rebuild replaced the populated projection');
    assert.equal(reads.at(-1)?.observedAt, observedAt, 'the reader saw this write');
    assert.equal(f.parses(), 0, 'no historical scan');

    // A genuine out-of-funnel write is detected before the next funnel reader.
    f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...f.store.task(f.task.id), title: 'outside funnel' }), f.task.id);
    f.store.update(f.task.id, { lastObservedAt: '2026-10-08T00:06:00.000Z' });
    assert.equal(counter.count(), 1, 'the genuine foreign write costs one rebuild');
    assert.equal(f.store.task(f.task.id).title, 'outside funnel', 'the truth is served, never hidden');
    assert.equal(f.store.task(f.task.id).lastObservedAt, '2026-10-08T00:06:00.000Z');
  } finally { off(); counter.restore(); f.close(); }
});
