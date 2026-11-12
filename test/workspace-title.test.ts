import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Projections } from '../core/store/projections';
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
    tasks: () => [current],
    listDecisions: () => [],
    getMeta: (key: string) => meta.get(key),
    setMeta: (key: string, value: unknown) => meta.set(key, value),
    event: () => undefined,
  };
  const adapter = { setTaskWorkspaceTitle: async (_task: Task, title: string) => {
    calls.push(title);
    if (calls.length === 1) { started(); await gate; }
  } };
  let projections!: Projections;
  const engine = {
    get store() { return store; }, get adapter() { return adapter; }, get stopped() { return false; },
    get lifecycle() { return {}; }, get retirement() { return {}; }, get admission() { return {}; },
    get completionFollowUpDelays() { return {}; }, withHost: async (_host: string, work: () => Promise<void>) => work(),
    taskHostAvailable: () => true,
    syncWorkspaceTitle: (value: Task) => projections.syncWorkspaceTitle(value),
    drainTitles: () => projections.drainTitles(),
  } as unknown as Engine;
  projections = new Projections(engine);

  projections.enqueueTitle(current.id);
  await entered;
  current = task('awaiting_review');
  projections.enqueueTitle(current.id);
  current = task('merging');
  projections.enqueueTitle(current.id);
  finish();
  await projections.drainTitles();

  assert.deepEqual(calls, [
    'Working: 225 Synthetic task',
    'Merging: 225 Synthetic task',
  ]);
});
