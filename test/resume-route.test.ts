import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Run, Task } from '../shared/contracts';
import { resumeRoute } from '../core/recovery/retry-routes';

test('pre-PR resume routes stopped runs, refusals and retained worker', () => {
  const task = { id: 't', phase: 'needs_attention', agentId: 'a', workspaceId: 'w', profile: {}, runId: 'r',
    completion: null, prUrl: null, prHead: null, prerequisiteWait: null,
    resolution: { currentRunId: null, prePrResumeInstruction: null } } as unknown as Task;
  const stopped = { id: 'revision', role: 'revision', released: false } as Run;
  const cases: Array<[Task, Run[], string, Run | null, boolean, unknown]> = [
    [task, [], ' continue ', null, false, { kind: 'resume', action: 'continue' }],
    [task, [], ' ', null, false, { kind: 'refuse', message: 'Worker resume requires an explicit instruction' }],
    [{ ...task, phase: 'working' }, [], 'go', stopped, true, { kind: 'stopped', run: stopped }],
    [{ ...task, phase: 'working' }, [], 'go', stopped, false, { kind: 'refuse', message: 'Pre-PR worker resume requires a blocked result or stopped pre-callback worker' }],
    [{ ...task, prHead: 'head' }, [], 'go', null, false, { kind: 'refuse', message: 'Pre-PR worker resume requires a retained worker and no task PR' }],
    [task, [stopped], 'go', null, false, { kind: 'refuse', message: 'Resolve the retained thread or uncertain delivery first; no prompt will be resent blindly' }],
  ];
  for (const [t, runs, instruction, run, alive, expected] of cases) assert.deepEqual(resumeRoute(t, runs, instruction, false, run, alive), expected);
});


test('map bug 12: resume refusal does not depend on the non-delivery flag', () => {
  // The outer restart can clear this flag before admission; the route still refuses.
  const base = { phase: 'blocked', completion: { status: 'blocked', runId: 'r' }, runId: 'r', agentId: 'a',
    workspaceId: 'w', profile: {}, prHead: 'head', prUrl: 'url', resolution: { currentRunId: null } } as unknown as Task;
  for (const pending of [true, false]) {
    const task = { ...base, resolution: { ...base.resolution, nonDeliveryRoutePending: pending } };
    assert.deepEqual(resumeRoute(task, [], 'continue', true, null, false), { kind: 'refuse',
      message: 'Pre-PR worker resume requires a retained worker and no task PR; use restart to resume the blocked or errored task with its retained PR after resolving the blocker' });
    assert.equal(task.resolution.nonDeliveryRoutePending, pending);
  }
});

test('a pre-PR worker whose error ended on its revision run still resumes', () => {
  // nucleus#820: a provider 429 reported error on the retained revision run, so the
  // task row carries no completion and the phase is the parked error.
  const task = { id: 't', phase: 'error', agentId: 'a', workspaceId: 'w', profile: {}, runId: 'worker-run',
    completion: null, prUrl: null, prHead: null, prerequisiteWait: null,
    resolution: { currentRunId: null, prePrResumeInstruction: null } } as unknown as Task;
  const ended = { id: 'revision', role: 'revision', agentId: 'a', workspaceId: 'w', released: true,
    completion: { status: 'error', runId: 'revision' } } as unknown as Run;
  assert.deepEqual(resumeRoute(task, [ended], 'after the rate limit', true, null, false),
    { kind: 'resume', action: 'after the rate limit' });
  // Another workspace's ended run is not this worker's own ended turn.
  const foreign = { ...ended, workspaceId: 'other', agentId: 'other-agent' } as Run;
  assert.deepEqual(resumeRoute(task, [foreign], 'after the rate limit', true, null, false),
    { kind: 'refuse', message: 'Pre-PR worker resume requires a blocked result or stopped pre-callback worker' });
  // Same rules at the blocked phase, and a still-busy run is never resumed.
  assert.deepEqual(resumeRoute({ ...task, phase: 'blocked' }, [ended], 'go', true, null, false),
    { kind: 'resume', action: 'go' });
  const busy = { ...ended, released: false, completion: null } as Run;
  assert.deepEqual(resumeRoute(task, [busy], 'go', true, null, false),
    { kind: 'refuse', message: 'Pre-PR worker resume requires a blocked result or stopped pre-callback worker' });
});
