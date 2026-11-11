import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, digest, operationInputHash } from '../core/store/store';
import { Engine } from '../core/engine';
import { Admission, admitAdapter } from '../core/host/admission';
import { visibleTaskSummaries, taskSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { timingTest, performanceAssert } from './support/timing';
import { cpuTimeMs } from './support/cpu-time';

/**
 * Spec 012 responsiveness oracle.
 *
 * Deterministic fixture: 250 tasks, 50,000 lifecycle facts, 32 active task
 * lanes with delayed provider/Git fakes and one repository whose remote effect
 * is a genuine five-second sleep. There is no global lane cap, so every active
 * lane runs at once; the real resource bound is the operator Paseo-call limit
 * on the admitted adapter. The oracle measures durable control acceptance,
 * operation reads, compact UI snapshot reads, event-loop lag and
 * unrelated-control isolation, then proves saturation backpressure and restart
 * reconciliation exactly once from the same durable state.
 */
const TASK_COUNT = 250;
const EVENTS_PER_TASK = 200;
const FACT_COUNT = TASK_COUNT * EVENTS_PER_TASK;
const ACTIVE_LANES = 32;
/** The operator's concurrent-Paseo-call bound the fixture exercises (Spec 012). */
const PASEO_CALL_BOUND = 2;
/** A remote effect that stays in flight for any measurement window (well past the spec's five-second floor); the test's gate ends it. */
const SLOW_EFFECT_MS = 600_000;
const ACCEPTANCE_SAMPLES = 120;
const READ_SAMPLES = 120;
const SNAPSHOT_SAMPLES = 40;
const OBSERVE_MS = 120;
const SLOW_REPO = '/oracle-slow';
const FAST_REPOS = ['/oracle-alpha', '/oracle-beta', '/oracle-gamma'];
const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function startCpuSliceMonitor(intervalMs = 10) {
  const samples: number[] = [];
  let previous = process.cpuUsage();
  const timer = setInterval(() => { samples.push(cpuTimeMs(previous)); previous = process.cpuUsage(); }, intervalMs);
  return { stop: () => { clearInterval(timer); return samples; } };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface Fixture {
  directory: string; path: string; store: Store; engine: Engine;
  active: Task[]; queued: Task[]; slowTask: Task;
  observations: () => number;
  blocked: () => number;
  release: () => void;
  closeStore: () => void;
}

function buildFixture(): Fixture {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'nsq-oracle-')));
  const path = join(directory, 'queue.sqlite');
  const store = new Store(path);
  store.setMeta('hostId', 'oracle-host'); // Queue #912: register the task fixture's host before operations route.
  const start = Date.parse('2026-08-01T00:00:00.000Z');
  const iso = (value: number) => new Date(start + value).toISOString();
  const insertTask = store.db.prepare('INSERT INTO tasks VALUES(?,?,?,?)');
  const insertEvent = store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)');
  const active: Task[] = [], queued: Task[] = [], done: Task[] = [];
  store.transaction(() => {
    for (let index = 0; index < TASK_COUNT; index++) {
      const id = `oracle-task-${index}`;
      // 32 tasks own an active worker lane, the next batch waits for a
      // pre-dispatch control, the remainder is retained terminal history.
      const lane = index < ACTIVE_LANES ? 'active' : index < ACTIVE_LANES + 160 ? 'queued' : 'done';
      const repoPath = lane === 'active' && index === 0 ? SLOW_REPO : FAST_REPOS[index % FAST_REPOS.length];
      const created = index * 90_000;
      const task = taskSchema.parse({
        submissionId: `oracle-${index}`, title: `Oracle task ${index}`, repoPath, scope: (['general', 'mechanical', 'complex'] as const)[index % 3],
        planningCommit: 'a'.repeat(40), handoffPath: `docs/handoffs/oracle-${index}.md`, originAgentId: 'oracle-origin',
        id, hostId: 'oracle-host', hostSelection: { hostId: 'oracle-host', basis: 'sole_online_host' }, createdAt: iso(created), updatedAt: iso(created + 60_000), version: 2,
        phase: lane === 'active' ? 'working' : lane === 'queued' ? 'queued' : 'done',
        reason: lane === 'active' ? 'Worker running' : lane === 'queued' ? 'Waiting for dispatch' : 'Done',
        held: false, handoffText: `handoff-${index}`, planningBase: 'a'.repeat(40),
        workspaceId: lane === 'active' ? `workspace-${index}` : null, directory: lane === 'active' ? '/oracle' : null,
        branch: `ns-${id}`, agentId: lane === 'active' ? `agent-${id}` : null, runId: lane === 'active' ? `run-${id}` : null,
        profile: lane === 'active' ? profile : null, profileGroup: lane === 'active' ? 'test' : null,
        workspaceIntent: lane === 'active', agentIntent: lane === 'active', lastAgentStatus: lane === 'active' ? 'running' : null,
        idleSince: null, completion: null, agentActive: lane === 'active' ? true : null,
        lastObservedAt: lane === 'active' ? iso(created + 60_000) : null, prUrl: null, prHead: null, coordinatorGeneration: 1,
      });
      insertTask.run(id, task.submissionId, digest(`oracle-${index}`), JSON.stringify(task));
      insertEvent.run(id, iso(created), 'submitted', 'Oracle fixture');
      for (let event = 1; event < EVENTS_PER_TASK; event++) {
        insertEvent.run(id, iso(created + event * 1_000), 'state', `oracle fact ${index}:${event} ${'x'.repeat(160)}`);
      }
      if (lane === 'active') active.push(task); else if (lane === 'queued') queued.push(task); else done.push(task);
    }
  });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  let observations = 0;
  let blocked = 0;
  let resolveHold: (() => void) | null = null;
  let resolveSlow: (() => void) | null = null;
  const holdGate = new Promise<void>(resolve => { resolveHold = resolve; });
  const slowGate = new Promise<void>(resolve => { resolveSlow = resolve; });
  // Every other active task lane holds its remote observation for the whole
  // measurement window; the slow repository holds a genuine five-second effect.
  // There is no global lane cap (Spec 012), so all of them are in flight at once.
  const heldAgents = new Set(active.slice(1).map(task => task.agentId!));
  const slowAgent = active[0].agentId!;
  const adapter: Adapter = {
    profiles: async () => [profile],
    observe: async (id: string) => {
      observations++;
      blocked++;
      try {
        if (id === slowAgent) await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, SLOW_EFFECT_MS);
          void slowGate.then(() => { clearTimeout(timer); resolve(); });
        });
        else if (heldAgents.has(id)) await holdGate;
        else await sleep(OBSERVE_MS);
      } finally { blocked--; }
      return { id, workspaceId: `workspace-${id}`, status: 'idle', active: false, permissions: false, error: '' };
    },
    archiveAgent: async () => {},
    archiveTaskWorkspace: async () => true,
  } as unknown as Adapter;
  // Production shape: every outbound Paseo call passes through the operator
  // Paseo-call bound. Lanes are unbounded, so this admission is the resource
  // bound that keeps the fixture's measurement window short and the event loop
  // free while a five-second effect is in flight.
  store.setMeta('paseoCallLimit', PASEO_CALL_BOUND);
  const admission = new Admission({ totalLimit: () => store.configuredPaseoCallLimit(), startIntervalMs: 0, observationCacheMs: 0 });
  const engine = new Engine(store, admitAdapter(adapter, admission), 60000);
  engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  // Pause dispatch so the fixture measures bounded reconciliation rather than
  // workspace creation; every active lane still performs its delayed remote
  // observation through the provider fake.
  store.setMeta('paused', true);
  return {
    directory, path, store, engine, active, queued, slowTask: active[0],
    observations: () => observations,
    blocked: () => blocked,
    release: () => { resolveHold?.(); resolveSlow?.(); },
    closeStore: () => store.close(),
  };
}

const opened = (value: { accepted: true; operation: { id: string } } | { backpressured: true; reason: string }) => {
  if (!('accepted' in value)) throw new Error(`Expected acceptance, received backpressure: ${value.reason}`);
  return value.operation;
};
const cancelPayload = (task: Task, reason: string) => ({
  type: 'task_control' as const,
  control: { taskId: task.id, version: task.version, action: 'cancel' as const, reason, workDisposition: 'preserve' as const },
});
const waitFor = async (predicate: () => boolean, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(5); }
  return predicate();
};

timingTest('the 250-task fixture meets the Spec 012 responsiveness oracle', async () => {
  const f = buildFixture();
  let engine: Engine | undefined = f.engine;
  let store = f.store;
  try {
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, TASK_COUNT);
    const facts = Number(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n);
    assert.ok(facts >= 50_000, `fixture must carry at least 50,000 lifecycle facts, measured ${facts}`);
    assert.equal(f.active.length, ACTIVE_LANES);

    // One repository holds a genuine five-second remote effect inside its
    // disposition lane. The gate only shortens the wait once measurement ends.
    const slow = await engine.startOperation({ key: 'oracle-slow-effect', kind: 'task_control', payload: cancelPayload(f.slowTask, 'Oracle slow repository effect') });
    assert.ok(await waitFor(() => store.operation(opened(slow).id)?.state === 'running'), 'the slow repository effect must be in flight');

    // 32 active task lanes with delayed provider fakes. There is no global lane
    // cap, so every lane enters at once; the admitted adapter's Paseo-call bound
    // caps how many remote effects are in flight, and the rest wait there rather
    // than for a lane slot.
    const lanes = f.active.map(task => engine!.scheduleTaskQuantum(task.id).catch(() => {}));
    assert.ok(await waitFor(() => f.blocked() >= PASEO_CALL_BOUND), 'the task lanes and the slow repository effect must be in flight');
    const observationsBefore = f.observations();

    // The oracle measures latency, not admission capacity, so the acceptance
    // samples run above the default bound; saturation is proved explicitly below.
    store.setMeta('operationLimit', 256);
    const cpuSlices = startCpuSliceMonitor();
    const acceptances: number[] = [];
    const acceptedIds: string[] = [];
    for (let index = 0; index < ACCEPTANCE_SAMPLES; index++) {
      const task = f.queued[index];
      const started = process.cpuUsage();
      const acceptance = await engine.startOperation({ key: `oracle-accept-${index}`, kind: 'task_control', payload: cancelPayload(task, `Oracle acceptance ${index}`) });
      acceptances.push(cpuTimeMs(started));
      acceptedIds.push(opened(acceptance).id);
      // Each acceptance is its own event-loop turn, exactly like the read loop
      // below: the accepted quanta must get a turn without the sampling loop
      // starving the monitor or the delayed provider fakes.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const reads: number[] = [];
    for (let index = 0; index < READ_SAMPLES; index++) {
      const started = process.cpuUsage();
      engine.operationStatus(acceptedIds[index % acceptedIds.length]);
      reads.push(cpuTimeMs(started));
      // Each real read is its own event-loop turn; yield so the monitor and the
      // delayed provider fakes are not starved by the sampling loop itself.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const snapshots: number[] = [];
    for (let index = 0; index < SNAPSHOT_SAMPLES; index++) {
      const started = process.cpuUsage();
      const summaries = visibleTaskSummaries(store.tasks());
      // The compact UI snapshot also reads the bounded unfinished-operation page.
      store.operations({ states: ['pending', 'running', 'needs_attention', 'failed'], limit: 100 });
      snapshots.push(cpuTimeMs(started));
      assert.ok(summaries.length <= TASK_COUNT);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    // Keep the workload live long enough for a meaningful event-loop sample set.
    await sleep(400);
    const cpuSliceSamples = cpuSlices.stop();

    const acceptanceCpuP95 = percentile(acceptances, 0.95);
    const acceptanceMaxCpuMs = Math.max(...acceptances);
    const readCpuP95 = percentile(reads, 0.95);
    const snapshotCpuP95 = percentile(snapshots, 0.95);
    const cpuSliceP95 = percentile(cpuSliceSamples, 0.95);

    assert.equal(f.observations(), observationsBefore, 'the held lanes stay in flight throughout the measurement window');
    assert.ok(f.blocked() <= PASEO_CALL_BOUND, `the Paseo-call bound must cap blocked remote effects at ${PASEO_CALL_BOUND}, observed ${f.blocked()}`);
    assert.equal(store.operation(opened(slow).id)?.state, 'running', 'the slow repository effect stays unresolved throughout');
    performanceAssert(acceptanceCpuP95 <= 100, `control acceptance p95 ${acceptanceCpuP95.toFixed(1)} ms exceeds 100 ms`);
    performanceAssert(acceptanceMaxCpuMs <= 150, `unrelated control acceptance max ${acceptanceMaxCpuMs.toFixed(1)} ms exceeds 150 ms while another repository holds a five-second effect`);
    performanceAssert(readCpuP95 <= 100, `operation-status read p95 ${readCpuP95.toFixed(1)} ms exceeds 100 ms`);
    performanceAssert(snapshotCpuP95 <= 100, `compact snapshot read p95 ${snapshotCpuP95.toFixed(1)} ms exceeds 100 ms`);
    assert.ok(cpuSliceSamples.length >= 5, `event-loop monitor collected only ${cpuSliceSamples.length} samples`);
    performanceAssert(cpuSliceP95 < 100, `event-loop CPU p95 ${cpuSliceP95.toFixed(1)} ms exceeds 100 ms`);
    assert.equal(lanes.length, ACTIVE_LANES);

    // Saturation proves a typed backpressure response instead of a transport
    // timeout, and it arrives promptly.
    store.db.prepare('DELETE FROM meta WHERE key=?').run('operationLimit');
    const backlog = store.operationBacklog();
    assert.ok(backlog > 0, 'the fixture must have unfinished operations for the saturation case');
    store.setMeta('operationLimit', backlog);
    const saturatedStart = process.cpuUsage();
    const saturated = await engine.startOperation({ key: 'oracle-saturated', kind: 'task_control', payload: cancelPayload(f.queued[ACCEPTANCE_SAMPLES], 'Oracle saturation') });
    const saturatedCpuMs = cpuTimeMs(saturatedStart);
    assert.ok('backpressured' in saturated);
    assert.equal(saturated.pending, backlog);
    assert.ok(saturated.retryAfterMs > 0);
    performanceAssert(saturatedCpuMs <= 150, `typed backpressure took ${saturatedCpuMs.toFixed(1)} ms`);
    store.db.prepare('DELETE FROM meta WHERE key=?').run('operationLimit');

    // Restart clause: one accepted-but-unrun command survives shutdown and is
    // reconciled exactly once from its durable identity on the same fixture.
    const restartTask = f.queued[ACCEPTANCE_SAMPLES + 1];
    const restartPayload = cancelPayload(restartTask, 'Oracle restart reconciliation');
    // The fixture deliberately carries a large unfinished backlog; raise the
    // admission bound only to place this one durable record.
    store.setMeta('operationLimit', 256);
    const durable = store.acceptOperation({ key: 'oracle-restart', kind: 'task_control', inputHash: operationInputHash(restartPayload), taskId: restartTask.id, expectedVersion: restartTask.version,
      hostId: restartTask.hostId, hostSelection: restartTask.hostSelection, payload: restartPayload });
    store.db.prepare('DELETE FROM meta WHERE key=?').run('operationLimit');
    assert.ok('accepted' in durable);
    assert.equal(durable.operation.state, 'pending');
    f.release();
    const stopStarted = process.cpuUsage();
    await engine.stop();
    performanceAssert(cpuTimeMs(stopStarted) < 3_000, 'engine.stop() must be bounded even with queued lanes');

    engine = undefined;
    f.closeStore();
    store = new Store(f.path);
    const resumedCalls = { observations: 0 };
    const resumedAdapter = {
      observe: async (id: string) => { resumedCalls.observations++; return { id, workspaceId: 'workspace', status: 'idle', active: false, permissions: false, error: '' }; },
      archiveAgent: async () => {}, archiveTaskWorkspace: async () => true,
    } as unknown as Adapter;
    const resumed = new Engine(store, resumedAdapter, 60000);
    resumed.profiles = [profile];
    resumed.resumeOperations();
    await resumed.quiesce();
    const resumedOperation = store.operation(durable.operation.id);
    assert.equal(resumedOperation?.state, 'succeeded', `restart did not reconcile the accepted operation: ${resumedOperation?.diagnostic ?? 'missing operation'}`);
    assert.equal(store.task(restartTask.id).phase, 'cancelled');
    const completed = store.eventsAll(restartTask.id).filter(event => event.kind === 'disposition_complete');
    assert.equal(completed.length, 1, 'restart must reconcile the accepted command exactly once');
    for (const operation of store.operations({ limit: 200 })) {
      assert.ok(['succeeded', 'failed', 'needs_attention'].includes(operation.state), `operation ${operation.key} left ${operation.state}`);
    }
    for (const task of store.tasks()) {
      const transitions = store.eventsAll(task.id).filter(event => event.kind === 'disposition_complete').length;
      assert.ok(transitions <= 1, `task ${task.id} reached terminal disposition ${transitions} times`);
    }
    await resumed.stop();
  } finally {
    f.release();
    await engine?.stop().catch(() => {});
    try { f.closeStore(); } catch { /* already closed by the restart clause */ }
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('the durable operation record keeps the fixture identity under the oracle workload', async () => {
  const f = buildFixture();
  try {
    const task = f.queued[0];
    const payload = cancelPayload(task, 'Oracle identity');
    const first = await f.engine.startOperation({ key: 'oracle-identity', kind: 'task_control', payload, taskId: task.id, expectedVersion: task.version });
    const replay = await f.engine.startOperation({ key: 'oracle-identity', kind: 'task_control', payload, taskId: task.id, expectedVersion: task.version });
    assert.equal(opened(replay).id, opened(first).id);
    assert.equal(storeOperationCount(f.store), 1);
    await assert.rejects(
      f.engine.startOperation({ key: 'oracle-identity', kind: 'task_control', payload: cancelPayload(task, 'Different input'), taskId: task.id, expectedVersion: task.version }),
      /different input/,
    );
    await f.engine.awaitOperation(opened(first).id);
    assert.equal(f.store.operation(opened(first).id)?.state, 'succeeded');
  } finally {
    f.release();
    await f.engine.stop();
    f.closeStore();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

function storeOperationCount(store: Store) { return store.operations({ limit: 50 }).length; }
