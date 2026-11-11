import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingResult } from '../core/recovery/missing-result';
import type { Run, Task } from '../shared/contracts';

const head = 'a'.repeat(40);
const task = (over: Partial<Task> = {}): Task => ({
  id: 'task', version: 1, title: 'Task', repoPath: '/repo', branch: 'ns-task', baseBranch: 'main',
  planningCommit: head, planningBase: head, handoffPath: 'handoff.md', handoffText: '', originAgentId: 'origin',
  createdAt: '2026-09-26T00:00:00.000Z', updatedAt: '2026-09-26T00:00:00.000Z', phase: 'working', reason: '',
  completion: null, runId: null, idleSince: null, lastAgentStatus: null, prUrl: 'https://github.com/example/repo/pull/1',
  resolution: { currentRunId: null, attention: false } as Task['resolution'],
  ...over,
} as Task);
const run = (over: Partial<Run> = {}): Run => ({
  id: 'run', taskId: 'task', role: 'reviewer', generation: 1, head, base: head, agentId: 'agent',
  workspaceId: 'ws', profile: null, status: 'running', createdAt: '2026-09-26T00:00:00.000Z',
  lastObservedAt: null, active: false, idleSince: '2026-09-26T00:01:00.000Z', completion: null, released: false,
  ...over,
});

test('a stopped reviewer or writer without a report is held as a missing result', () => {
  const reviewer = run({ id: 'review-run', role: 'reviewer' });
  assert.deepEqual(
    missingResult(task({ resolution: { currentRunId: reviewer.id, attention: true } as Task['resolution'] }), [reviewer]),
    { role: 'reviewer', runId: 'review-run', prUrl: 'https://github.com/example/repo/pull/1' },
  );
  const writer = run({ id: 'revision-run', role: 'revision' });
  assert.deepEqual(
    missingResult(task({ phase: 'changes_requested', resolution: { currentRunId: writer.id, attention: true } as Task['resolution'] }), [writer]),
    { role: 'revision', runId: 'revision-run', prUrl: 'https://github.com/example/repo/pull/1' },
  );
  const released = run({ id: 'review-run', role: 'reviewer', released: true });
  assert.equal(missingResult(task({ resolution: { currentRunId: released.id } as Task['resolution'] }), [released]), null);
});

test('a stopped worker without a completion is held as a missing result under the same run identity', () => {
  const worker = task({ runId: 'worker-run', idleSince: '2026-09-26T00:01:00.000Z', lastAgentStatus: 'idle' });
  assert.deepEqual(missingResult(worker, []), { role: 'worker', runId: 'worker-run', prUrl: 'https://github.com/example/repo/pull/1' });
  assert.equal(missingResult(task({ runId: 'worker-run', idleSince: '2026-09-26T00:01:00.000Z', completion: { status: 'ready_for_review' } as Task['completion'] }), []), null);
});

test('an accepted revision result from the retained worker supersedes the initial missing result', () => {
  const worker = task({ runId: 'worker-run', agentId: 'agent', idleSince: '2026-09-26T00:01:00.000Z', lastAgentStatus: 'idle' });
  const expected = { role: 'worker', runId: 'worker-run', prUrl: 'https://github.com/example/repo/pull/1' };
  const accepted = run({ id: 'revision-run', role: 'revision', agentId: 'agent',
    completion: { eventId: 'rev', taskId: 'task', runId: 'revision-run', status: 'blocked', summary: 'Blocked' } as Run['completion'] });
  assert.equal(missingResult(worker, [accepted]), null);
  // A revision from another agent is not the retained worker, so the initial result may still arrive.
  assert.deepEqual(missingResult(worker, [{ ...accepted, agentId: 'other' }]), expected);
  // A revision still awaiting its result supersedes nothing.
  assert.deepEqual(missingResult(worker, [{ ...accepted, completion: null }]), expected);
});
