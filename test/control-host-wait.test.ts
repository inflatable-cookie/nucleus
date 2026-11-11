import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationInputHash, Store } from '../core/store/store';
import { holdPatch } from '../core/merge/merge-hold';
import { Engine } from '../core/engine';
import { taskControlOperation } from '../core/verbs/task-control-key';
import { dispositionSchema, submissionSchema, taskControlInputSchema, type TaskControlInput } from '../shared/contracts';
import type { QueueOperation } from '../shared/operations';
import type { Adapter } from '../core/host/adapter';

/**
 * nucleus#927: an owner control refuses on local facts before it waits for an
 * offline host. #912 put the host wait in one place — the durable operation lane
 * and `Engine.performTaskControl` — and a control entered it before its own
 * refusals had run, so a stale, displaced, terminal or superfluous control sat
 * "Waiting for host …" until the disconnected host returned and only refused
 * then. Each refusal below reads the store, so it refuses now and writes nothing;
 * a control that would be accepted still waits, unchanged.
 */

const base = 'a'.repeat(40);

function fixture(options: { missing?: Array<'merge' | 'merged'> } = {}) {
  const store = new Store(':memory:');
  store.setMeta('paused', false);
  // Every remote call is recorded and refused: an offline host is never reached.
  const remote: string[] = [];
  const adapter = new Proxy({}, { get: (_target, property) => property === 'then' || options.missing?.includes(property as 'merge' | 'merged') ? undefined
    : (..._args: unknown[]) => { remote.push(String(property)); throw new Error('Transport not connected: host offline is unavailable'); } }) as unknown as Adapter;
  const engine = new Engine(store, adapter, 0);
  engine.hostAvailable = () => false;
  store.setMeta('pool', [{ profileId: 'worker', enabled: true, group: 'workers', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Offline host control',
    repoPath: '/repo', planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'offline', 'handoff.md', base);
  return {
    store, engine, remote, task,
    taskId: task.id,
    close: async () => { await engine.stop(); store.close(); },
  };
}
type Fixture = ReturnType<typeof fixture>;

/** The stored row and event history a refusal must leave exactly as they were. */
const untouched = (f: Fixture, id = f.taskId) => ({ task: JSON.stringify(f.store.task(id)), events: f.store.eventsAll(id).length, runs: JSON.stringify(f.store.runs(id)) });

const control = (f: Fixture, input: Partial<TaskControlInput> & Pick<TaskControlInput, 'action'>): TaskControlInput =>
  taskControlInputSchema.parse({ taskId: f.taskId, version: f.store.task(f.taskId).version, ...input });

/** Accept one control through the durable lane, exactly as `queue.task` does. */
async function accept(f: Fixture, input: TaskControlInput): Promise<QueueOperation['id']> {
  const { key, payload } = taskControlOperation(input);
  const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: input.taskId, expectedVersion: input.version });
  assert.ok('accepted' in accepted, JSON.stringify(accepted));
  return (accepted as { accepted: true; operation: QueueOperation }).operation.id;
}

/** The lane's outcome for one accepted control, once it has stopped moving. */
async function settled(f: Fixture, id: string): Promise<QueueOperation> {
  const operation = await f.engine.awaitOperation(id, 5000);
  assert.ok(['failed', 'succeeded', 'needs_attention'].includes(operation.state), `the operation settled, not parked pending: ${operation.state} ${operation.diagnostic}`);
  return operation;
}

/** Wait for a parked operation to record the host wait it is in. */
async function waiting(f: Fixture, id: string): Promise<QueueOperation> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const operation = f.store.operation(id)!;
    if (operation.diagnostic) return operation;
    if (Date.now() >= deadline) return operation;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('a stale version refuses immediately with the host disconnected and writes nothing', async () => {
  const f = fixture();
  try {
    const stale = control(f, { action: 'move', to: 'work', reason: 'Send the worker on' });
    const advanced = f.store.update(f.taskId, { reason: 'The owner rewrote the instruction' });
    const before = untouched(f);
    const operation = await settled(f, await accept(f, stale));

    assert.equal(operation.state, 'failed');
    assert.match(operation.diagnostic, /Task changed; refresh before retrying \(the task is now version \d+; read next again and reassess before retrying\)/);
    assert.deepEqual(untouched(f), before);
    assert.equal(f.store.task(f.taskId).version, advanced.version);
    assert.deepEqual(f.remote, [], 'no host call was made for a control that never got past its own refusal');
  } finally { await f.close(); }
});

test('an active disposition refuses immediately with the host disconnected and writes nothing', async () => {
  const f = fixture();
  try {
    const requestedAt = new Date().toISOString();
    const fenced = f.store.update(f.taskId, { disposition: dispositionSchema.parse({ kind: 'cancel', status: 'intent',
      requestedAt, requestedBy: 'operator control', reason: 'Operator cancelled it', workDisposition: 'archive_if_empty', effects: [] }) });
    const before = untouched(f);
    for (const input of [
      control(f, { action: 'move', to: 'work', reason: 'Send the worker on' }),
      control(f, { action: 'move', to: 'review', reason: 'Review the PR' }),
      control(f, { action: 'restart', role: 'worker', reason: 'Restart the worker' }),
      control(f, { action: 'route', role: 'worker', profileId: 'worker', reason: 'Route the worker' }),
      control(f, { action: 'proof', reason: 'Run the proof' }),
      control(f, { action: 'complete', reason: 'Finish it' }),
    ]) {
      const operation = await settled(f, await accept(f, input));
      assert.equal(operation.state, 'failed', `${input.action} refuses under a disposition`);
      assert.match(operation.diagnostic, /A cancel or supersede disposition owns this task/);
      assert.deepEqual(untouched(f), before, `${input.action} wrote nothing`);
      assert.equal(f.store.task(f.taskId).disposition?.status, 'intent', 'the recorded disposition is untouched');
      assert.equal(f.store.task(f.taskId).version, fenced.version);
    }
    // A retry_effect is the one control a disposition still needs, so it waits.
    const retry = control(f, { action: 'retry_effect', effect: 'workspace_archive.workspace', reason: 'Retry the workspace step' });
    const parked = await waiting(f, await accept(f, retry));
    assert.equal(parked.state, 'pending');
    assert.match(parked.diagnostic, /Waiting for host offline/);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a terminal task refuses immediately with the host disconnected and writes nothing', async () => {
  const f = fixture();
  try {
    const done = f.store.update(f.taskId, { phase: 'done', reason: 'The owner finished it' });
    const before = untouched(f);
    for (const [input, refusal] of [
      [control(f, { action: 'move', to: 'review', reason: 'Review it' }), /^Move to review needs an unmerged task before merge intent$/],
      [control(f, { action: 'move', to: 'work', reason: 'Send it back' }), /^Move to work needs an unfinished, unmerged task; this task is done$/],
      [control(f, { action: 'complete', reason: 'Finish it' }), /The task is done; complete applies to an unfinished task/],
      [control(f, { action: 'proof', reason: 'Run the proof' }), /The task is done; proof execution is closed/],
      [control(f, { action: 'route', role: 'worker', profileId: 'worker', reason: 'Route it' }), /route requires an unfinished, unmerged task; this task is done/],
      [control(f, { action: 'withdraw_cancel', reason: 'Withdraw the cancellation' }), /Only an active cancellation can be withdrawn/],
    ] as const) {
      const operation = await settled(f, await accept(f, input));
      assert.equal(operation.state, 'failed', `${input.action} refuses on a finished task`);
      assert.match(operation.diagnostic, refusal);
      assert.deepEqual(untouched(f), before);
      assert.equal(f.store.task(f.taskId).phase, 'done');
      assert.equal(f.store.task(f.taskId).version, done.version);
    }
    // The one completion the task already recorded at the caller's version is
    // the verb's idempotent answer, never a terminal refusal.
    const finished = f.store.update(f.taskId, { reportAcceptance: { acceptedBy: 'operator (board)', reason: 'The report was accepted',
      acceptedAt: new Date().toISOString(), taskVersion: done.version, kind: 'owner_completed' } });
    const replay = await waiting(f, await accept(f, { ...control(f, { action: 'complete', reason: 'The report was accepted' }), version: done.version }));
    assert.equal(replay.state, 'pending', 'the idempotent completion waits rather than being refused as a terminal task');
    assert.match(replay.diagnostic, /Waiting for host offline/);
    assert.equal(f.store.task(f.taskId).version, finished.version);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a removed task refuses immediately with the host disconnected and writes nothing', async () => {
  const f = fixture();
  try {
    const removed = f.store.update(f.taskId, { removedAt: new Date().toISOString() });
    const before = untouched(f);
    for (const input of [
      control(f, { action: 'move', to: 'work', reason: 'Send the worker on' }),
      control(f, { action: 'cancel', reason: 'Cancel it' }),
      control(f, { action: 'retry_effect', effect: 'hook.1', reason: 'Retry the hook' }),
    ]) {
      const operation = await settled(f, await accept(f, input));
      assert.equal(operation.state, 'failed');
      assert.match(operation.diagnostic, /Task was removed from the queue/);
      assert.deepEqual(untouched(f), before);
      assert.equal(f.store.task(f.taskId).removedAt, removed.removedAt);
    }
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a valid control still waits for its recorded host and writes nothing', async () => {
  const f = fixture();
  try {
    const before = untouched(f);
    const parked = await waiting(f, await accept(f, control(f, { action: 'cancel', reason: 'Operator cancelled it' })));
    assert.equal(parked.state, 'pending', 'an accepted control enters the host wait');
    assert.equal(parked.hostId, 'offline');
    assert.match(parked.diagnostic, /Waiting for host offline/);
    assert.deepEqual(untouched(f), before);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a direct owner control refuses on local facts before it reports the wait', async () => {
  const f = fixture();
  try {
    const stale = control(f, { action: 'move', to: 'work', reason: 'Send the worker on' });
    f.store.update(f.taskId, { reason: 'The owner rewrote the instruction' });
    const before = untouched(f);
    await assert.rejects(f.engine.performTaskControl(stale), /Task changed; refresh before retrying/);
    assert.deepEqual(untouched(f), before);
    const valid = control(f, { action: 'cancel', reason: 'Operator cancelled it' });
    await assert.rejects(f.engine.performTaskControl(valid), /Transport not connected: waiting for host offline/);
    assert.deepEqual(untouched(f), before);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a durable removal refuses on local facts before it waits for its host', async () => {
  const f = fixture();
  try {
    const staleVersion = f.store.task(f.taskId).version;
    f.store.update(f.taskId, { reason: 'The owner rewrote the instruction' });
    const before = untouched(f);
    const stale = await settled(f, await acceptRemoval(f, staleVersion));
    assert.equal(stale.state, 'failed');
    assert.match(stale.diagnostic, /Task changed; refresh before retrying/);
    assert.deepEqual(untouched(f), before);

    // The task is running: removal waits for the task to stop, which needs no host.
    const running = f.store.update(f.taskId, { phase: 'working' });
    const stopped = await settled(f, await acceptRemoval(f, running.version));
    assert.equal(stopped.state, 'failed');
    assert.match(stopped.diagnostic, /Wait for the task to stop before removing it/);
    assert.equal(f.store.task(f.taskId).removedAt, null);

    // A removal that is valid so far keeps the #912 host wait.
    f.store.update(f.taskId, { phase: 'cancelled' });
    const parked = await waiting(f, await acceptRemoval(f, f.store.task(f.taskId).version));
    assert.equal(parked.state, 'pending');
    assert.match(parked.diagnostic, /Waiting for host offline/);
    assert.equal(f.store.task(f.taskId).removedAt, null);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

/** `queue.remove`'s durable operation, accepted exactly as the runtime does. */
async function acceptRemoval(f: Fixture, version: number): Promise<string> {
  const accepted = await f.engine.startOperation({ key: `task-remove:${f.taskId}:${version}`, kind: 'task_remove',
    payload: { type: 'task_remove', taskId: f.taskId, version }, taskId: f.taskId, expectedVersion: version });
  assert.ok('accepted' in accepted);
  return (accepted as { operation: QueueOperation }).operation.id;
}

test('a closeout that cannot reach its boundary refuses before the wait', async () => {
  const f = fixture();
  try {
    const qualification = 'I accept the merged head as this external source';
    const retained = { agentId: 'worker-agent', runId: 'worker-run', workspaceId: 'workspace-1', directory: '/repo/workspace',
      prUrl: 'https://github.com/example/repo/pull/41', prHead: 'd'.repeat(40) };
    const closeout = () => control(f, { action: 'move', to: 'closeout', reason: 'The PR merged outside Queue', qualification, caller: 'operator (board)' });
    // A queued or dispatching task has not reached the retained-participant
    // route, and it is not the never-dispatched review-entry boundary either.
    for (const phase of ['queued', 'dispatching'] as const) {
      f.store.update(f.taskId, { phase, ...retained });
      const before = untouched(f);
      const operation = await settled(f, await accept(f, closeout()));
      assert.equal(operation.state, 'failed', `a ${phase} task with retained fields is refused`);
      assert.match(operation.diagnostic, /outside that boundary/);
      assert.deepEqual(untouched(f), before);
    }
    // Past its first dispatch with the same retained facts it waits: the forge
    // and participant proofs it needs are the host's.
    f.store.update(f.taskId, { phase: 'reviewing', ...retained });
    const parked = await waiting(f, await accept(f, closeout()));
    assert.equal(parked.state, 'pending');
    assert.match(parked.diagnostic, /Waiting for host offline/);
    assert.deepEqual(f.remote, []);
  } finally { await f.close(); }
});

test('a forced control refuses on local facts before the wait, and a valid one still waits', async () => {
  const f = fixture();
  try {
    const refused = async (input: TaskControlInput, refusal: RegExp) => {
      const before = untouched(f);
      const operation = await settled(f, await accept(f, input));
      assert.equal(operation.state, 'failed', `${input.action} force=${String(input.force)} refuses`);
      assert.match(operation.diagnostic, refusal);
      assert.deepEqual(untouched(f), before, 'a refused force writes nothing');
    };
    // The caller gate is the dispatcher's own force refusal.
    await refused(control(f, { action: 'move', to: 'work', reason: 'Force the move', force: true, caller: 'unrelated-thread' }),
      /Force requires the task project planner, Nucleus planner, operator, or this task authenticated worker, reviewer or recovery run/);
    // A forced settle names a recorded effect, and never discards a verdict.
    await refused(control(f, { action: 'retry_effect', effect: 'review_publication.review-1', reason: 'Publish it', force: true, caller: 'operator (board)' }),
      /Force cannot discard an accepted review verdict/);
    await refused(control(f, { action: 'retry_effect', effect: 'hook.absent', reason: 'Settle it', force: true, caller: 'operator (board)' }),
      /No recorded blocking effect hook\.absent; read next for current effects/);

    // A forced move keeps the version, removal and merged-PR refusals.
    const stale = control(f, { action: 'move', to: 'work', reason: 'Force the move', force: true, caller: 'operator (board)' });
    f.store.update(f.taskId, { reason: 'The owner rewrote the instruction' });
    await refused(stale, /Task changed; refresh before retrying \(the task is now version \d+; read next again and reassess before retrying\)/);
    const merged = f.store.update(f.taskId, { resolution: { ...f.store.task(f.taskId).resolution, mergedCommit: 'c'.repeat(40) } });
    await refused(control(f, { action: 'move', to: 'merge', reason: 'Force the merge', force: true, caller: 'operator (board)' }),
      /The PR is already recorded as merged; use move to closeout with force and a reason/);

    // A self-force carries the authenticated run scope: an unauthorized one has
    // no way to clear a planner or operator hold.
    const runId = 'self-force-run';
    f.store.update(f.taskId, { runId, resolution: { ...merged.resolution, mergedCommit: null } });
    f.store.update(f.taskId, holdPatch(f.store.task(f.taskId), 'dispatch', 'project planner', 'Wait for the planner'));
    await assert.rejects(f.engine.selfForceRunId.run(runId, () => f.engine.performTaskControl(taskControlInputSchema.parse({
      taskId: f.taskId, version: f.store.task(f.taskId).version, action: 'move', to: 'work', reason: 'Force my own move',
      force: true, caller: `run:${runId}` }))), /Task self-force cannot clear a planner\/operator hold or disposition; ask for the ruling/);
    f.store.update(f.taskId, holdPatch(f.store.task(f.taskId), 'dispatch', 'project planner', 'Wait for the planner', null));
    f.store.update(f.taskId, { holds: {} });

    // The same self-force, delivered through the durable lane, is proved against
    // its recorded grant and then waits: nothing local refuses it.
    const control_ = control(f, { action: 'move', to: 'work', reason: 'Force my own move', force: true, caller: `run:${runId}` });
    const payload = { type: 'task_control' as const, control: control_, authenticatedForceRunId: runId };
    const missing = await settled(f, await startLane(f, 'self-force-without-grant', { ...payload, authenticatedForceRunId: 'f'.repeat(64) }));
    assert.equal(missing.state, 'failed');
    assert.match(missing.diagnostic, /Missing authenticated force grant/);
    f.store.setMeta(`selfForceGrant:${operationInputHash(payload)}`, runId);
    const parked = await waiting(f, await startLane(f, 'self-force-with-grant', payload));
    assert.equal(parked.state, 'pending');
    assert.match(parked.diagnostic, /Waiting for host offline/);

    // The two adapter gates are presence checks the engine already holds: a
    // resolution adapter that cannot guard a merge or observe one refuses now.
    const noGuard = fixture({ missing: ['merge'] });
    try {
      const refused = await settled(noGuard, await accept(noGuard, control(noGuard, { action: 'move', to: 'merge',
        reason: 'Force the merge', force: true, caller: 'operator (board)' })));
      assert.equal(refused.state, 'failed');
      assert.match(refused.diagnostic, /GitHub guarded merge is unavailable; read next and retry when it is available/);
      assert.deepEqual(noGuard.remote, []);
    } finally { await noGuard.close(); }
    const noObservation = fixture({ missing: ['merged'] });
    try {
      const refused = await settled(noObservation, await accept(noObservation, control(noObservation, { action: 'move', to: 'closeout',
        reason: 'Force the closeout', force: true, caller: 'operator (board)' })));
      assert.equal(refused.state, 'failed');
      assert.match(refused.diagnostic, /GitHub merge observation is unavailable; read next and retry when it is available/);
      assert.deepEqual(noObservation.remote, []);
    } finally { await noObservation.close(); }

    // An authorized operator force with nothing local against it keeps the wait.
    const before = untouched(f);
    const operatorForce = await waiting(f, await accept(f, control(f, { action: 'move', to: 'work', reason: 'Force the move', force: true, caller: 'operator (board)' })));
    assert.equal(operatorForce.state, 'pending');
    assert.match(operatorForce.diagnostic, /Waiting for host offline/);
    assert.deepEqual(untouched(f), before);
  } finally { await f.close(); }
});

/** Accept one raw lane payload, for the self-force shape the runtime builds itself. */
async function startLane(f: Fixture, key: string, payload: { type: 'task_control'; control: TaskControlInput; authenticatedForceRunId: string }): Promise<string> {
  const accepted = await f.engine.startOperation({ key, kind: 'task_control', payload, taskId: payload.control.taskId, expectedVersion: payload.control.version });
  assert.ok('accepted' in accepted);
  return (accepted as { operation: QueueOperation }).operation.id;
}
