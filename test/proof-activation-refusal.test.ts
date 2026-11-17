import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { proofActivationRefusal, proofActivationPreview } from '../core/qa/proof-activation';

test('proof activation preserves ordered task, live-run and pause refusals', () => {
  const task = { phase: 'reviewing', prHead: 'head', prUrl: 'url', resolution: {} } as unknown as Task;
  type Stage = Parameters<typeof proofActivationRefusal>[2];
  const cases: Array<[Task, Run[], Stage, boolean, string | null]> = [
    [task, [], 'ordinary', false, null],
    [{ ...task, removedAt: 'now' }, [], 'removed', false, 'Task was removed from the queue'],
    [{ ...task, phase: 'done' }, [], 'terminal', false, 'The task is done; proof execution is closed'],
    [{ ...task, phase: 'working' }, [], 'proof-only', false, 'A proof-only qualification without release GO activates only from queued or after a pre-selector refusal; the task is working'],
    [task, [], 'selector', false, 'This task names no author-side proof selector; the brief or handoff must set queue.proofExecution with the selector and input hashes'],
    [{ ...task, resolution: { ...task.resolution, mergeIntent: {} as Task['resolution']['mergeIntent'] } }, [], 'ordinary', false, 'The task is merging or merged; author-side proof execution applies before merge only'],
    [{ ...task, phase: 'working' }, [], 'ordinary', false, 'Author-side proof execution applies before independent review; the task is working'],
    [{ ...task, prHead: null }, [], 'ordinary', false, 'Proof execution needs the exact published PR head this task records'],
    [task, [{ role: 'reviewer', released: false } as Run], 'idle', false, 'A reviewer run is live; the proof executor starts only on an idle task, and nothing was dispatched'],
    [task, [{ role: 'reviewer', released: true } as Run], 'idle', false, null],
    [task, [], 'paused', true, 'Nucleus is paused; the proof executor waits for unpause and no execution was activated'],
    [task, [], 'paused', false, null],
  ];
  for (const [t, runs, stage, paused, expected] of cases) assert.equal(proofActivationRefusal(t, runs, stage, paused), expected);
});


test('external merge has the same refusal in proof preview and activation', () => {
  const task = { id: 't', version: 4, entrypoint: 'normal', phase: 'reviewing', prHead: 'head', prUrl: 'url',
    proofExecution: { selector: 'test', inputs: [] }, proofExecutions: [], held: false,
    resolution: { externalMerge: { status: 'observed' } } } as unknown as Task;
  assert.deepEqual(proofActivationPreview(task, [], []), { available: false, refusal: proofActivationRefusal(task, [], 'ordinary') });
  assert.equal(proofActivationRefusal(task, [], 'ordinary'), 'The task is merging or merged; author-side proof execution applies before merge only');
});

test('proof-only preview refuses once the allowance is spent on a settled receipt', () => {
  const commit = 'c'.repeat(40);
  const task = { id: 't', version: 4, entrypoint: 'proof', phase: 'blocked',
    proofOnly: { commit }, proofExecution: { selector: 'test', inputs: [] },
    proofExecutions: [{ runId: 'exec', head: commit, status: 'failed' }], proofOnlyResult: null,
    resolution: {} } as unknown as Task;
  const preview = proofActivationPreview(task, [], []);
  assert.equal(preview.available, false);
  assert.match((preview as { refusal: string }).refusal, /already spent its one execution/);
});
