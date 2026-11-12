import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundQuantum, TASK_QUANTUM_BOUND_MS } from '../core/scheduling/quantum-bound';
import { isTransportFailure } from '../shared/transport';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import type { Adapter } from '../core/host';
import { submission } from './support/fakes';
import { storedT3Labels } from './support/t3code-labels';
import { finishedThreadCleanupKey } from '../core/workspaces/thread-archive';

// A quantum that never returns (a lane held by one stuck task) must not hold the
// sweep window: the window settles at the bound and names the outage once.
test('a hung task quantum settles at its bound and reports one outage', async () => {
  const hung = new Promise<void>(() => {});
  let outages = 0;
  const started = Date.now();
  await boundQuantum(hung, () => { outages++; }, 25);
  assert.equal(outages, 1);
  assert.ok(Date.now() - started < 1000, 'the window must not wait for the hung quantum');
});

test('a window with one hung quantum still completes the others', async () => {
  const hung = new Promise<void>(() => {});
  const fast = Promise.resolve();
  const reported: string[] = [];
  const window = [
    boundQuantum(hung, () => reported.push('hung'), 25),
    boundQuantum(fast, () => reported.push('fast'), 25),
  ];
  await Promise.all(window);
  assert.deepEqual(reported, ['hung']);
});

test('a quantum that returns in time reports nothing, and its own failure never reaches the sweep', async () => {
  let outages = 0;
  await boundQuantum(Promise.resolve(), () => { outages++; }, 25);
  await boundQuantum(Promise.reject(new Error('quantum fault')), () => { outages++; }, 25);
  assert.equal(outages, 0);
});

test('the production bound is two minutes', () => {
  assert.equal(TASK_QUANTUM_BOUND_MS, 120_000);
});

test('T3 transport and timeout errors classify as transport failures, never attention', () => {
  assert.equal(isTransportFailure(new Error('T3Code transport: orchestration.subscribeThread')), true);
  assert.equal(isTransportFailure(new Error('T3Code timeout: orchestration.subscribeShell')), true);
  assert.equal(isTransportFailure(new Error('T3CompatibilityError: authenticated host connection is unavailable')), true);
  assert.equal(isTransportFailure(new Error('T3Code protocol: orchestration.subscribeThread')), false);
});

// The #1148 wedge through the real engine lanes: a task whose lane is held by a
// call that never returns keeps its quantum queued forever. A window that waits
// on that quantum unbounded never reaches the next task.
function laneFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-quantum-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const engine = new Engine(store, {} as Adapter, 0);
  return { engine, close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a task whose lane never returns does not hold the window: the next task still runs and the stuck one is an outage', async () => {
  const f = laneFixture();
  try {
    let releaseStuck!: () => void;
    void f.engine.scheduleLane('task:stuck', 1, () => new Promise<void>(r => { releaseStuck = r; }));
    const quantum = f.engine.scheduleTaskQuantum('stuck');
    let fastRan = false;
    const outages: string[] = [];
    // The window's shape: one bounded wait per quantum, all awaited together.
    await Promise.all([
      boundQuantum(quantum, () => outages.push('stuck'), 25),
      boundQuantum(f.engine.scheduleLane('task:fast', 1, () => { fastRan = true; }), () => outages.push('fast'), 25),
    ]);
    assert.equal(fastRan, true, 'the fast task must run while the stuck lane is held');
    assert.deepEqual(outages, ['stuck'], 'only the stuck task is an outage');
    releaseStuck();
  } finally { await f.close(); }
});

// Keep the real Sweep, per-task lanes, finished-task query and cleanup effects;
// unrelated audit preludes are quiet so this fixture isolates catch-up scheduling.
function catchUpSweepFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-catch-up-sweep-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const hosts = ['t3code:a', 't3code:b'];
  store.setMeta('paused', false);
  store.setMeta('hostId', hosts[0]);
  store.setMeta('hostRegistry', hosts.map(id => ({ id, endpoint: 'synthetic' })));
  for (const key of ['lastRetentionAt', 'lastLaneIdleAt', 'lastLaneDrainAt']) store.setMeta(key, Date.now());
  const agents = new Map<string, { taskId: string; hostId: string; owned: boolean }>();
  const deleted = new Set<string>(), calls: string[] = [], observations: string[] = [], settlements: string[] = [];
  let hungAgent: string | null = null, releaseHung!: () => void;
  const hung = new Promise<void>(resolve => { releaseHung = resolve; });
  const adapters = new Map(hosts.map(hostId => [hostId, {
    settleReportedThread: async (id: string) => {
      settlements.push(id);
      if (deleted.has(id)) throw new Error('deleted thread projection is unavailable');
    },
    observe: async (id: string) => {
      observations.push(id);
      const agent = agents.get(id)!;
      assert.equal(agent.hostId, hostId, 'cleanup uses the participant own host');
      return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '',
        labels: agent.owned ? storedT3Labels('recovery', { taskId: agent.taskId, runId: id }) : {} };
    },
    originAgent: async (id: string) => deleted.has(id) ? null : { id, workspaceId: 'ws', title: '', archived: false },
    archiveAgent: async () => assert.fail('support cleanup must delete rather than archive'),
    deleteAgent: async (id: string) => {
      calls.push(id);
      if (id === hungAgent) await hung;
      deleted.add(id);
    },
  } as unknown as Adapter]));
  const engine = new Engine(store, adapters.get(hosts[0])!, 0);
  engine.resolveHostAdapter = id => adapters.get(id);
  engine.hostIds = () => hosts;
  engine.lastHookCleanupAt = Date.now();
  engine.migrateProjectOwnersToPlanners = async () => {};
  engine.retiredObservationPlan = () => ({ due: [], keep: {}, persisted: {} });
  engine.observeRetiredWorkers = async () => ({ changed: false, observations: {} });
  engine.clearRetiredInvalidations = () => {};
  engine.resumePausedStops = async () => {};
  engine.recoverExhaustedWorkers = async () => {};
  engine.archiveRetiredErroredAgents = async () => {};
  engine.applyDeferredOwnerVerbs = async () => {};
  engine.continueAwaitingReviewers = async () => {};
  engine.dispatchQueued = async () => {};
  engine.lifecycle.enqueuePass = async () => {};
  engine.resolution.origins.pass = async () => {};
  engine.resolution.observationTargets = () => [];
  engine.resolution.observe = async () => {};
  for (const method of ['deliverNotices', 'deliverQueuedMessages', 'resumeAskQuestions', 'raiseOperatorQuestions',
    'delegateNativeQuestions', 'resumeResponsibleAnsweredQuestions', 'deliverHoldNotices', 'deliverDecisionNotices', 'deliverDrainNotices'] as const)
    Object.assign(engine.resolution, { [method]: async () => {} });
  const add = (hostId = hosts[0], owned = true) => {
    const initial = store.insert(submission(), hostId, 'synthetic handoff', 'b'.repeat(40));
    const task = store.update(initial.id, { phase: 'done', workspaceId: 'ws',
      resolution: { ...initial.resolution, mergedCommit: 'c'.repeat(40) } });
    const agentId = `support-${task.id}`;
    agents.set(agentId, { taskId: task.id, hostId, owned });
    store.putRun({ id: agentId, taskId: task.id, hostId, role: 'recovery', generation: 0,
      head: 'b'.repeat(40), base: 'b'.repeat(40), workspaceId: 'ws', agentId, profile: null,
      status: 'finished', createdAt: new Date().toISOString(), lastObservedAt: null,
      active: false, idleSince: null, released: true, completion: null });
    return { task, agentId };
  };
  return { store, engine, hosts, agents, deleted, calls, observations, settlements, add,
    hold: (agentId: string) => { hungAgent = agentId; }, releaseHung,
    close: async () => { releaseHung(); await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const eventLoopTurn = () => new Promise<void>(resolve => setImmediate(resolve));
async function untilSweep(predicate: () => boolean, label: string) {
  for (let turn = 0; turn < 100 && !predicate(); turn++) await eventLoopTurn();
  assert.ok(predicate(), label);
}

test('real catch-up sweep bounds a hung cleanup, advances both hosts and serializes later same-task cleanup', async t => {
  const f = catchUpSweepFixture();
  const stuck = f.add(), healthy = f.add(), otherHost = f.add(f.hosts[1]);
  f.hold(stuck.agentId);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const passes: Promise<unknown>[] = [];
  try {
    const first = f.engine.auditPass(false); passes.push(first);
    await untilSweep(() => f.calls.includes(stuck.agentId) && f.deleted.has(healthy.agentId) && f.deleted.has(otherHost.agentId),
      'a hung delete does not prevent a healthy task or another host from cleaning up');
    t.mock.timers.tick(TASK_QUANTUM_BOUND_MS);
    assert.equal((await first).fault, null);
    assert.equal(f.store.eventsAll(stuck.task.id).filter(event => event.kind === 'observation_outage').length, 1);

    const second = f.engine.auditPass(false); passes.push(second);
    for (let turn = 0; turn < 30; turn++) await eventLoopTurn();
    assert.equal(f.calls.filter(id => id === stuck.agentId).length, 1,
      'the next sweep queues behind the same task lane instead of starting another delete');
    t.mock.timers.tick(TASK_QUANTUM_BOUND_MS);
    assert.equal((await second).fault, null);
    f.releaseHung();
    await f.engine.quiesce();
    assert.equal(f.calls.filter(id => id === stuck.agentId).length, 1, 'the queued pass reads the completed effect');
    assert.ok(f.store.getMeta(finishedThreadCleanupKey(stuck.task.id)));
  } finally {
    f.releaseHung();
    t.mock.timers.tick(TASK_QUANTUM_BOUND_MS);
    await Promise.all(passes);
    t.mock.timers.reset();
    await f.close();
  }
});

test('real catch-up sweep rotates past 25 permanently pending tasks to a later candidate', async () => {
  const f = catchUpSweepFixture();
  try {
    const tasks = Array.from({ length: 30 }, () => f.add(f.hosts[0], false))
      .sort((a, b) => a.task.id.localeCompare(b.task.id));
    const last = tasks.at(-1)!;
    f.agents.get(last.agentId)!.owned = true;
    assert.equal((await f.engine.auditPass(false)).fault, null);
    assert.equal(f.engine.sweepStats.swept, 25, 'a safety pass visits one bounded window');
    assert.equal(f.calls.includes(last.agentId), false, 'the later candidate is outside the first window');
    assert.equal((await f.engine.auditPass(false)).fault, null);
    assert.deepEqual(f.calls, [last.agentId], 'the next window reaches the later owned thread');
    assert.ok(f.store.getMeta(finishedThreadCleanupKey(last.task.id)));
    assert.equal(f.engine.sweepStats.swept, 30);
    assert.equal(f.store.getMeta(finishedThreadCleanupKey(tasks[0].task.id)), undefined,
      'the earliest unowned candidate remains pending without starving later work');
  } finally { await f.close(); }
});


test('real sweeps skip confirmed cleanup while unresolved threads and other tasks still progress', async () => {
  const f = catchUpSweepFixture();
  try {
    const finished = f.add(), unresolved = f.add(f.hosts[0], false);
    assert.equal((await f.engine.auditPass(false)).fault, null);
    assert.ok(f.deleted.has(finished.agentId));
    const history = f.store.eventsAll(finished.task.id);
    const settledBefore = f.settlements.filter(id => id === finished.agentId).length;
    const unresolvedBefore = f.settlements.filter(id => id === unresolved.agentId).length;
    // A partial task cleanup has no completion marker yet; its already confirmed
    // threads still need no further projection reads while other threads retry.
    f.store.setMeta(finishedThreadCleanupKey(finished.task.id), null);
    const other = f.add(f.hosts[1]);
    for (let pass = 0; pass < 3; pass++) assert.equal((await f.engine.auditPass(false)).fault, null);
    assert.equal(f.settlements.filter(id => id === finished.agentId).length, settledBefore);
    assert.deepEqual(f.store.eventsAll(finished.task.id), history, 'confirmed deletion adds no repeated warning');
    assert.ok(f.settlements.filter(id => id === unresolved.agentId).length > unresolvedBefore, 'unresolved threads keep retrying settlement');
    assert.ok(f.deleted.has(other.agentId), 'another task on the other host makes progress');
    assert.ok(f.store.getMeta(finishedThreadCleanupKey(other.task.id)));
  } finally { await f.close(); }
});
