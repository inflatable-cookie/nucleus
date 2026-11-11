import { profile } from './support/fakes';
/**
 * Override liveness for the daemon split (lane `nucleus-simplify`, split map row T4).
 *
 * Tests replace methods on the `Engine` and `Resolution` instances. A move that
 * calls the new owner directly leaves such a replacement dead, and a test built
 * on it then passes while exercising nothing. Each row replaces one method on
 * its instance, drives a production path that reaches it, and asserts the
 * replacement ran. A move that bypasses the instance fails its row; rule 2 of
 * the split map is the fix (keep a same-name delegate, call through it).
 *
 * Current behaviour is the spec. Each row is one production call path, so a
 * failure names which caller went dead. Where a later caller would reach the same
 * method and hide a dead one, the row stubs that later step out.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import { Lifecycle } from '../core/closeout/workspace-lifecycle';
import { runSchema, submissionSchema, taskControlInputSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { CAPACITY_WAIT_PREFIX } from '../shared/wait-state';
import { stepEngine } from './support/engine-step';
import { holdLifecycleFollowUps } from './support/hold-lifecycle-follow-ups';

type Loose = any;
const head = 'a'.repeat(40), base = 'b'.repeat(40), merged = 'c'.repeat(40);
const longAgo = new Date(Date.now() - 3_600_000).toISOString();


function fixture(t: TestContext, adapterFields: Loose = {}) {
  const store = new Store(':memory:');
  const adapter: Loose = {
    supportsCoordinatorRecovery: true,
    profiles: async () => [],
    observe: async (id: string): Promise<AgentObservation> => ({ id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' } as AgentObservation),
    workspaceAvailable: async () => true,
    findRunAgents: async () => [],
    notify: async () => {},
    sendRun: async () => {},
    createRun: async () => { throw new Error('No agent turn expected'); },
    ...adapterFields,
  };
  const engine = new Engine(store, adapter as Adapter, 60_000);
  engine.profiles = [profile('worker')];
  store.setMeta('paused', false);
  t.after(async () => { await engine.stop(); store.close(); });
  const add = (fields: Loose = {}): Task => {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Liveness', repoPath: '/fixture',
      planningCommit: base, handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', base);
    return Object.keys(fields).length ? store.update(task.id, fields) : task;
  };
  const patchResolution = (task: Task, fields: Loose) => store.update(task.id, { resolution: { ...store.task(task.id).resolution, ...fields } });
  const putRun = (taskId: string, fields: Loose = {}): Run => {
    const run = runSchema.parse({ id: randomUUID(), taskId, role: 'reviewer', generation: 1, head, base, agentId: 'agent', workspaceId: 'ws',
      profile: null, profileGroup: 'group', status: 'running', createdAt: longAgo, lastObservedAt: null, active: false,
      idleSince: longAgo, completion: null, released: false, ...fields });
    store.putRun(run);
    return run;
  };
  const control = (task: Task, fields: Loose) => engine.performTaskControl(taskControlInputSchema.parse({ taskId: task.id, version: store.task(task.id).version, caller: 'operator (board)', reason: 'Liveness', ...fields }));
  return { store, engine, adapter, add, patchResolution, putRun, control, resolution: engine.resolution as Loose, internals: engine as Loose };
}
type Fixture = ReturnType<typeof fixture>;
const OWNERS = { engine: (f: Fixture) => f.internals, resolution: (f: Fixture) => f.resolution } as const;

/**
 * Replace `method`, drive, assert the replacement ran. The replaced name must
 * already be callable: assigning to a name the instance no longer has would be
 * dead from the start.
 */
function liveness(owner: keyof typeof OWNERS, method: string, path: string, drive: (f: Fixture) => unknown,
  options: { standIn?: (f: Fixture) => (...args: Loose[]) => unknown; adapter?: Loose; before?: (f: Fixture) => void } = {}) {
  test(`${owner}.${method} stays live through ${path}`, async t => {
    const f = fixture(t, options.adapter);
    const target = OWNERS[owner](f);
    assert.equal(typeof target[method], 'function', `${owner}.${method} no longer exists to replace`);
    options.before?.(f);
    const standIn = options.standIn?.(f);
    let calls = 0;
    let reached!: () => void;
    const seen = new Promise<void>(resolve => { reached = resolve; });
    target[method] = (...args: Loose[]) => { calls++; reached(); return standIn?.(...args); };
    // A stand-in can make the caller refuse afterwards; only reaching it counts.
    let refused: unknown = null;
    try { await drive(f); } catch (error) { refused = error; }
    // Some callers are fire-and-forget behind a lane or a timer; give them a bounded moment.
    if (!calls) await Promise.race([seen, new Promise(resolve => setTimeout(resolve, 200))]);
    assert.ok(calls > 0, `${path} no longer reaches the instance's ${owner}.${method}${refused ? ` (the drive threw: ${refused})` : ''}`);
  });
}
const constant = (value: unknown) => () => () => value;
const asyncly = (value: unknown) => () => async () => value;

// ---------------------------------------------------------------------------
// The brief's named seven: stepEngine first
// ---------------------------------------------------------------------------

/** A task that makes mechanical progress on every advance, so each quantum earns a follow-up. */
function progressing(f: Fixture) {
  const task = f.add({ phase: 'verifying' });
  let advances = 0;
  f.resolution.advance = async (current: Task) => {
    if (++advances > 3) return;
    f.store.update(current.id, { phase: current.phase === 'verifying' ? 'merging' : 'verifying' });
  };
  return { task, advances: () => advances };
}

test('stepEngine drops the lifecycle follow-up its one wake schedules, then restores the method', async t => {
  const f = fixture(t);
  const { advances } = progressing(f);
  await stepEngine(f.engine);
  assert.equal(advances(), 1, 'scheduleLifecycleFollowUp no longer reaches the stand-in stepEngine installs');
  assert.equal(Object.hasOwn(f.engine, 'scheduleLifecycleFollowUp'), false, 'stepEngine removes its stand-in');
});

test('the same wake without stepEngine does take the follow-up, so the pin above can fail', async t => {
  const f = fixture(t);
  const { advances } = progressing(f);
  await f.engine.wake();
  assert.ok(advances() > 1, 'a progressing task takes a lifecycle follow-up within one wake');
});

test('holdLifecycleFollowUps holds the follow-up until released', async t => {
  const f = fixture(t);
  const { advances } = progressing(f);
  const release = holdLifecycleFollowUps(f.engine);
  await f.engine.wake();
  assert.equal(advances(), 1, 'scheduleLifecycleFollowUp no longer reaches the held stand-in');
  release();
  await f.engine.quiesce();
  assert.ok(advances() > 1, 'release queues the held follow-up');
});

const workerIdle = { phase: 'working', agentId: 'agent', workspaceId: 'ws', runId: 'worker-run', idleSince: longAgo };
const ready = (taskId: string) => ({ taskId, runId: 'worker-run', eventId: randomUUID(), status: 'ready_for_review', summary: 'Ready', prNumber: 7 });

liveness('resolution', 'advance', 'a task wake', f => f.engine.wakeTask(f.add({ phase: 'verifying' }).id));
liveness('resolution', 'advance', 'a sweep', f => { f.add({ phase: 'verifying' }); return f.engine.sweepOnce(); });
liveness('resolution', 'advance', 'the missing-workspace reconciliation of a ready task', f => {
  const task = f.add({ phase: 'needs_attention', workspaceId: 'ws' });
  return f.engine.wakeTask(f.store.update(task.id, { completion: ready(task.id) as Loose }).id);
}, { adapter: { workspaceAvailable: async () => false } });

liveness('resolution', 'heavyRunAlive', 'worker reconciliation', f => {
  f.resolution.remindStoppedWorker = async () => {};
  return f.internals.reconcile(f.add(workerIdle));
}, { standIn: asyncly(true) });
liveness('resolution', 'heavyRunAlive', 'observing a retained reviewer', f => {
  const task = f.add({ phase: 'reviewing' });
  f.patchResolution(task, { currentRunId: f.putRun(task.id).id });
  f.resolution.retainedProfileIssue = () => null;
  f.resolution.recoverRefusedReviewer = async () => false;
  f.resolution.remindStoppedRun = async () => {};
  return f.resolution.observe();
}, { standIn: asyncly(true) });
liveness('resolution', 'heavyRunAlive', 'a stopped-run reminder', f => {
  const task = f.add({ phase: 'reviewing' });
  return f.resolution.remindStoppedRun(task, f.putRun(task.id));
}, { standIn: asyncly(true) });
liveness('resolution', 'heavyRunAlive', 'a stopped-worker reminder', f => f.resolution.remindStoppedWorker(f.add(workerIdle)), { standIn: asyncly(true) });

const WAIT = 'Waiting for capacity';
liveness('resolution', 'slotAdmissionReason', 'queued dispatch', f => f.internals.dispatchTask(f.add().id, false), { standIn: constant(WAIT) });
liveness('resolution', 'slotAdmissionReason', 'waking a capacity waiter', f => {
  f.internals.dispatchTask = async () => {};
  f.add();
  f.internals.wakeCapacityWaiter('released');
}, { standIn: constant(WAIT) });
liveness('resolution', 'slotAdmissionReason', 'a revision advance', f => {
  f.resolution.launch = async () => {};
  return f.resolution.advance(f.add({ ...workerIdle, phase: 'changes_requested' }));
}, { standIn: constant(WAIT) });
liveness('resolution', 'slotAdmissionReason', 'launching a revision', f => {
  f.resolution.lease = async () => true;
  return f.resolution.launch(f.add({ ...workerIdle, phase: 'changes_requested' }), 'revision');
}, { standIn: constant(WAIT) });

/** A task at the recovery route's admission check. */
const routable = (f: Fixture) => {
  const task = f.add({ phase: 'needs_attention', reason: 'Inspect', workspaceId: 'ws' });
  return f.patchResolution(task, { attention: true });
};
liveness('resolution', 'slotAdmissionReason', 'the recovery route', f => f.resolution.recovery.route(routable(f)), { standIn: constant(WAIT) });

liveness('resolution', 'lease', 'the recovery route', f => f.resolution.recovery.route(routable(f)), { standIn: asyncly(false) });
liveness('resolution', 'lease', 'a finished review run', f => {
  const task = f.add({ phase: 'reviewing', prHead: head });
  const runId = randomUUID();
  f.putRun(task.id, { id: runId, released: true, status: 'finished', completion: { taskId: task.id, runId, eventId: randomUUID(), status: 'changes_required', summary: 'Fix', head } });
  return f.resolution.advance(f.patchResolution(task, { currentRunId: runId }));
}, { standIn: asyncly(false) });
liveness('resolution', 'lease', 'launching a revision', f => {
  f.resolution.slotAdmissionReason = () => null;
  return f.resolution.advance(f.add({ ...workerIdle, phase: 'changes_requested' }));
}, { standIn: asyncly(false) });
const closing = (f: Fixture) => f.patchResolution(f.add({ phase: 'closing', workspaceId: 'ws' }), { mergedCommit: merged, syncedCommit: merged });
liveness('resolution', 'lease', 'closeout workspace recovery', f => {
  f.resolution.closeoutAuthority = async () => 'agent';
  return new Lifecycle(f.engine).recover(closing(f));
}, { standIn: asyncly(false), adapter: { workspaceAvailable: async () => false } });

liveness('resolution', 'closeoutAuthority', 'closeout workspace recovery', f => new Lifecycle(f.engine).recover(closing(f)), { standIn: asyncly('queue') });
liveness('resolution', 'closeoutAuthority', 'a closing advance', f => f.resolution.advance(closing(f)), { standIn: asyncly('none'), before: f => { f.resolution.launch = async () => {}; } });

liveness('resolution', 'deliverNotices', 'a sweep', f => f.engine.sweepOnce());
liveness('resolution', 'deliverNotices', 'a drain', f => f.engine.wake());

// ---------------------------------------------------------------------------
// The rest of rule 2's list
// ---------------------------------------------------------------------------

const firstArg = () => (task: Task) => task;
const asyncFirstArg = () => async (task: Task) => task;
/** A dispatched task with a retained author and a PR, the shape owner verbs act on. */
const dispatched = (f: Fixture) => {
  const task = f.add({ phase: 'reviewing', planningBase: base, workspaceIntent: true, agentIntent: true, workspaceId: 'ws', directory: '/worktree',
    agentId: 'agent', runId: 'worker-run', prHead: head, prUrl: 'https://github.com/example/repo/pull/7' });
  return f.store.update(task.id, { completion: ready(task.id) as Loose });
};
/** Replace `advance` so one quantum moves the task to `phase`. */
const advancesTo = (f: Fixture, phase: string) => { f.resolution.advance = async (current: Task) => { f.store.update(current.id, { phase } as Loose); }; };
const verifying = (f: Fixture) => f.add({ phase: 'verifying', workspaceId: 'ws' });
const released = (f: Fixture, task: Task) => { f.resolution.observe = async (_inventory: unknown, _completed: unknown, onReleased: (id: string) => void) => onReleased(task.id); };

liveness('resolution', 'retry', 'an owner move to work', f => f.control(dispatched(f), { action: 'move', to: 'work' }), { standIn: firstArg });

liveness('resolution', 'waiting', 'a revision advance over capacity', f => {
  f.resolution.slotAdmissionReason = () => WAIT;
  return f.resolution.advance(f.add({ ...workerIdle, phase: 'changes_requested' }));
});
liveness('resolution', 'waiting', 'the recovery route over capacity', f => {
  f.resolution.slotAdmissionReason = () => WAIT;
  return f.resolution.recovery.route(routable(f));
});

liveness('resolution', 'claimIntegrationTurn', 'a merging advance', f => f.resolution.advance(f.add({ phase: 'merging', prHead: head })), { standIn: constant(false) });
liveness('resolution', 'claimIntegrationTurn', 'launching a closeout', f => {
  f.resolution.closeoutAuthority = async () => 'none';
  return f.resolution.advance(closing(f));
}, { standIn: constant(false) });

liveness('resolution', 'holdsIntegrationTurn', 'a task quantum', f => {
  f.internals.taskQuantum = async () => {};
  return f.engine.wakeTask(verifying(f).id);
}, { standIn: constant(false) });
liveness('resolution', 'holdsIntegrationTurn', 'waking the integration successor', f => {
  f.internals.scheduleLifecycleFollowUp = () => true;
  f.patchResolution(verifying(f), { integrationTurn: { sequence: 1, acceptedAt: longAgo } });
  f.internals.wakeIntegrationSuccessor('/fixture');
}, { standIn: constant(false) });

liveness('resolution', 'integrationQuantum', 'a task quantum', f => f.engine.wakeTask(verifying(f).id), { standIn: () => async (_id: string, work: () => Promise<void>) => work() });

liveness('resolution', 'recoverExternalMerge', 'a task quantum', f => f.engine.wakeTask(f.add({ phase: 'working', agentId: 'agent', agentActive: true }).id), { standIn: asyncly(true) });

liveness('resolution', 'adoptReplacementPr', 'an owner move to review naming a PR', f => f.control(dispatched(f), { action: 'move', to: 'review', prNumber: 12 }), { standIn: asyncFirstArg });

liveness('resolution', 'worktreeValidationProbe', 'the heavy-run check', f => f.resolution.heavyRunAlive(f.add({ ...workerIdle, directory: '/worktree' })), { standIn: () => () => ({ state: 'absent' }) });

liveness('resolution', 'applyOperatorControl', 'the blocker ladder resuming a ready step', f => {
  const task = dispatched(f);
  const current = f.store.update(task.id, { phase: 'awaiting_review', responsible: true } as Loose);
  return f.resolution.responsibleBlockerLadder(current, { source: 'recovery', runId: 'recovery-run', completion: { taskId: task.id, runId: 'recovery-run', eventId: randomUUID(), status: 'blocked', summary: 'Stuck' } });
}, { standIn: asyncly(undefined) });

liveness('engine', 'scheduleLifecycleFollowUp', 'a quantum that made progress', f => { const task = verifying(f); advancesTo(f, 'merging'); return f.engine.wakeTask(task.id); }, { standIn: constant(true) });
liveness('engine', 'scheduleLifecycleFollowUp', 'a run released by observation', f => { released(f, verifying(f)); return f.engine.sweepOnce(); }, { standIn: constant(true) });
liveness('engine', 'scheduleLifecycleFollowUp', 'waking the integration successor', f => {
  f.resolution.holdsIntegrationTurn = () => true;
  f.patchResolution(verifying(f), { integrationTurn: { sequence: 1, acceptedAt: longAgo } });
  f.internals.wakeIntegrationSuccessor('/fixture');
}, { standIn: constant(true) });

const operation = (f: Fixture, task: Task) => {
  const control = { action: 'retry_effect', taskId: task.id, version: task.version, caller: 'operator (board)', reason: 'Liveness' };
  const payload = { type: 'task_control', control };
  return { key: `liveness-${randomUUID()}`, kind: 'task_control' as const, inputHash: operationInputHash(payload), taskId: task.id, expectedVersion: task.version, payload };
};
liveness('engine', 'scheduleOperation', 'accepting an operation', f => f.engine.startOperation(operation(f, verifying(f))));
liveness('engine', 'scheduleOperation', 'scheduling an accepted operation', f => f.engine.scheduleAcceptedOperation('operation'));
liveness('engine', 'scheduleOperation', 'resuming operations at restart', f => { f.store.acceptOperation(operation(f, verifying(f))); f.engine.resumeOperations(); });
liveness('engine', 'scheduleOperation', 'a Git-transient retry timer', f => {
  f.store.acceptOperation(operation(f, verifying(f)));
  f.internals.armGitTransient('operation', Date.now(), true);
});

liveness('engine', 'wakeCapacityWaiter', 'a quantum that freed its slot', f => {
  const task = f.add({ phase: 'working', agentId: 'agent', agentActive: true, workspaceId: 'ws' });
  f.internals.taskQuantum = async (id: string) => { f.store.update(id, { phase: 'done' }); };
  return f.engine.wakeTask(task.id);
});
liveness('engine', 'wakeCapacityWaiter', 'a run released by observation', f => { released(f, verifying(f)); f.internals.scheduleLifecycleFollowUp = () => true; return f.engine.sweepOnce(); });

liveness('engine', 'ensureSweep', 'a window sweep', f => f.engine.sweepOnce(), { standIn: () => async () => {} });
liveness('engine', 'ensureSweep', 'a wake', f => f.engine.wake(), { standIn: () => async () => {} });

liveness('engine', 'wakeTask', 'an owner release', f => f.control(dispatched(f), { action: 'hold', kind: 'dispatch' }), { standIn: () => async () => {} });
liveness('engine', 'wakeTask', 'a Git-transient retry timer', f => f.internals.armGitTransient(verifying(f).id, Date.now()), { standIn: () => async () => {} });
liveness('engine', 'wakeTask', 'waking a capacity waiter', f => {
  f.resolution.slotAdmissionReason = () => null;
  f.add({ phase: 'verifying', reason: CAPACITY_WAIT_PREFIX });
  f.internals.wakeCapacityWaiter('released');
}, { standIn: () => async () => {} });
liveness('engine', 'wakeRepository', 'an owner release', f => f.control(dispatched(f), { action: 'hold', kind: 'dispatch' }), { standIn: () => async () => {} });

liveness('engine', 'performTaskControl', 'the operator control the engine binds', f => f.resolution.applyOperatorControl({ taskId: 'task' }), { standIn: asyncly(undefined) });
liveness('engine', 'performTaskControl', 'a task control operation', async f => {
  const task = verifying(f);
  const control = { action: 'move', to: 'review', taskId: task.id, version: task.version, caller: 'operator (board)', reason: 'Liveness' };
  await f.engine.startOperation({ key: `liveness-${randomUUID()}`, kind: 'task_control', payload: { type: 'task_control', control } });
}, { standIn: () => async (input: { taskId: string }) => ({ id: input.taskId }) });

liveness('engine', 'moveToReview', 'an owner move to review', f => f.control(dispatched(f), { action: 'move', to: 'review' }), { standIn: f => async (input: { taskId: string }) => f.store.task(input.taskId) });

const covered = { fault: null, covered: true, visited: new Set() };
liveness('engine', 'auditPass', 'a window sweep', f => f.engine.sweepOnce(), { standIn: asyncly(covered) });
liveness('engine', 'auditPass', 'a drain', f => f.engine.wake(), { standIn: asyncly(covered) });

liveness('engine', 'launchAgent', 'a task quantum over a bound workspace', f => f.engine.wakeTask(f.add({ phase: 'dispatching', workspaceIntent: true, workspaceId: 'ws' }).id));

liveness('engine', 'dispatchTask', 'a repository wake', f => { f.add(); return f.engine.wakeRepository('/fixture'); }, { standIn: () => async () => {} });
liveness('engine', 'dispatchTask', 'waking a capacity waiter', f => {
  f.internals.dispatchQueued = async () => {};
  f.resolution.slotAdmissionReason = () => null;
  f.add();
  f.internals.wakeCapacityWaiter('released');
}, { standIn: () => async () => {} });
liveness('engine', 'dispatchTask', 'a Git-transient retry timer', f => {
  f.internals.dispatchQueued = async () => {};
  f.internals.armGitTransient(f.add().id, Date.now());
}, { standIn: () => async () => {} });

liveness('engine', 'drainTitles', 'enqueueing a title', f => f.internals.enqueueTitle(f.add().id), { standIn: () => async () => {} });
liveness('engine', 'drainTitles', 'the projection drain', f => f.internals.drainProjections({ cleanup: false }), { standIn: () => async () => {} });
liveness('engine', 'syncWorkspaceTitle', 'the title drain', f => f.internals.enqueueTitle(f.add().id), { standIn: () => async () => {} });

liveness('engine', 'enqueueCleanup', 'a quantum that reached done', f => { const task = verifying(f); advancesTo(f, 'done'); return f.engine.wakeTask(task.id); });
liveness('engine', 'enqueueCleanup', 'a passed retention reconciliation', f => f.internals.lifecycle.retentionReconciled(f.add().id, null));
