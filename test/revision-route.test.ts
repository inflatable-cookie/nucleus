import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { revisionRoute } from '../core/recovery/retry-routes';

test('revision plan keeps refusals and scoped continuation explicit', () => {
  const task = { id: 't', version: 3, phase: 'changes_requested', agentId: 'a', workspaceId: 'w', profile: {},
    completion: { prNumber: 7 }, resumePrNumber: null, reason: '', resolution: { review: null } } as unknown as Task;
  type Options = Parameters<typeof revisionRoute>[2];
  const options: Options = { operator: false, prePr: false, resumeUnpublished: false, reviewOwner: false, instruction: 'work' };
  const cases: Array<[Task, Partial<Options>, string, string?]> = [
    [task, { reviewOwner: true }, 'refuse', 'A reviewer continuation owns this task; wait for its verdict or resolve the reviewer thread instead of returning the task to the worker'],
    [{ ...task, agentId: null }, {}, 'refuse', 'Returning to the worker requires an unmerged task PR'],
    [{ ...task, phase: 'done' }, {}, 'refuse', 'Returning to the worker is not valid from phase done'],
    [task, { scopedInstruction: ' ' }, 'refuse', 'Revision instruction must not be empty'],
    [task, { scopedInstruction: 'scoped' }, 'need-time'],
    [task, {}, 'revision'],
  ];
  for (const [t, changes, kind, message] of cases) {
    const result = revisionRoute(t, [] as Run[], { ...options, ...changes });
    assert.equal(result.kind, kind);
    if (message && result.kind === 'refuse') assert.equal(result.message, message);
  }
  const result = revisionRoute(task, [], { ...options, operator: true, scopedInstruction: 'scoped', createdAt: 'time' });
  assert.equal(result.kind, 'revision');
  if (result.kind === 'revision') {
    assert.equal(result.via, 'operator');
    assert.equal(result.event, 'revision_requested');
    assert.deepEqual(result.patch, { phase: 'changes_requested', reason: 'Worker action requested: work' });
    assert.equal((result.changes.revisionInstruction as { createdAt: string }).createdAt, 'time');
  }
});
