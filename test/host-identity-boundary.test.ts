import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { submissionSchema, type Run } from '../shared/contracts';

const base = 'a'.repeat(40);
test('task and run host identity cannot be changed by ordinary writes', () => {
  const store = new Store(':memory:');
  try {
    const submission = submissionSchema.parse({ submissionId: 'host-boundary', title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff', originAgentId: 'origin' });
    const task = store.insert(submission, 'host-a', 'handoff', base, { hostId: 'host-b' });
    assert.equal(task.hostId, 'host-a');
    assert.throws(() => store.update(task.id, { hostId: 'host-b' }), /host cannot be changed/);
    const run: Run = { id: 'r', taskId: task.id, role: 'reviewer', generation: 1, head: base, base, agentId: null, workspaceId: 'ws', profile: null, status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false };
    assert.throws(() => store.putRun({ ...run, hostId: 'host-b' }), /does not match/);
    store.putRun(run);
    store.putRun({ ...run, hostId: 'host-b', status: 'running' });
    assert.equal(store.run('r')?.hostId, 'host-a');
  } finally { store.close(); }
});
