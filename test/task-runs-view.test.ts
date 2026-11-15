import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSchema, type Run, type Task } from '../shared/contracts';
import { buildOutputCleanupSubject, taskRunPartition } from '../client/task/runs-view';

/**
 * The Runs tab's two derivations: which runs are live and which are released
 * history, and which workspace and run its run-bound cleanup disclosure is
 * about. Both are typed readings of the task the detail already holds.
 */
const head = 'a'.repeat(40), at = '2026-11-01T00:00:00.000Z';

const run = (id: string, released: boolean): Run => runSchema.parse({
  id, taskId: 'task', role: 'reviewer', generation: 1, head, base: head, agentId: null, workspaceId: 'workspace',
  profile: null, status: 'finished', createdAt: at, lastObservedAt: null, active: null, idleSince: null,
  completion: null, released,
});

/** Only the fields the cleanup subject reads; the rest of the task record is not its business. */
type CleanupTask = Pick<Task, 'workspaceId' | 'phase' | 'completion'>;
const task = (overrides: Record<string, unknown>): CleanupTask =>
  ({ workspaceId: 'workspace', phase: 'working', completion: null, ...overrides }) as CleanupTask;

test('live runs lead the tab and released runs are the history behind it', () => {
  const runs = [run('newest-live', false), run('older', true), run('also-live', false)];
  const { live, earlier } = taskRunPartition(runs);
  assert.deepEqual(live.map(item => item.id), ['newest-live', 'also-live']);
  assert.deepEqual(earlier.map(item => item.id), ['older']);
  assert.deepEqual(taskRunPartition([]), { live: [], earlier: [] });
});

test('a live task names the run its completion recorded', () => {
  const subject = buildOutputCleanupSubject(task({ workspaceId: 'workspace-1', completion: { runId: 'run-2' } }));
  assert.deepEqual(subject, { workspaceId: 'workspace-1', runId: 'run-2' });
  assert.deepEqual(buildOutputCleanupSubject(task({ workspaceId: 'workspace-1' })), { workspaceId: 'workspace-1', runId: null });
});

test('a finished task has settled its workspace, so it names no run', () => {
  for (const phase of ['done', 'cancelled'] as const) {
    assert.deepEqual(
      buildOutputCleanupSubject(task({ phase, workspaceId: 'workspace-1', completion: { runId: 'run-2' } })),
      { workspaceId: 'workspace-1', runId: null },
      phase,
    );
  }
});
