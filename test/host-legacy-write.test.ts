import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { submissionSchema, type Run } from '../shared/contracts';

test('a legacy run cannot acquire an unproved host or change task', () => {
  const store = new Store(':memory:');
  try {
    const base = 'a'.repeat(40);
    const submission = submissionSchema.parse({ submissionId: 'legacy-host', title: 'Task', repoPath: '/repo', planningCommit: base, handoffPath: 'handoff', originAgentId: 'origin' });
    const task = store.insert(submission, '', 'handoff', base);
    const run: Run = { id: 'legacy', taskId: task.id, role: 'reviewer', generation: 1, head: base, base, agentId: null, workspaceId: 'ws', profile: null, status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false };
    store.putRun(run);
    assert.throws(() => store.putRun({ ...run, hostId: 'host-a' }), /not proved/);
    assert.throws(() => store.putRun({ ...run, taskId: 'other' }), /task cannot be changed/);
    assert.equal(store.run(run.id)?.hostId, undefined);
  } finally { store.close(); }
});
