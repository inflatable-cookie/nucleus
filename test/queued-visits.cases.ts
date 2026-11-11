import { fakeAdapter, createTaskAgent } from './support/fakes';
import { test, weighted } from './support/sharded-test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine, queuedDispatchOrder } from '../core/engine';
import { QUEUED_VISIT_MARGIN } from '../core/dispatch/capacity';
import { QueueRuntime } from '../service/runtime-owner';
import { holdPatch } from '../core/merge/merge-hold';
import { holdsOf } from '../shared/contracts';
import { submissionSchema } from '../shared/contracts';
import type { Profile } from '../shared/contracts';
import type { Adapter } from '../core/host';

/** Tom, 2026-11-06: "The number of queued tasks shouldn't make a difference". */
const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-queued-visits-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const adapter: Adapter = fakeAdapter({
    catalog: async () => ({ providers: [] }), validate: async t => t.planningCommit,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/fixture' }),
     verifyWorkspace: async t => t.branch,
    createAgent: createTaskAgent,
    observe: async id => ({ id, workspaceId: `ws-${id.slice(6)}`, status: 'running', active: true, permissions: false, error: '' }),
     archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'a'.repeat(40) }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  store.setMeta('paused', false); store.setMeta('globalLimit', 16); store.setMeta('projectLimit', 2);
  const add = (repoPath = '/project-a', dependsOn: string[] = [], lanes: string[] = []) => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath, dependsOn, lanes,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
  const visits: string[] = [];
  const internals = engine as unknown as { dispatchTask(id: string, held: boolean): Promise<void>; dispatchQueued(repo?: string): Promise<void> };
  const dispatchTask = internals.dispatchTask.bind(engine);
  internals.dispatchTask = (id, held) => { visits.push(id); return dispatchTask(id, held); };
  return { dir, store, engine, add, visits, pass: () => internals.dispatchQueued(), close: async () => { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function visitsWith(queued: number) {
  const f = fixture();
  try {
    f.store.transaction(() => { for (let i = 0; i < queued; i++) f.add(); });
    await f.pass();
    return f.visits.length;
  } finally { await f.close(); }
}

weighted(4)('a dispatch pass visits the same number of tasks with 10 queued as with 300', async () => {
  const small = await visitsWith(10), large = await visitsWith(300);
  assert.equal(large, small, `${large} visits with 300 queued against ${small} with 10`);
  assert.ok(large <= 2 + QUEUED_VISIT_MARGIN, `${large} visits for a limit of 2`);
});

weighted(2)('the oldest queued tasks start, and a full project costs only its margin', async () => {
  const f = fixture();
  try {
    const tasks = f.store.transaction(() => Array.from({ length: 30 }, () => f.add()));
    await f.pass();
    assert.deepEqual(tasks.filter(t => f.store.task(t.id).phase !== 'queued').map(t => t.id), tasks.slice(0, 2).map(t => t.id));
    f.visits.length = 0;
    await f.pass();
    assert.ok(f.visits.filter(id => f.store.task(id).phase === 'queued').length <= QUEUED_VISIT_MARGIN, 'no free slot means only the next in line');
  } finally { await f.close(); }
});

weighted(2)('a second project still gets its turn behind a long queue', async () => {
  const f = fixture();
  try {
    f.store.transaction(() => { for (let i = 0; i < 50; i++) f.add('/project-a'); });
    const other = f.add('/project-b');
    await f.pass();
    assert.notEqual(f.store.task(other.id).phase, 'queued');
  } finally { await f.close(); }
});

test('a head behind a prerequisite takes no place and starts when released', async () => {
  const f = fixture();
  try {
    const parent = f.add('/parent');
    const waiting = Array.from({ length: 10 }, () => f.add('/project-a', [parent.id]));
    const free = f.add('/project-a');
    f.store.setMeta('dispatchHeld', false);
    await f.pass();
    assert.notEqual(f.store.task(free.id).phase, 'queued', 'tasks behind a wait do not block the one that can start');
    for (const task of waiting) assert.match(f.store.dependencyWait(f.store.task(task.id)), /prerequisite/i);
    f.visits.length = 0;
    await f.pass();
    assert.equal(f.visits.filter(id => waiting.some(task => task.id === id)).length, 0, 'a prerequisite wait costs no visit');
    f.store.update(parent.id, { phase: 'done' });
    f.visits.length = 0;
    await f.pass();
    assert.ok(f.visits.includes(waiting[0].id), 'a finished prerequisite puts the dependent back at the front');
  } finally { await f.close(); }
});

test('a dispatch-held head does not consume a visit or block the next task', async () => {
  const f = fixture();
  try {
    const held = f.add(), next = f.add();
    f.store.update(held.id, holdPatch(f.store.task(held.id), 'dispatch', 'operator', 'Wait'));
    await f.pass();
    assert.equal(f.visits.includes(held.id), false);
    assert.equal(f.store.task(held.id).phase, 'queued');
    assert.notEqual(f.store.task(next.id).phase, 'queued');
  } finally { await f.close(); }
});

test('a parked review with no eligible route does not reserve the free slot', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 1);
    const parked = f.add('/project-b');
    f.store.update(parked.id, { phase: 'awaiting_review', reason: 'No eligible independent reviewer profile' });
    const next = f.add();
    assert.equal(f.engine.resolution.slotAdmissionReason(f.store.task(next.id)), '');
    await f.pass();
    assert.notEqual(f.store.task(next.id).phase, 'queued');
  } finally { await f.close(); }
});

test('free slots start together, not one workspace at a time', async () => {
  const f = fixture();
  try {
    const adapter = (f.engine as unknown as { adapter: Adapter }).adapter;
    const create = adapter.createWorkspace!.bind(adapter);
    let inFlight = 0, most = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    adapter.createWorkspace = async (...args: Parameters<typeof create>) => {
      most = Math.max(most, ++inFlight);
      if (most >= 2) release();
      await Promise.race([gate, new Promise(resolve => setTimeout(resolve, 3000))]);
      inFlight--;
      return create(...args);
    };
    for (let i = 0; i < 6; i++) f.add();
    await f.pass();
    assert.equal(most, 2, 'both free slots were creating workspaces at once');
    assert.equal(f.store.admissionCandidates().filter(t => t.phase !== 'queued').length, 2, 'capacity still holds at the project limit');
  } finally { await f.close(); }
});

test('settling a prerequisite wakes its dependent without a sweep', async () => {
  const f = fixture();
  try {
    const parent = f.add('/parent');
    const child = f.add('/project-a', [parent.id]);
    let wake: Promise<void> | undefined;
    let signalled!: () => void;
    const signalledWake = new Promise<void>(resolve => { signalled = resolve; });
    const original = f.engine.wakeRepository.bind(f.engine);
    f.engine.wakeRepository = repo => { wake = original(repo); signalled(); return wake; };
    assert.throws(() => f.store.transaction(() => {
      f.store.update(parent.id, { phase: 'done' });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(wake, undefined, 'rolled back settlements do not wake work');
    f.store.update(parent.id, { phase: 'done' });
    await signalledWake;
    assert.ok(wake, 'committed settlement wakes its dependent repository');
    await wake;
    assert.notEqual(f.store.task(child.id).phase, 'queued');
  } finally { await f.close(); }
});

test('ready queue heads skip prerequisites and unavailable routes and keep priority order', async () => {
  const f = fixture();
  try {
    const parent = f.add('/parent');
    const blocked = f.add('/project-a', [parent.id]);
    const unavailable = f.add('/project-a');
    f.store.update(unavailable.id, { reason: 'No eligible worker profile' });
    f.store.markRoutingAttempt(unavailable.id);
    const first = f.add('/project-a'), second = f.add('/project-a');
    assert.deepEqual(f.store.readyQueueHeads(1, '/project-a').map(t => t.id), [first.id]);
    f.store.update(second.id, { queuePriority: 1 });
    assert.deepEqual(queuedDispatchOrder(f.store.readyQueueHeads(2, '/project-a')).map(t => t.id), [second.id, first.id]);
    f.engine.wakeRepository = async () => {};
    f.store.update(parent.id, { phase: 'done' });
    assert.deepEqual(queuedDispatchOrder(f.store.readyQueueHeads(3, '/project-a')).map(t => t.id), [second.id, blocked.id, first.id]);
  } finally { await f.close(); }
});

test('bounded heads retain fair project rotation and started work under board hold', async () => {
  const f = fixture();
  try {
    const old = f.add('/project-a');
    const other = f.add('/project-b');
    const urgent = f.add('/project-a');
    f.store.update(urgent.id, { queuePriority: 5, workspaceIntent: true });
    const full = queuedDispatchOrder(f.store.admissionCandidates());
    const bounded = queuedDispatchOrder(f.store.readyQueueHeads(1));
    assert.deepEqual(bounded.slice(0, 2).map(t => t.id), full.slice(0, 2).map(t => t.id));
    assert.deepEqual(f.store.readyQueueHeads(1, undefined, true).map(t => t.id), [urgent.id]);
    assert.equal(f.store.readyQueueHeads(0).length, 0);
    assert.ok(full.some(task => task.id === old.id) && full.some(task => task.id === other.id));
  } finally { await f.close(); }
});


test('route waits are retried once when the routing epoch changes', async () => {
  const f = fixture();
  try {
    const task = f.add();
    f.store.setRoutingEpoch('first');
    f.store.update(task.id, { reason: 'No eligible worker profile' });
    f.store.markRoutingAttempt(task.id);
    assert.equal(f.store.readyQueueHeads(2).length, 0);
    f.store.setRoutingEpoch('first');
    assert.equal(f.store.readyQueueHeads(2).length, 0);
    f.store.setRoutingEpoch('second');
    assert.deepEqual(f.store.readyQueueHeads(2).map(item => item.id), [task.id]);
    f.store.markRoutingAttempt(task.id);
    assert.equal(f.store.readyQueueHeads(2).length, 0);
    f.store.update(task.id, { preferredProfileId: 'changed-profile' });
    assert.deepEqual(f.store.readyQueueHeads(2).map(item => item.id), [task.id]);
  } finally { await f.close(); }
});


test('routing epochs notice catalog, pool, subscription, usage and demand changes', async () => {
  const scenarios: Array<{ name: string; before?: (f: ReturnType<typeof fixture>) => void; change: (f: ReturnType<typeof fixture>) => void }> = [
    { name: 'catalog', change: f => { f.engine.profiles = [{ ...profile, problem: 'changed' }]; } },
    { name: 'pool', change: f => f.store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 2, scopes: ['general'] }]) },
    { name: 'subscription expiry', before: f => { f.store.db.prepare('INSERT INTO availability VALUES(?,?)').run('test', JSON.stringify({ group: 'test', unavailable: true, reason: 'limit', retryAt: '2999-01-01T00:00:00.000Z' })); },
      change: f => { f.store.db.prepare('UPDATE availability SET data=? WHERE group_id=?').run(JSON.stringify({ group: 'test', unavailable: true, reason: 'limit', retryAt: '2000-01-01T00:00:00.000Z' }), 'test'); } },
    { name: 'usage expiry', before: f => f.store.setMeta('usageLevel', { level: 'high', until: '2999-01-01T00:00:00.000Z', setAt: new Date().toISOString() }),
      change: f => f.store.setMeta('usageLevel', { level: 'high', until: '2000-01-01T00:00:00.000Z', setAt: new Date().toISOString() }) },
    { name: 'demand offsets', change: f => f.store.setMeta('demandRoleOffsets', { worker: 1, reviewer: 0, coordinator: -2 }) },
  ];
  for (const scenario of scenarios) {
    const f = fixture();
    try {
      scenario.before?.(f);
      const task = f.add();
      f.store.update(task.id, { reason: 'No eligible worker profile' });
      const internal = f.engine as unknown as { dispatchTask(id: string, held: boolean): Promise<void> };
      const seen: string[] = [];
      internal.dispatchTask = async id => { seen.push(id); };
      await f.pass();
      f.store.markRoutingAttempt(task.id);
      seen.length = 0;
      await f.pass();
      assert.deepEqual(seen, [], `${scenario.name}: unchanged inputs stay parked`);
      scenario.change(f);
      await f.pass();
      assert.deepEqual(seen, [task.id], `${scenario.name}: changed inputs recheck the task`);
    } finally { await f.close(); }
  }
});

test('two projects share two free slots in fair order', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 2);
    const a = Array.from({ length: 8 }, () => f.add('/project-a'));
    const b = Array.from({ length: 8 }, () => f.add('/project-b'));
    await f.pass();
    assert.deepEqual(a.filter(task => f.store.task(task.id).phase !== 'queued').map(task => task.id), [a[0].id]);
    assert.deepEqual(b.filter(task => f.store.task(task.id).phase !== 'queued').map(task => task.id), [b[0].id]);
  } finally { await f.close(); }
});

test('timed holds stay off the bounded board until due', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 0);
    const tasks = Array.from({ length: 12 }, () => f.add());
    for (const task of tasks) f.store.update(task.id, holdPatch(task, 'dispatch', 'owner', 'Wait', { kind: 'time', at: '2999-01-01T00:00:00.000Z' }));
    assert.equal(f.store.boardTasks(5).length, 5);
    assert.equal(f.store.dueHoldTasks().length, 0);
    const expired = f.store.task(tasks[0].id);
    f.store.update(expired.id, holdPatch(expired, 'dispatch', 'owner', 'Wait', { kind: 'time', at: '2000-01-01T00:00:00.000Z' }));
    assert.deepEqual(f.store.dueHoldTasks().map(task => task.id), [expired.id]);
    await f.engine.sweepOnce();
    assert.equal(holdsOf(f.store.task(expired.id)).dispatch, undefined);
  } finally { await f.close(); }
});

test('a settled hold target wakes and releases its queued dependent', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 0);
    const parent = f.add('/parent'), child = f.add();
    f.store.update(child.id, holdPatch(child, 'dispatch', 'owner', 'Wait', { kind: 'task', taskId: parent.id }));
    f.store.update(parent.id, { phase: 'done' });
    await f.engine.quiesce();
    assert.equal(holdsOf(f.store.task(child.id)).dispatch, undefined);
    assert.equal(f.store.task(child.id).phase, 'queued');
  } finally { await f.close(); }
});

test('a route-unavailable head is set aside and the next ready task starts', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 1);
    const blocked = f.add(), ready = f.add();
    f.store.update(blocked.id, { workerExclusions: [{ agentId: null, profileId: profile.id, reason: 'Excluded for this task', createdAt: new Date().toISOString() }] });
    await f.pass();
    await f.engine.quiesce();
    assert.equal(f.store.task(blocked.id).phase, 'queued');
    assert.match(f.store.task(blocked.id).reason, /No eligible/);
    assert.notEqual(f.store.task(ready.id).phase, 'queued');
  } finally { await f.close(); }
});

test('a freed slot wakes the ready head past a route-unavailable task', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 1);
    const blocked = f.add(), ready = f.add();
    f.store.update(blocked.id, { reason: 'No eligible worker profile' });
    f.store.markRoutingAttempt(blocked.id);
    (f.engine as unknown as { wakeCapacityWaiter(id: string): void }).wakeCapacityWaiter('released');
    await f.engine.quiesce();
    assert.notEqual(f.store.task(ready.id).phase, 'queued');
    assert.equal(f.store.task(blocked.id).phase, 'queued');
  } finally { await f.close(); }
});

test('a full normal pool does not hide the papercut head', async () => {
  const f = fixture();
  try {
    f.store.setMeta('globalLimit', 2); f.store.setMeta('projectLimit', 1);
    const active = f.add();
    f.store.update(active.id, { phase: 'working', agentActive: true });
    for (let i = 0; i < 10; i++) f.add();
    const cut = f.add();
    f.store.update(cut.id, { papercutTask: true });
    await f.pass();
    assert.notEqual(f.store.task(cut.id).phase, 'queued');
  } finally { await f.close(); }
});

weighted(8)('dispatch and board work stay bounded at 10 and 1000 queued tasks', async () => {
  async function measure(size: number) {
    const f = fixture();
    const adapter = (f.engine as unknown as { adapter: Adapter }).adapter;
    Object.assign(adapter, { socketPath: join(f.dir, 'callback.sock'), helperPath: join(f.dir, 'helper.mjs'), hostId: 'fixture',
      client: { isConnected: true }, connect: async () => {} });
    await f.engine.stop(); f.store.close();
    const runtime = new QueueRuntime({ dataDir: f.dir, hostRunStateDir: join(f.dir, 'host-runs'), timers: false, adapterFactory: () => adapter });
    const lifecycle = runtime as unknown as { started: Promise<void>; bootstrap: Promise<void> | null };
    await lifecycle.started;
    if (lifecycle.bootstrap) await lifecycle.bootstrap;
    assert.equal(runtime.startError, '', 'the isolated runtime started cleanly');
    const store = runtime.store, engine = runtime.engine;
    engine.profiles = [profile];
    store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
    store.setMeta('paused', false); store.setMeta('projectLimit', 2);
    const add = (repoPath: string, lanes: string[] = []) => store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath, lanes,
      planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'fixture', 'handoff', 'a'.repeat(40)); // Queue #912: the adapter's host
    const visits: string[] = [];
    const internal = engine as unknown as { dispatchTask(id: string, held: boolean): Promise<void>; dispatchQueued(): Promise<void> };
    const dispatch = internal.dispatchTask.bind(engine);
    internal.dispatchTask = (id, held) => { visits.push(id); return dispatch(id, held); };
    try {
      store.setMeta('globalLimit', 1);
      store.upsertLane({ key: 'scale', title: 'Scale', aim: 'Scale fixture', repositories: [{ origin: 'example/project-a', path: '/project-a' }] });
      const done = add('/history'); store.update(done.id, { phase: 'done' });
      const active = add('/active'); store.update(active.id, { phase: 'working' });
      const queued = add('/project-a', ['scale']);
      const insertTask = store.db.prepare('INSERT INTO tasks(id,submission,input_hash,data) VALUES(?,?,?,?)');
      store.transaction(() => {
        for (let i = 0; i < 999; i++) {
          const id = `hist-${i}`;
          insertTask.run(id, id, id, JSON.stringify({ ...done, id, submissionId: id, phase: 'done' }));
        }
        for (let i = 0; i < 7; i++) {
          const id = `work-${i}`;
          insertTask.run(id, id, id, JSON.stringify({ ...active, id, submissionId: id, phase: 'working' }));
        }
        for (let i = 0; i < size - 1; i++) {
          const id = `queued-${i}`;
          insertTask.run(id, id, id, JSON.stringify({ ...queued, id, submissionId: id }));
        }
      });
      // SQL clones bypass the write funnel, so rebuild the projection (and ready/board
      // indexes) before the spy. Dispatch and board then stay on the indexed path.
      void store.tasks();
      runtime.uiSnapshot({}); // warm the same board path the service publishes
      store.advanceRevision();
      const counters = { reads: 0, writes: 0 };
      let materialized = 0;
      const allTasks = store.tasks.bind(store);
      store.tasks = () => { const rows = allTasks(); materialized += rows.length; return rows; };
      const db = store.db;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const stmt = prepare(sql);
        return new Proxy(stmt, { get(target, name) {
          const member = Reflect.get(target, name, target);
          if (typeof member !== 'function') return member;
          if (name === 'get' || name === 'all' || name === 'iterate') return (...args: unknown[]) => { counters.reads++; return member.apply(target, args); };
          if (name === 'run') return (...args: unknown[]) => { counters.writes++; return member.apply(target, args); };
          return member.bind(target);
        } });
      }) as typeof db.prepare;
      const dispatchAt = performance.now();
      await internal.dispatchQueued();
      const dispatchMs = performance.now() - dispatchAt;
      const boardAt = performance.now();
      const board = runtime.uiSnapshot({});
      const boardMs = performance.now() - boardAt;
      db.prepare = prepare;
      if ('unchanged' in board) throw new Error('Expected a full board');
      return { ...counters, visits: visits.length, boardWork: board.tasks.length + materialized, count: board.queuedCounts?.find(item => item.repoPath === '/project-a')?.count ?? board.tasks.filter(task => task.repoPath === '/project-a' && task.phase === 'queued').length, laneCount: board.lanes.find(lane => lane.key === 'scale')?.liveByPhase.queued, dispatchMs, boardMs };
    } finally { await runtime.stop(); }
  }
  const small = await measure(10), large = await measure(1000);
  console.log(`isolated queue benchmark: 10 dispatch ${small.dispatchMs.toFixed(2)} ms, board ${small.boardMs.toFixed(2)} ms; 1000 dispatch ${large.dispatchMs.toFixed(2)} ms, board ${large.boardMs.toFixed(2)} ms; counts 10: ${small.reads} reads, ${small.writes} writes, ${small.visits} visits, ${small.boardWork} board tasks; 1000: ${large.reads} reads, ${large.writes} writes, ${large.visits} visits, ${large.boardWork} board tasks`);
  assert.equal(small.count, 9); assert.equal(large.count, 999);
  assert.equal(small.visits, 1);
  assert.equal(small.laneCount, 9); assert.equal(large.laneCount, 999);
  assert.ok(Math.abs(large.reads - small.reads) <= 2, `store reads must stay within a fixed margin: ${small.reads} vs ${large.reads}`);
  assert.deepEqual({ writes: large.writes, visits: large.visits, boardWork: large.boardWork },
    { writes: small.writes, visits: small.visits, boardWork: small.boardWork });
});
