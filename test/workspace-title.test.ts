import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectionOccurrences } from '../core/scheduling/projection-occurrences';
import { WorkspaceTitleProjection } from '../core/workspaces/workspace-title-projection';
import { taskWorkspaceTitle } from '../core/workspaces/workspace-title';
import type { Engine } from '../core/engine';
import type { Task } from '../shared/contracts';

const task = (phase: Task['phase']): Task => ({ id: 'synthetic-task', number: 225, title: 'Synthetic task worker', phase,
  held: false, hostId: 't3code:synthetic', workspaceId: 'synthetic-workspace', resolution: { archivedWorkspaceIds: [] } } as unknown as Task);

test('task workspace titles provide the shared working, review and merge words', () => {
  assert.equal(taskWorkspaceTitle(task('working')), 'Working: 225 Synthetic task');
  assert.equal(taskWorkspaceTitle(task('awaiting_review')), 'Review: 225 Synthetic task');
  assert.equal(taskWorkspaceTitle(task('merging')), 'Merging: 225 Synthetic task');
});

test('a title sync reads only the task references it names, never every task', async () => {
  let current = task('working');
  const reads: string[] = [];
  const meta = new Map<string, unknown>();
  const store: Record<string, unknown> = {
    task: () => current,
    taskOrNull: (id: string) => { reads.push(id); return { id, number: 226, title: 'Synthetic blocker', phase: 'working' }; },
    listDecisions: () => [],
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: unknown) => meta.set(key, value),
    event: () => undefined,
  };
  const titles = new WorkspaceTitleProjection({ get store() { return store; }, get adapter() { return { setTaskWorkspaceTitle: async () => undefined }; },
    get stopped() { return false; }, get admission() { return {}; } } as unknown as Engine, new ProjectionOccurrences());

  await titles.sync(current);
  assert.deepEqual(reads, [], 'an ordinary title names no other task, so none is read');
  current = { ...task('blocked'), holdUntil: { kind: 'task', taskId: 'synthetic-blocker' } } as unknown as Task;
  await titles.sync(current);
  assert.deepEqual(reads, ['synthetic-blocker'], 'one read for the one id the title names');
});

test('queued title changes coalesce to the latest task state', async () => {
  let current = task('working');
  const calls: string[] = [];
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const meta = new Map<string, any>();
  const store = {
    task: () => current,
    taskOrNull: () => current,
    listDecisions: () => [],
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: unknown) => meta.set(key, value),
    event: () => undefined,
  };
  const adapter = { setTaskWorkspaceTitle: async (_task: Task, title: string) => {
    calls.push(title);
    if (calls.length === 1) { started(); await gate; }
  } };
  let titles!: WorkspaceTitleProjection;
  const engine = {
    get store() { return store; }, get adapter() { return adapter; }, get stopped() { return false; },
    get lifecycle() { return {}; }, get retirement() { return {}; }, get admission() { return {}; },
    get completionFollowUpDelays() { return {}; }, withHost: async (_host: string, work: () => Promise<void>) => work(),
    taskHostAvailable: () => true,
    syncWorkspaceTitle: (value: Task) => titles.sync(value),
    drainTitles: () => titles.drain(),
  } as unknown as Engine;
  titles = new WorkspaceTitleProjection(engine, new ProjectionOccurrences());

  titles.enqueue(current.id);
  await entered;
  current = task('awaiting_review');
  titles.enqueue(current.id);
  current = task('merging');
  titles.enqueue(current.id);
  finish();
  await titles.drain();

  assert.deepEqual(calls, [
    'Working: 225 Synthetic task',
    'Merging: 225 Synthetic task',
  ]);
});
