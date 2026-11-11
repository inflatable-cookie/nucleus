import { observeIdle } from './support/fakes';
import { bridgeProcessActions } from "../service/install/bridge-process-actions";
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Admission, admitAdapter, admissionOf } from '../core/host/admission';
import { Engine } from '../core/engine';
import { requestDisposition } from '../core/verbs/disposition';
import { QueueRuntime } from '../service/runtime-owner';
import { Store } from '../core/store/store';
import { QueueService } from '../service/transport/server';
import { ServiceClient, ServiceRequestError } from '../shared/service/client';
import { ServiceBridge } from '../hosts/paseo/plugin/bridge';
import { readServiceInfo } from '../service/transport/identity';
import { submissionSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter, AgentObservation } from '../core/host';
import { toolTimelinePage } from './support/tool-timeline';

/**
 * g01.028 acceptance oracle (Spec 013 "Incremental reconciliation").
 *
 * These fixtures prove Queue's outbound Paseo load is bounded, coalesced and
 * cached; that a lease checks only identities that still own work; that a
 * callback burst converges through one lane; that the safety sweep advances a
 * durable cursor and converges after a missed event; and that a slow title or
 * archive never occupies a delivery lane. Every fixture uses fake adapters and
 * a temporary store: no live Queue or Paseo state is touched.
 */

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
const base = 'b'.repeat(40), head = 'a'.repeat(40);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Workspace directories live under the fixture's own `worktrees` root, so
 * checkout-sibling discovery (which scans the workspace's parent) never reads
 * the shared host temporary directory.
 */
function tempStore() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-inc-')));
  const store = new Store(join(dir, 'queue.sqlite'));
  const root = join(dir, 'worktrees');
  return { store, dir, root, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function insertTask(store: Store, index = 0, extra: Partial<Task> = {}): Task {
  const task = store.insert(submissionSchema.parse({
    submissionId: `inc-${index}`, title: `Incremental task ${index}`, repoPath: `/repo-${index % 3}`,
    planningCommit: base, handoffPath: `docs/handoffs/inc-${index}.md`, originAgentId: 'origin', scope: 'general',
  }), 'fixture-host', 'handoff', base);
  if (Object.keys(extra).length) return store.update(task.id, extra);
  return task;
}

function fakeAdapter(overrides: Partial<Adapter> & Record<string, unknown> = {}, root?: string): Adapter {
  return {
    client: { isConnected: true }, hostId: 'fixture-host',
    socketPath: '/tmp/ns-callback.sock', helperPath: '/tmp/ns-helper.mjs',
    connect: async () => {}, close: async () => {}, profiles: async () => [profile],
    validate: async () => base, verifyWorkspace: async () => 'ns-branch',
    createWorkspace: async () => {
      if (!root) throw new Error('fakeAdapter needs a fixture-owned workspace root to create a workspace');
      return { id: 'ws', directory: join(root, 'ws') };
    },
    findWorkspaces: async () => [], createAgent: async () => ({ id: 'agent', workspaceId: 'ws' }),
    findAgents: async () => [], archiveAgent: async () => {},
    verifyPr: async () => ({ url: 'https://example/pull/1', head }),
    observe: observeIdle('ws'),
    ...overrides,
  } as unknown as Adapter;
}

/** Deferred promise helper for gating a fake external effect. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

test('admission bounds per-class concurrency, coalesces an identity and caches only stable idle', async () => {
  const admission = new Admission({ limits: { observation: 2 }, totalLimit: 2, startIntervalMs: 0, observationCacheMs: 60_000 });
  const started: string[] = [];
  let concurrent = 0, peak = 0;
  const open = gate();
  const slow = (id: string) => admission.observe(id, async () => {
    started.push(id); concurrent++; peak = Math.max(peak, concurrent);
    try { await open.promise; return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }; }
    finally { concurrent--; }
  });
  const flight = [slow('a'), slow('b'), slow('c')];
  await sleep(20);
  assert.deepEqual(started, ['a', 'b'], 'the third observation waits for a free bounded slot');
  open.open();
  await Promise.all(flight);
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(peak, 2, 'delayed observations never exceed the class bound');

  // Coalescing: two concurrent requests for one identity perform one read.
  let reads = 0;
  const held = gate();
  const observation = { id: 'shared', workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' };
  const one = admission.observe('shared', async () => { reads++; await held.promise; return observation; });
  const two = admission.observe('shared', async () => { reads++; await held.promise; return observation; });
  held.open();
  await Promise.all([one, two]);
  assert.equal(reads, 1, 'an equivalent in-flight observation is shared, not duplicated');

  // Caching: a stable idle identity answers from memory until it is invalidated.
  let idleReads = 0;
  const idle = async () => { idleReads++; return { id: 'idle', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }; };
  await admission.observe('idle', idle);
  await admission.observe('idle', idle);
  assert.equal(idleReads, 1, 'a settled quiet observation is served from the bounded cache');
  admission.invalidate('idle');
  await admission.observe('idle', idle);
  assert.equal(idleReads, 2, 'invalidation forces the next observation to reach Paseo again');
  const snapshot = admission.snapshot();
  assert.equal(snapshot.observation.coalesced >= 1, true);
  assert.equal(snapshot.observationCacheHits >= 1, true);
});

test('the operator Paseo-call bound caps concurrent daemon calls and applies live', async () => {
  // Spec 012: the total bound is an operator setting. It is read on every pump,
  // so a saved change takes effect without a restart or a lane re-dispatch.
  let limit = 2;
  const admission = new Admission({ totalLimit: () => limit, startIntervalMs: 0, limits: { observation: 32 } });
  let running = 0, peak = 0;
  const raw = fakeAdapter({ observe: async (id: string): Promise<AgentObservation> => {
    running++; peak = Math.max(peak, running);
    await sleep(40); running--;
    return { id, workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' };
  } });
  const admitted = admitAdapter(raw, admission);

  const first = Promise.all(Array.from({ length: 6 }, (_, index) => admitted.observe(`bounded-${index}`)));
  await sleep(15);
  assert.equal(peak, 2, 'the configured bound caps concurrent Paseo calls');
  await first;

  limit = 4;
  running = 0; peak = 0;
  const second = Promise.all(Array.from({ length: 6 }, (_, index) => admitted.observe(`live-${index}`)));
  await sleep(15);
  assert.equal(peak, 4, 'a raised bound applies live to in-flight work');
  await second;
  assert.equal(admission.totalLimit, 4);
});

test('admission paces starts and a narrow housekeeping backlog cannot reserve global slots', async () => {
  const admission = new Admission({ limits: { title: 1, callback: 1 }, totalLimit: 2, startIntervalMs: 25 });
  const titleGate = gate(), starts: { kind: string; at: number }[] = [];
  const firstTitle = admission.run('title', async () => { starts.push({ kind: 'title-1', at: Date.now() }); await titleGate.promise; });
  await sleep(5);
  const secondTitle = admission.run('title', async () => { starts.push({ kind: 'title-2', at: Date.now() }); });
  const callback = admission.run('callback', async () => { starts.push({ kind: 'callback', at: Date.now() }); });
  await callback;
  assert.deepEqual(starts.map(entry => entry.kind), ['title-1', 'callback'], 'the queued title does not consume the second global slot');
  assert.ok(starts[1]!.at - starts[0]!.at >= 15, 'starts are spread over time rather than emitted as one daemon burst');
  titleGate.open();
  await Promise.all([firstTitle, secondTitle, callback]);
  assert.equal(starts[2]!.kind, 'title-2');
});

test('degraded admission defers new workspaces, and clears after bounded healthy observations', async () => {
  let clock = 0;
  const admission = new Admission({ now: () => clock, degradedLatencyMs: 10_000, degradedExitSamples: 2, degradedCooldownMs: 0, startIntervalMs: 0, observationCacheMs: 0 });
  const slowObserve = () => admission.observe('slow', async () => { clock += 22_000; return { id: 'slow', workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' }; });
  await slowObserve();
  assert.equal(admission.degradedNow, false, 'one 22 s observation is warning evidence, not a trip');
  assert.match(admission.snapshot().backpressure.warning, /observation.*22000 ms/);
  await slowObserve();
  assert.equal(admission.degradedNow, false);
  await slowObserve();
  assert.equal(admission.degradedNow, true, 'three slow observations within a minute trip degraded admission');
  assert.match(admission.snapshot().backpressure.reason, /3 slow critical Paseo calls.*observation 22000 ms/);
  const deferred = admission.workspaceAdmission(0);
  assert.equal(deferred.admitted, false);
  if (!deferred.admitted) assert.match(deferred.reason, /Paseo admission breaker.*re-check after/);
  // Nonessential workspace mutation (titles) is deferred while degraded.
  assert.equal(admissionOf(admitAdapter(fakeAdapter(), admission)) !== null, true);

  const healthy = () => admission.observe('healthy', async () => ({ id: 'healthy', workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' }));
  await healthy();
  assert.equal(admission.degradedNow, true, 'one healthy sample is not enough to clear the breaker');
  await healthy();
  assert.equal(admission.degradedNow, false, 'bounded healthy observations clear the breaker');
  assert.equal(admission.workspaceAdmission(0).admitted, true);
  assert.ok(admission.snapshot().workspaceDeferrals >= 1);
});

test('slow noncritical calls and slow samples outside the trip window only warn', async () => {
  let clock = 0;
  const admission = new Admission({ now: () => clock, degradedLatencyMs: 10_000, startIntervalMs: 0 });
  for (let i = 0; i < 3; i++) await admission.run('callback', async () => { clock += 22_000; });
  assert.equal(admission.degradedNow, false);
  assert.match(admission.snapshot().backpressure.warning, /callback.*22000 ms/);
  clock += 60_001;
  assert.equal(admission.snapshot().backpressure.warning, '', 'old warning evidence expires');
  await admission.run('inventory', async () => { clock += 22_000; });
  clock += 60_001;
  await admission.run('inventory', async () => { clock += 22_000; });
  await admission.run('inventory', async () => { clock += 22_000; });
  assert.equal(admission.degradedNow, false, 'only two slow critical calls remain in the window');
});

test('the configured workspace admission budget delays only new creation', () => {
  const admission = new Admission({ workspaceBudget: 12, startIntervalMs: 0 });
  assert.equal(admission.workspaceAdmission(11).admitted, true);
  const atBudget = admission.workspaceAdmission(12);
  assert.equal(atBudget.admitted, false);
  if (!atBudget.admitted) assert.match(atBudget.reason, /workspace admission budget/);
  assert.equal(admission.snapshot().workspaceBudget, 12);
});

test('a Queue mutation invalidates the cached observation for the identity it touched', async () => {
  const admission = new Admission({ observationCacheMs: 60_000, startIntervalMs: 0 });
  let reads = 0;
  const raw = fakeAdapter({
    observe: async (id: string) => { reads++; return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }; },
    createAgent: async () => ({ id: 'agent-1', workspaceId: 'ws' }),
  });
  const adapter = admitAdapter(raw, admission);
  await adapter.observe('agent-1');
  await adapter.observe('agent-1');
  assert.equal(reads, 1);
  await adapter.createAgent({ id: 'task-1', runId: 'run-1', workspaceId: 'ws' } as unknown as Task, 'token', 'prompt');
  await adapter.observe('agent-1');
  assert.equal(reads, 2, 'creating an agent identity invalidates its cached observation');
});

test('admission forwards mergeGate check history instead of dropping the extra argument', async () => {
  let historyArg: unknown;
  const raw = fakeAdapter({
    mergeGate: async (_task: unknown, history?: unknown) => {
      historyArg = history;
      return { head, base, wait: '' };
    },
  });
  const admitted = admitAdapter(raw, new Admission({ startIntervalMs: 0 }));
  const history = { now: 1, durations: () => [5] };
  await (admitted as Adapter & { mergeGate: (task: unknown, history?: unknown) => Promise<unknown> }).mergeGate({ id: 't', repoPath: '/repo' }, history);
  assert.equal(historyArg, history);
});

test('resolution merge gates pass store history through an admitted adapter', async () => {
  const { store, root, close } = tempStore();
  try {
    let sawHistory = false;
    const raw = fakeAdapter({
      mergeGate: async (_task: unknown, history?: { durations?: (name: string) => number[] }) => {
        sawHistory = typeof history?.durations === 'function';
        return { head, base, wait: '' };
      },
    }, root);
    const engine = new Engine(store, admitAdapter(raw, new Admission({ startIntervalMs: 0 })), 0);
    const task = insertTask(store, 0, { repoPath: '/repo' });
    await (engine.resolution as unknown as { mergeGateEvidence: (t: Task) => Promise<unknown> }).mergeGateEvidence(task);
    assert.equal(sawHistory, true);
  } finally { close(); }
});

test('degraded admission defers one workspace intent and resumes it after bounded recovery', async () => {
  const { store, root, close } = tempStore();
  store.setMeta('paused', false);
  store.setMeta('globalLimit', 5);
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'author', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  let workspaces = 0;
  let clock = 0;
  const admission = new Admission({ now: () => clock, degradedLatencyMs: 30, degradedExitSamples: 1, degradedCooldownMs: 0, startIntervalMs: 0, observationCacheMs: 0 });
  const raw = fakeAdapter({
    createWorkspace: async () => { workspaces++; return { id: 'ws-new', directory: join(root, 'ws-new') }; },
    createAgent: async (task: Task) => ({ id: 'agent-new', workspaceId: task.workspaceId! }),
  }, root);
  const engine = new Engine(store, admitAdapter(raw, admission), 60_000);
  engine.profiles = [profile];
  try {
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async () => ({ hold: false });
    const task = insertTask(store, 0);
    // Sustained slow reads trip the breaker without any workspace effect.
    for (let i = 0; i < 3; i++) await admission.run('inventory', async () => { clock += 40; });
    assert.equal(admission.degradedNow, true);
    await engine.wake();
    const deferred = store.task(task.id);
    assert.equal(deferred.phase, 'queued', 'a deferred creation leaves the task visibly queued');
    assert.equal(deferred.workspaceIntent, false, 'no durable creation intent was recorded while deferred');
    // The wait is derived when read, so a queued task takes no durable write for it.
    assert.match(engine.queuedExternalWait(deferred), /Paseo admission breaker.*re-check after/);
    assert.equal(workspaces, 0, 'no workspace was created while Paseo was degraded');
    assert.equal(admission.snapshot().workspaceDeferrals >= 1, true);

    // Bounded healthy observations clear the breaker and the same intent resumes.
    await admission.run('inventory', async () => {});
    assert.equal(admission.degradedNow, false);
    await engine.wake();
    assert.equal(workspaces, 1, 'the deferred workspace intent resumed exactly once');
    assert.equal(store.task(task.id).phase, 'working');
  } finally {
    await engine.stop();
    close();
  }
});

test('a hundred same-task events coalesce to bounded observation and title work', async () => {
  const { store, root, close } = tempStore();
  const observes: string[] = [];
  const titles: string[] = [];
  const admission = new Admission({ observationCacheMs: 60_000, startIntervalMs: 0 });
  const raw = fakeAdapter({
    observe: async (id: string) => { observes.push(id); return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }; },
    setTaskWorkspaceTitle: async (task: Task) => { titles.push(task.id); },
  }, root);
  const engine = new Engine(store, admitAdapter(raw, admission), 60_000);
  try {
    const task = insertTask(store, 0, {
      phase: 'working', workspaceIntent: true, workspaceId: 'ws', directory: join(root, 'ws'), agentIntent: true,
      agentId: 'worker-1', runId: 'run-1', profile, lastAgentStatus: 'running',
    });
    const unrelated = insertTask(store, 1, {
      phase: 'working', workspaceIntent: true, workspaceId: 'ws-2', directory: join(root, 'ws-2'), agentIntent: true,
      agentId: 'worker-2', runId: 'run-2', profile, lastAgentStatus: 'running',
    });
    for (let index = 0; index < 100; index++) void engine.wakeTask(task.id);
    await engine.quiesce();
    assert.deepEqual([...new Set(observes)], ['worker-1'], 'only the affected task identity was observed');
    assert.ok(observes.length <= 2, `100 same-task events must coalesce to a bounded number of Paseo observations (saw ${observes.length})`);
    assert.equal(observes.includes('worker-2'), false, 'no unrelated task identity was observed');
    assert.deepEqual(titles, [task.id], 'title work was enqueued only for the affected task, and confirmed once');
    assert.equal(store.task(task.id).phase, 'working');
    assert.equal(store.task(task.id).agentActive, false, 'the task converged once from the shared observation');
    assert.equal(store.task(unrelated.id).lastObservedAt, null, 'an unrelated task was not reconciled by this burst');
  } finally {
    await engine.stop();
    close();
  }
});

test('a lease checks current and uncertain identities, never released historical runs', async () => {
  const { store, root, close } = tempStore();
  const polled: string[] = [];
  const raw = fakeAdapter({
    observe: async (id: string) => {
      if (id.startsWith('hist-')) throw new Error(`released historical agent polled: ${id}`);
      polled.push(id);
      return { id, workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' };
    },
  }, root);
  const engine = new Engine(store, raw, 0);
  try {
    const task = insertTask(store, 0, {
      phase: 'awaiting_review', workspaceIntent: true, workspaceId: 'ws', directory: join(root, 'ws'), agentIntent: true,
      agentId: 'worker-1', runId: 'run-1', profile, prHead: head, prUrl: 'https://example/pull/1',
    });
    for (let index = 0; index < 10; index++) {
      store.putRun({
        id: `history-${index}`, taskId: task.id, role: index % 2 ? 'reviewer' : 'revision', generation: 1, head, base,
        agentId: `hist-${index}`, workspaceId: 'ws', profile: null, status: 'finished',
        createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false,
        idleSince: new Date().toISOString(), completion: null, released: true,
      });
    }
    assert.equal(await engine.resolution.lease(store.task(task.id)), true, 'the live worker lease still holds');
    assert.deepEqual([...new Set(polled)], ['worker-1'], 'ten released historical runs were never polled');
  } finally {
    await engine.stop();
    close();
  }
});

test('the merge and closeout execution lease admits an errored participant with no live turn or permission', async () => {
  const { store, root, close } = tempStore();
  const states = new Map<string, AgentObservation>([
    ['worker-1', { id: 'worker-1', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }],
    ['reviewer-1', { id: 'reviewer-1', workspaceId: 'ws', status: 'error', error: 'Connection error', active: false, permissions: false }],
  ]);
  const raw = fakeAdapter({
    observe: async (id: string) => {
      const state = states.get(id);
      if (!state) throw new Error(`unexpected participant observation: ${id}`);
      return state;
    },
    agentTimelinePage: async () => toolTimelinePage([]),
  }, root);
  const engine = new Engine(store, raw, 0);
  try {
    const task = insertTask(store, 0, {
      phase: 'verifying', workspaceIntent: true, workspaceId: 'ws', directory: join(root, 'ws'), agentIntent: true,
      agentId: 'worker-1', runId: 'run-1', profile, prHead: head, prUrl: 'https://example/pull/1',
    });
    store.putRun({
      id: 'review-1', taskId: task.id, role: 'reviewer', generation: 1, head, base,
      agentId: 'reviewer-1', workspaceId: 'ws', profile: null, status: 'finished',
      createdAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(), active: false,
      idleSince: new Date().toISOString(), completion: null, released: false,
    });
    // The execution lease is the merge and closeout participant gate; it is
    // private by design, so this pins its contract through a narrow cast.
    const gate = engine.resolution as unknown as { executionLease(t: Task): Promise<boolean> };
    const check = () => gate.executionLease(store.task(task.id));
    assert.equal(await check(), true, 'Queue #606: an errored participant with no turn and no permission does not fence merge or closeout');
    states.set('reviewer-1', { ...states.get('reviewer-1')!, permissions: true });
    assert.equal(await check(), false, 'a permission-pending error still fences');
    states.set('reviewer-1', { ...states.get('reviewer-1')!, permissions: false, active: true });
    assert.equal(await check(), false, 'a live error still fences');
    states.set('reviewer-1', { ...states.get('reviewer-1')!, active: false, status: 'closed' });
    assert.equal(await check(), true, 'a closed participant still passes');
  } finally {
    await engine.stop();
    close();
  }
});

test('the safety sweep advances a bounded cursor and converges after a missed event', async () => {
  const { store, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const engine = new Engine(store, raw, 0);
  try {
    store.setMeta('globalLimit', 0); // keep queued tasks undispatchable without remote effects
    store.setMeta('paused', false);
    // Active work is what the minute sweep exists for: a capacity-blocked queue is
    // advanced by dispatch wakes and covered by a drain, so it must not set the lap.
    for (let index = 0; index < 60; index++) insertTask(store, index, { phase: 'verifying' } as Partial<Task>);
    const reconciled = new Set<string>();
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => { reconciled.add(task.id); return { hold: false }; };
    let bound = 0;
    while (reconciled.size < 60 && bound++ < 10) await engine.sweepOnce();
    assert.equal(reconciled.size, 60, 'bounded sweeps eventually cover every active task without one fleet pass');
    assert.ok(bound > 1, 'the sweep did not walk the active fleet in one window');
    const first = engine.reconciliationSnapshot();
    assert.equal(first.tasks, 60);
    assert.ok(first.passes >= 3, `expected several bounded windows (saw ${first.passes})`);
    await engine.sweepOnce();
    const afterWindow = engine.reconciliationSnapshot();
    assert.notEqual(afterWindow.cursor, first.cursor, 'the durable cursor advanced between windows');
    // A full drain resets the cursor once it has covered the fleet.
    await engine.wake();
    assert.equal(engine.reconciliationSnapshot().cursor, null, 'a completed drain resets the durable cursor');
  } finally {
    await engine.stop();
    close();
  }
});

test('Sol #609 P2: a drain after a partial window reaches every task once, not just the cursor tail', async () => {
  const { store, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const engine = new Engine(store, raw, 0);
  try {
    store.setMeta('globalLimit', 0);
    store.setMeta('paused', false);
    for (let index = 0; index < 30; index++) insertTask(store, index, { phase: 'verifying' } as Partial<Task>);
    const reconciled = new Set<string>();
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => { reconciled.add(task.id); return { hold: false }; };
    await engine.sweepOnce();
    assert.equal(reconciled.size, 25, 'one window covers one page and leaves the cursor mid-fleet');
    assert.notEqual(engine.reconciliationSnapshot().cursor, null);
    reconciled.clear();
    await engine.wake();
    assert.equal(reconciled.size, 30, 'the drain wrapped to the start and reached every task after the request');
    assert.equal(engine.reconciliationSnapshot().cursor, null, 'a covering drain resets the cursor');
  } finally {
    await engine.stop();
    close();
  }
});

test('Sol #609 P2: a drain capped before it reaches every task carries its coverage into the next pass and completes', async () => {
  const { store, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const engine = new Engine(store, raw, 0);
  try {
    store.setMeta('globalLimit', 0);
    store.setMeta('paused', false);
    for (let index = 0; index < 60; index++) insertTask(store, index, { phase: 'verifying' } as Partial<Task>);
    const reconciled = new Map<string, number>();
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => {
      reconciled.set(task.id, (reconciled.get(task.id) ?? 0) + 1); return { hold: false }; };
    engine.maxSweepWindows = 1; // one window per pass, as a fleet above the real cap would see
    await engine.wake();
    assert.equal(reconciled.size, 60, 'the capped drain completed across passes, reaching every task');
    assert.ok([...reconciled.values()].every(count => count === 1), 'each task was reached once by the drain');
    assert.equal(engine.reconciliationSnapshot().cursor, null);
  } finally {
    await engine.stop();
    close();
  }
});

test('Sol #609 P2: a task that finishes at the cursor mid-drain never stands in for a surviving task', async () => {
  const { store, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const engine = new Engine(store, raw, 0);
  try {
    store.setMeta('globalLimit', 0);
    store.setMeta('paused', false);
    const tasks = Array.from({ length: 60 }, (_, index) => insertTask(store, index, { phase: 'verifying' } as Partial<Task>));
    const reconciled = new Map<string, number>();
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => {
      reconciled.set(task.id, (reconciled.get(task.id) ?? 0) + 1);
      // The 25th task visited (the capped pass's last, so the cursor) finishes during its quantum.
      if (reconciled.size === 25) store.update(task.id, { phase: 'done' }, 'fixture');
      return { hold: false };
    };
    engine.maxSweepWindows = 1;
    await engine.wake();
    const survivors = tasks.map(task => task.id).filter(id => store.task(id).phase !== 'done');
    assert.equal(survivors.length, 59);
    assert.deepEqual(survivors.filter(id => !reconciled.has(id)), [], 'every surviving task was visited by the drain');
    assert.ok([...reconciled.values()].every(count => count === 1), 'no task was visited twice to make up the count');
  } finally {
    await engine.stop();
    close();
  }
});

test('a capacity-blocked queue does not hold the sweep window against active work', async () => {
  const { store, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const engine = new Engine(store, raw, 0);
  try {
    store.setMeta('globalLimit', 0); // keep queued tasks undispatchable without remote effects
    store.setMeta('paused', false);
    // The shape of the live regression: a deep queue of tasks with nothing to
    // reconcile, created after the one task that has work in flight.
    const active = insertTask(store, 0, { phase: 'verifying' } as Partial<Task>);
    for (let index = 1; index <= 98; index++) insertTask(store, index);
    const reconciled: string[] = [];
    (engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => { reconciled.push(task.id); return { hold: false }; };
    await engine.sweepOnce();
    assert.ok(reconciled.includes(active.id), 'one bounded window reached the active task despite 98 queued tasks ahead of it');
    // Never-started queued work is driven by dispatch and dependency wakes, so
    // neither later sweeps nor a drain visit it, however deep the queue is.
    reconciled.length = 0;
    for (let tick = 0; tick < 5; tick++) await engine.sweepOnce();
    await engine.wake();
    assert.deepEqual([...new Set(reconciled)], [active.id], 'only the active task is reconciled');
  } finally {
    await engine.stop();
    close();
  }
});

test('a slow title or archive never occupies a delivery lane', async () => {
  const { store, root, close } = tempStore();
  const titleGate = gate();
  let titles = 0;
  const raw = fakeAdapter({
    setTaskWorkspaceTitle: async () => { titles++; await titleGate.promise; },
  }, root);
  const engine = new Engine(store, raw, 60_000);
  try {
    const task = insertTask(store, 0, {
      phase: 'working', workspaceIntent: true, workspaceId: 'ws', directory: join(root, 'ws'), agentIntent: true,
      agentId: 'worker-1', runId: 'run-1', profile, lastAgentStatus: 'running',
    });
    const other = insertTask(store, 1);
    void engine.wakeTask(task.id);
    await sleep(30);
    assert.equal(titles, 1, 'the title projection is in flight on its own serial lane');
    assert.notEqual(store.getMeta(`workspaceTitle:${task.id}`), undefined, 'the durable title intent is recorded');
    // A versioned operator control must complete while the slow title is still held.
    const controlled = await Promise.race([
      engine.performTaskControl({ taskId: other.id, version: other.version, action:'hold',reason:'Test hold' }),
      sleep(300).then(() => { throw new Error('a slow title starved a delivery lane'); }),
    ]);
    assert.equal((controlled as Task).held, true, 'the control landed while the title was still waiting');
    assert.equal(titles, 1, 'the title never resolved during the control');
    titleGate.open();
    await sleep(30);
  } finally {
    titleGate.open();
    await engine.stop();
    close();
  }
});

test('lifecycle hints map only known Queue identities and never scan the fleet', async () => {
  const { store, dir, root, close } = tempStore();
  const raw = fakeAdapter({}, root);
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => raw, timers: false, admission: { observationCacheMs: 0, startIntervalMs: 0 } });
  try {
    runtime.store.setMeta('paused', false);
    // A fresh store holds the process lease again only after the previous owner drains.
    const first = insertTask(runtime.store, 0, {
      phase: 'working', workspaceIntent: true, workspaceId: 'ws-known', directory: join(root, 'ws'), agentIntent: true,
      agentId: 'agent-known', runId: 'run-known', profile, lastAgentStatus: 'running',
    });
    insertTask(runtime.store, 1);
    const reconciled = new Set<string>();
    (runtime.engine.hooks as unknown as { reconcileTask: (task: Task) => Promise<{ hold: boolean }> }).reconcileTask = async (task: Task) => { reconciled.add(task.id); return { hold: false }; };
    // Settle the detached startup reconciliation before measuring the hint so
    // only the signal's own lane wake is observed.
    await runtime.started;
    await runtime.bootstrap?.catch(() => {});
    await runtime.engine.quiesce();
    reconciled.clear();
    assert.deepEqual(runtime.store.taskIdsForIdentities({ agentId: 'agent-known', workspaceId: null }), [first.id]);
    assert.deepEqual(runtime.store.taskIdsForIdentities({ agentId: 'absent', workspaceId: null }), []);
    assert.deepEqual(runtime.store.taskIdsForIdentities({ agentId: null, workspaceId: 'ws-known' }), [first.id]);
    const hint = runtime.lifecycleSignal({ kind: 'agent.turn_ended', agentId: 'agent-known', workspaceId: 'ws-known', at: new Date().toISOString() });
    assert.deepEqual(hint, { ok: true, matched: 1 });
    assert.deepEqual(runtime.lifecycleSignal({ kind: 'agent.created', agentId: 'unknown', workspaceId: null, at: new Date().toISOString() }), { ok: true, matched: 0 }, 'an unknown identity schedules nothing');
    assert.deepEqual(runtime.lifecycleSignal({ kind: 'not-a-kind' }), { ok: true, matched: 0 }, 'an invalid hint is ignored, never rejected as a lifecycle failure');
    await runtime.engine.quiesce();
    assert.deepEqual([...reconciled], [first.id], 'only the known task lane was scheduled');
    const health = runtime.health();
    assert.equal(health.admission.lifecycleSignals >= 1, true);
    assert.equal(typeof health.reconciliation.tasks, 'number');
  } finally {
    await runtime.drain();
    close();
  }
});

test('the service accepts a bounded lifecycle hint over its socket and reports the match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq'));
  const dataDir = join(dir, 'northstar-queue');
  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'rich', debug: true });
  await service.start();
  const info = readServiceInfo(dataDir)!;
  const client = new ServiceClient({ socketPath: info.socketPath, credential: info.credential });
  await client.connect();
  try {
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'svc-inc-1', title: 'Service hint', repoPath: '/repo', planningCommit: base,
      handoffPath: 'docs/handoffs/svc-inc-1.md', originAgentId: 'origin',
    }), 'host', 'handoff', base] }) as { id: string; version: number };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { agentId: 'agent-svc', workspaceId: 'ws-svc' }] });
    const matched = await client.request('service.lifecycle-signal', { kind: 'agent.created', agentId: 'agent-svc', workspaceId: 'ws-svc', at: new Date().toISOString() });
    assert.deepEqual(matched, { ok: true, matched: 1 });
    const absent = await client.request('service.lifecycle-signal', { kind: 'workspace.archived', agentId: null, workspaceId: 'ws-absent', at: new Date().toISOString() });
    assert.deepEqual(absent, { ok: true, matched: 0 });
    // Health exposes Queue's outbound admission and sweep evidence without secrets.
    const health = await client.request('service.health', {}) as Record<string, unknown>;
    const admission = health.admission as Record<string, unknown>;
    assert.equal(admission.workspaceBudget, 32);
    // The Settings-only capacity rule: a direct socket write refuses with zero
    // mutation, and the read reports the same budget and no recorded change.
    await assert.rejects(() => client.request("queue.capacity", { globalLimit: 24, projectLimit: 5 }),
      (error: unknown) => error instanceof ServiceRequestError && /queue\.capacity is refused/.test(error.message));
    const updated = await client.request("service.health", {}) as typeof health;
    assert.equal((updated.admission as Record<string, unknown>).workspaceBudget, 32, 'a refused write changes no limit');
    const capacityState = await client.request("queue.capacity-state", {}) as { effective: { globalLimit: number }; changes: unknown[] };
    assert.equal(capacityState.effective.globalLimit, 32);
    assert.deepEqual(capacityState.changes, [], 'a refused write records no change');
    assert.equal((admission.backpressure as { degraded: boolean }).degraded, false);
    assert.ok(health.reconciliation);
  } finally {
    client.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the bridge forwards lifecycle hints only to a compatible running service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq'));
  const dataDir = join(dir, 'northstar-queue');
  const sourcePath = fileURLToPath(new URL('..', import.meta.url));
  // A definitely absent service: the bridge still reports honestly and never spawns.
  const absent = new ServiceBridge({ processActions: bridgeProcessActions, dataDir, sourcePath });
  const at = new Date().toISOString();
  assert.equal(await absent.signal({ kind: 'agent.created', agentId: 'a', workspaceId: null, at }), false);
  assert.equal(await absent.signal({ kind: 'agent.created', agentId: '', workspaceId: null, at }), false, 'an empty identity is not a hint');
  absent.close();

  const service = new QueueService({ owner: { dataDir, timers: false }, fixture: 'rich', debug: true });
  await service.start();
  try {
    const bridge = new ServiceBridge({ processActions: bridgeProcessActions, dataDir, sourcePath });
    const task = await service.debug({ target: 'store', method: 'insert', args: [submissionSchema.parse({
      submissionId: 'bridge-inc-1', title: 'Bridge hint', repoPath: '/repo', planningCommit: base,
      handoffPath: 'docs/handoffs/bridge-inc-1.md', originAgentId: 'origin',
    }), 'host', 'handoff', base] }) as { id: string; version: number };
    await service.debug({ target: 'store', method: 'update', args: [task.id, { agentId: 'agent-bridge', workspaceId: 'ws-bridge' }] });
    assert.equal(await bridge.signal({ kind: 'agent.turn_started', agentId: 'agent-bridge', workspaceId: 'ws-bridge', at }), true);
    assert.equal(await bridge.signal({ kind: 'agent.created', agentId: 'nobody', workspaceId: null, at }), true, 'the service accepted an unknown identity as a no-op');
    bridge.close();
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatch wakes and sweep share the task lane through pre-dispatch hooks', { timeout: 10000 }, async () => {
  const f = tempStore();
  const entered = gate(), release = gate();
  let emissions = 0, active = false, overlappingReconciliation = false, workspaces = 0;
  const engine = new Engine(f.store, fakeAdapter({
    createWorkspace: async () => { workspaces++; return { id: 'ws', directory: join(f.root, 'ws') }; },
    observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' }),
  }));
  engine.profiles = [profile];
  f.store.setMeta('paused', false);
  f.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const task = insertTask(f.store);
  engine.hooks.emit = async () => {
    emissions++;
    if (active) throw new Error('Concurrent hook event intent');
    active = true; entered.open();
    await release.promise;
    active = false;
    return { hold: false, attention: false, records: [] };
  };
  engine.hooks.reconcileTask = async () => {
    overlappingReconciliation ||= active;
    return { hold: false, attention: false, records: [] };
  };
  try {
    const dispatch = engine.wakeRepository(task.repoPath);
    await entered.promise;
    const reconciliation = engine.wakeTask(task.id);
    await sleep(20);
    const sweep = engine.sweepOnce();
    const repeat = engine.wakeRepository(task.repoPath);
    await sleep(30);
    release.open();
    await Promise.all([dispatch, reconciliation, sweep, repeat]);
    await engine.quiesce();
    assert.equal(overlappingReconciliation, false, 'reconciliation cannot inspect an in-flight dispatch hook');
    assert.equal(emissions, 1, 'all wakes reuse the one dispatch transition');
    assert.equal(workspaces, 1);
    assert.equal(f.store.task(task.id).phase, 'working');
  } finally { release.open(); await engine.stop(); f.close(); }
});

test('sweep dispatch cannot race repository dispatch while a hook is awaiting its pin', { timeout: 10000 }, async () => {
  const f = tempStore();
  const sweepReady = gate(), resumeSweep = gate(), hookEntered = gate(), releaseHook = gate();
  let emissions = 0, workspaces = 0;
  const engine = new Engine(f.store, fakeAdapter({
    createWorkspace: async () => { workspaces++; return { id: 'ws', directory: join(f.root, 'ws') }; },
    observe: async (id: string) => ({ id, workspaceId: 'ws', status: 'running', active: true, permissions: false, error: '' }),
  }));
  engine.profiles = [profile];
  f.store.setMeta('paused', false);
  f.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const task = insertTask(f.store);
  engine.resolution.deliverNotices = async () => { sweepReady.open(); await resumeSweep.promise; };
  engine.hooks.emit = async () => {
    emissions++;
    if (emissions > 1) throw new Error('Concurrent hook event intent');
    hookEntered.open(); await releaseHook.promise;
    return { hold: false, attention: false, records: [] };
  };
  try {
    const sweep = engine.sweepOnce();
    await sweepReady.promise;
    const dispatch = engine.wakeRepository(task.repoPath);
    await hookEntered.promise;
    resumeSweep.open();
    await sleep(30);
    releaseHook.open();
    await Promise.all([dispatch, sweep]);
    assert.equal(emissions, 1);
    assert.equal(workspaces, 1);
    assert.equal(f.store.task(task.id).phase, 'working');
  } finally { resumeSweep.open(); releaseHook.open(); await engine.stop(); f.close(); }
});


test('workspace admission follows live budget changes without discarding retained work',()=>{
  let globalLimit=12;
  const admission=new Admission({workspaceBudget:()=>globalLimit,startIntervalMs:0});
  assert.equal(admission.workspaceAdmission(12).admitted,false);
  globalLimit=24;
  assert.equal(admission.workspaceAdmission(12).admitted,true);
  assert.equal(admission.workspaceAdmission(23).admitted,true);
  assert.equal(admission.workspaceAdmission(24).admitted,false);
  globalLimit=8;
  assert.equal(admission.workspaceAdmission(12).admitted,false);
  assert.equal(admission.snapshot().workspaces,12);
  assert.equal(admission.snapshot().workspaceBudget,8);
});

test('an in-flight Paseo stall warns without holding housekeeping', async () => {
  let clock = 0;
  const admission = new Admission({ now: () => clock, startIntervalMs: 0, degradedLatencyMs: 100 });
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const slow = admission.run('title', () => new Promise<void>(resolve => { finish = resolve; entered(); }));
  await started;
  try {
    clock = 101;
    assert.equal(admission.degradedNow, false);
    assert.match(admission.snapshot().backpressure.warning, /title call pending for 101 ms/);
    assert.equal(admission.workspaceAdmission(0).admitted, true);
    let cleanup = false;
    await admission.run('cleanup', async () => { cleanup = true; });
    assert.equal(cleanup, true);
    await admission.run('callback', async () => {});
    for (let i = 0; i < 4; i++) await admission.run('inventory', async () => {});
    assert.equal(admission.degradedNow, false);
  } finally { finish(); await slow; }
});

test('fast reads and failed probes cannot immediately clear a completed Paseo stall', async () => {
  let clock = 0;
  const admission = new Admission({ now: () => clock, startIntervalMs: 0, degradedLatencyMs: 100 });
  for (let i = 0; i < 3; i++) await admission.run('title', async () => { clock += 101; });
  for (let i = 0; i < 4; i++) await admission.run('inventory', async () => {});
  assert.equal(admission.degradedNow, true, 'default cooldown survives cheap successful reads');
  clock += 30001;
  for (let i = 0; i < 4; i++) await assert.rejects(admission.run('observation', async () => { throw Error('probe failed'); }));
  assert.equal(admission.degradedNow, true, 'failed probes are not recovery evidence');
  for (let i = 0; i < 3; i++) await admission.run('observation', async () => {});
  assert.equal(admission.degradedNow, false);
  let cleanup = false;
  await admission.run('cleanup', async () => { cleanup = true; });
  assert.equal(cleanup, true, 'deferred cleanup can resume once pressure recovers');
});

test('a pre-dispatch hold that lands after a completed cancellation never reopens the task', { timeout: 10000 }, async () => {
  const f = tempStore();
  const entered = gate(), release = gate();
  const engine = new Engine(f.store, fakeAdapter({}, f.root));
  engine.profiles = [profile];
  f.store.setMeta('paused', false);
  f.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const task = insertTask(f.store);
  engine.hooks.emit = async (event: string) => {
    if (event !== 'task.pre_dispatch') return { hold: false, attention: false, records: [] };
    entered.open(); await release.promise;
    return { hold: true, attention: true, records: [] };
  };
  try {
    const dispatch = engine.wakeRepository(task.repoPath);
    await entered.promise;
    // g04.025: a cancellation outside the dispatch lane completes while the hook runs.
    const cancelled = await requestDisposition(f.store, (engine as any).dispositionDeps(),
      { taskId: task.id, version: f.store.task(task.id).version, action: 'cancel', reason: 'Superseded before dispatch' });
    assert.equal(cancelled.phase, 'cancelled');
    release.open();
    await dispatch; await engine.quiesce();
    assert.equal(f.store.task(task.id).phase, 'cancelled', 'the stale pre-hook read does not reopen a terminal task');
  } finally { release.open(); await engine.stop(); f.close(); }
});

test('a slow task does not hold other tasks in its safety-sweep window', { timeout: 10000 }, async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const entered = gate(), release = gate(), independent = gate();
  try {
    f.store.setMeta('paused', false);
    const fast = insertTask(f.store, 701, { phase: 'verifying' });
    const slow = insertTask(f.store, 702, { phase: 'verifying' });
    engine.resolution.advance = async task => {
      if (task.id === slow.id) { entered.open(); await release.promise; }
      if (task.id === fast.id) independent.open();
    };
    const sweep = engine.sweepOnce();
    await entered.promise;
    await independent.promise;
    assert.equal(f.store.task(slow.id).phase, 'verifying', 'the slow effect is still pending');
    release.open();
    await sweep;
  } finally { release.open(); await engine.stop(); f.close(); }
});

test('mechanical progress drains one exact task and hands integration to its successor without another sweep', { timeout: 10000 }, async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const finished = gate();
  const calls: string[] = [];
  let active = 0, peak = 0;
  try {
    f.store.setMeta('paused', false);
    const first = insertTask(f.store, 703, { phase: 'verifying' });
    const second = insertTask(f.store, 704, { phase: 'verifying', repoPath: first.repoPath });
    engine.resolution.assignIntegrationTurn(first);
    engine.resolution.assignIntegrationTurn(second);
    engine.resolution.advance = async task => {
      assert.equal(engine.resolution.holdsIntegrationTurn(task), true, 'FIFO integration ownership still binds');
      active++; peak = Math.max(peak, active);
      calls.push(`${task.id}:${task.phase}`);
      await sleep(1);
      const phases: Partial<Record<Task['phase'], Task['phase']>> = { verifying: 'merging', merging: 'syncing', syncing: 'closing', closing: 'done' };
      const next = phases[task.phase];
      assert.ok(next);
      f.store.update(task.id, { phase: next as Task['phase'] });
      active--;
      if (task.id === second.id && next === 'done') finished.open();
    };
    await engine.wakeTask(first.id);
    await finished.promise;
    await engine.quiesce();
    assert.equal(peak, 1, 'neither same-task nor repository integration work overlaps');
    assert.deepEqual(calls, [first, second].flatMap(task => ['verifying', 'merging', 'syncing', 'closing'].map(phase => `${task.id}:${phase}`)));
    assert.equal(f.store.task(second.id).phase, 'done');
  } finally { await engine.stop(); f.close(); }
});

test('unchanged waits and reason-only updates do not cause lifecycle polling loops', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  let calls = 0;
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 705, { phase: 'verifying' });
    engine.resolution.advance = async task => { calls++; f.store.update(task.id, { reason: `Still waiting ${calls}` }); };
    await engine.wakeTask(task.id);
    await sleep(30);
    await engine.quiesce();
    assert.equal(calls, 1);
  } finally { await engine.stop(); f.close(); }
});

const MECHANICAL: Partial<Record<Task['phase'], Task['phase']>> = {
  verifying: 'merging', merging: 'syncing', syncing: 'closing', closing: 'done',
};

function progressMechanically(store: Store, task: Task) {
  const next = MECHANICAL[task.phase];
  if (next) store.update(task.id, { phase: next });
}

test('a pause accepted after mechanical progress still drains existing work', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const calls: string[] = [];
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 706, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls.push(current.phase);
      progressMechanically(f.store, current);
      f.store.setMeta('paused', true);
    };
    await engine.wakeTask(task.id);
    await engine.quiesce();
    // nucleus#937 / orchestration contract: pause starts no new run; in-flight
    // mechanical work still drains. The follow-up is settlement, not a launch.
    assert.deepEqual(calls, ['verifying', 'merging', 'syncing', 'closing']);
    assert.equal(f.store.task(task.id).phase, 'done');
  } finally { await engine.stop(); f.close(); }
});


test('a dispatch fence accepted between mechanical steps suppresses follow-up delivery', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  let calls = 0;
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 707, { phase: 'verifying' });
    engine.resolution.advance = async task => {
      calls++;
      f.store.update(task.id, { phase: 'merging', holds: { dispatch: { owner: 'operator', reason: 'Stop',
        at: new Date().toISOString(), generation: 1, until: null, blocking: null } } });
    };
    await engine.wakeTask(task.id);
    await engine.quiesce();
    assert.equal(calls, 1);
    assert.equal(f.store.task(task.id).phase, 'merging');
  } finally { await engine.stop(); f.close(); }
});

test('quiesce waits for a follow-up accepted before it enqueues', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const calls: string[] = [];
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 800, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls.push(current.phase);
      progressMechanically(f.store, current);
    };
    await engine.wakeTask(task.id);
    assert.deepEqual(calls, ['verifying'], 'the follow-up setImmediate has not run during microtasks');
    await engine.quiesce();
    assert.deepEqual(calls, ['verifying', 'merging', 'syncing', 'closing']);
    assert.equal(f.store.task(task.id).phase, 'done');
  } finally { await engine.stop(); f.close(); }
});

test('quiesce waits for transitive follow-ups and then fixture mutation, disposal and server stop are safe', async () => {
  const f = tempStore();
  const fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-quiesce-fx-')));
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const writes: string[] = [];
  let serverLive = true, wroteAfterDispose = false, sawStoppedServer = false, sawMutation = false;
  const marker = join(fixtureDir, 'mutated');
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 801, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      if (!serverLive) sawStoppedServer = true;
      if (existsSync(marker)) sawMutation = true;
      try { writeFileSync(join(fixtureDir, current.phase), current.phase); writes.push(current.phase); }
      catch { wroteAfterDispose = true; }
      progressMechanically(f.store, current);
    };
    await engine.wakeTask(task.id);
    assert.deepEqual(writes, ['verifying']);
    await engine.quiesce();
    assert.deepEqual(writes, ['verifying', 'merging', 'syncing', 'closing']);
    writeFileSync(marker, 'after-quiesce');
    serverLive = false;
    rmSync(fixtureDir, { recursive: true, force: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(wroteAfterDispose, false);
    assert.equal(sawStoppedServer, false);
    assert.equal(sawMutation, false);
    assert.equal(f.store.task(task.id).phase, 'done');
  } finally {
    await engine.stop();
    f.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('stop waits for a pending follow-up callback and that callback does not run work', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const calls: string[] = [];
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 802, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls.push(current.phase);
      progressMechanically(f.store, current);
    };
    await engine.wakeTask(task.id);
    assert.deepEqual(calls, ['verifying']);
    await engine.stop();
    assert.deepEqual(calls, ['verifying'], 'the follow-up observes stop and does not take another quantum');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['verifying']);
  } finally { f.close(); }
});

test('a follow-up for a removed task no-ops and still settles quiesce', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const calls: string[] = [];
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 806, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls.push(current.phase);
      progressMechanically(f.store, current);
    };
    await engine.wakeTask(task.id);
    f.store.update(task.id, { removedAt: new Date().toISOString() });
    await engine.quiesce();
    assert.deepEqual(calls, ['verifying']);
  } finally { await engine.stop(); f.close(); }
});

test('a thrown follow-up still settles multiple quiesce waiters', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  let calls = 0;
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 803, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls++;
      if (calls === 1) { f.store.update(current.id, { phase: 'merging' }); return; }
      throw new Error('follow-up failed');
    };
    await engine.wakeTask(task.id);
    await Promise.all([engine.quiesce(), engine.quiesce()]);
    assert.equal(calls, 2, 'both waiters settle after the follow-up faults');
  } finally { await engine.stop(); f.close(); }
});

test('quiesce from a lane waits for another task follow-up without self-deadlock', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({ createRun: async () => { throw new Error('No agent turn expected'); } }, f.root));
  const calls: string[] = [];
  try {
    f.store.setMeta('paused', false);
    const task = insertTask(f.store, 805, { phase: 'verifying' });
    engine.resolution.advance = async current => {
      calls.push(current.phase);
      progressMechanically(f.store, current);
    };
    await engine.wakeTask(task.id);
    assert.deepEqual(calls, ['verifying']);
    await engine.scheduleLane('control:quiesce', 0, async () => {
      await engine.quiesce();
      assert.deepEqual(calls, ['verifying', 'merging', 'syncing', 'closing']);
    });
  } finally { await engine.stop(); f.close(); }
});

test('a released reported worker wakes a waiting task in another project without a sweep', async () => {
  const f = tempStore();
  let workspaces = 0;
  const engine = new Engine(f.store, fakeAdapter({
    createWorkspace: async () => { workspaces++; return { id: 'next-ws', directory: join(f.root, 'next-ws') }; },
    createAgent: async () => ({ id: 'next-agent', workspaceId: 'next-ws' }),
    observe: async (id: string) => ({ id, workspaceId: id === 'finished-agent' ? 'finished-ws' : 'next-ws', status: 'idle', active: false, permissions: false, error: '' }),
  }));
  engine.profiles = [profile];
  f.store.setMeta('paused', false);
  f.store.setMeta('globalLimit', 1);
  f.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', roles: ['worker'], weight: 1, scopes: ['general'] }]);
  const finished = insertTask(f.store, 0);
  f.store.update(finished.id, { phase: 'working', workspaceId: 'finished-ws', agentId: 'finished-agent', agentIntent: true,
    runId: 'finished-run', agentActive: true, completion: { taskId: finished.id, runId: 'finished-run', eventId: 'finished-event', status: 'blocked', summary: 'Stopped' } });
  const dependency = insertTask(f.store, 3, { phase: 'blocked' });
  const dependent = insertTask(f.store, 1, { dependsOn: [dependency.id] });
  const waiting = insertTask(f.store, 2);
  engine.hooks.emit = async () => ({ hold: false, attention: false, records: [] });
  engine.hooks.reconcileTask = async () => ({ hold: false, attention: false, records: [] });
  try {
    await engine.wakeTask(finished.id);
    await engine.quiesce();
    assert.equal(f.store.task(finished.id).phase, 'blocked');
    assert.equal(workspaces, 1);
    assert.equal(f.store.task(dependent.id).phase, 'queued');
    assert.equal(f.store.task(waiting.id).phase, 'working');
  } finally { await engine.stop(); f.close(); }
});

test('sweep-observed release schedules the task and capacity waiter immediately', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter());
  f.store.setMeta('paused', false);
  const task = insertTask(f.store);
  const runId = 'reported-review';
  const completion = { taskId: task.id, runId, eventId: 'reported-review-event', status: 'changes_required' as const,
    summary: 'Fix the finding', head, reviewCommentId: 1, reviewResponsibility: 'author' as const };
  f.store.update(task.id, { phase: 'reviewing', resolution: { ...task.resolution, currentRunId: runId } });
  f.store.putRun({ id: runId, taskId: task.id, role: 'reviewer', generation: 1, head, base, agentId: 'reader', workspaceId: 'ws',
    profile, status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion, released: false });
  const lanes = engine as unknown as { scheduleLifecycleFollowUp: (id: string) => void; wakeCapacityWaiter: (id: string) => void };
  const taskWakes: string[] = [], capacityWakes: string[] = [];
  lanes.scheduleLifecycleFollowUp = id => { taskWakes.push(id); };
  lanes.wakeCapacityWaiter = id => { capacityWakes.push(id); };
  let advanced = false;
  engine.resolution.advance = async () => { advanced = true; };
  try {
    await engine.sweepOnce();
    assert.equal(f.store.run(runId)?.released, true);
    assert.ok(advanced || taskWakes.includes(task.id), "the sweep processes or schedules the released task");
    assert.ok(capacityWakes.includes(task.id));
  } finally { await engine.stop(); f.close(); }
});

test('timer wake queues behind its held task lane and quiesce waits', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({}, f.root));
  const task = insertTask(f.store, 901, { phase: 'verifying' });
  const held = gate();
  let wakeStarted = false, quiet = false;
  const internal = engine as unknown as { armGitTransient(id: string, at: number): void };
  engine.scheduleTaskQuantum = id => engine.scheduleLane(`task:${id}`, 1, () => { wakeStarted = true; });
  try {
    f.store.setMeta('paused', false);
    const lane = engine.scheduleLane(`task:${task.id}`, 1, async () => {
      internal.armGitTransient(task.id, Date.now());
      await held.promise;
    });
    await sleep(30);
    const quiescence = engine.quiesce().then(() => { quiet = true; });
    await sleep(30);
    assert.equal(wakeStarted, false, 'timer cannot enter the held lane');
    assert.equal(quiet, false, 'quiesce waits for the held lane and queued wake');
    held.open();
    await lane;
    await quiescence;
    assert.equal(wakeStarted, true);
  } finally { held.open(); await engine.stop(); f.close(); }
});

test('a queued control starts without the preceding quantum context', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({}, f.root));
  const held = gate();
  const internal = engine as unknown as { coordinatorActionRunId: import('node:async_hooks').AsyncLocalStorage<string> };
  let seen: string | undefined, externalSeen: string | undefined;
  const external = new AsyncLocalStorage<string>();
  try {
    const first = external.run('external', () => internal.coordinatorActionRunId.run('other-run', () =>
      engine.scheduleLane('task:context', 1, () => held.promise)));
    const second = engine.scheduleLane('task:context', 0, () => { seen = internal.coordinatorActionRunId.getStore(); externalSeen = external.getStore(); });
    held.open();
    await Promise.all([first, second]);
    await engine.quiesce();
    assert.equal(seen, undefined);
    assert.equal(externalSeen, undefined);
  } finally { held.open(); await engine.stop(); f.close(); }
});

test('quiesce waits for a timer wake after the original lane releases', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({}, f.root));
  const task = insertTask(f.store, 902, { phase: 'verifying' });
  const firstGate = gate(), wakeGate = gate(), wakeStarted = gate();
  const internal = engine as unknown as { armGitTransient(id: string, at: number): void };
  let quiet = false;
  engine.scheduleTaskQuantum = id => engine.scheduleLane(`task:${id}`, 1, async () => {
    wakeStarted.open();
    await wakeGate.promise;
  });
  try {
    f.store.setMeta('paused', false);
    const first = engine.scheduleLane(`task:${task.id}`, 1, async () => {
      internal.armGitTransient(task.id, Date.now());
      await firstGate.promise;
    });
    await sleep(30);
    firstGate.open();
    await first;
    await wakeStarted.promise;
    const quietPromise = engine.quiesce().then(() => { quiet = true; });
    await sleep(30);
    assert.equal(quiet, false, 'active timer work keeps quiesce pending');
    wakeGate.open();
    await quietPromise;
  } finally { firstGate.open(); wakeGate.open(); await engine.stop(); f.close(); }
});

test('quiesce waits for a wake still in its prelude, before the drain has a lane', async () => {
  const f = tempStore();
  const engine = new Engine(f.store, fakeAdapter({}, f.root));
  const inventory = gate();
  (engine as unknown as { archivePlannerGrants(): Promise<void> }).archivePlannerGrants = () => inventory.promise.then(() => {});
  let quiet = false;
  try {
    f.store.setMeta('paused', false);
    const wake = engine.wake();
    const quiescence = engine.quiesce().then(() => { quiet = true; });
    await sleep(30);
    assert.equal(quiet, false, 'a fire-and-forget wake is accepted work before its drain starts');
    inventory.open();
    await Promise.all([wake, quiescence]);
    assert.equal(quiet, true);
  } finally { inventory.open(); await engine.stop(); f.close(); }
});
