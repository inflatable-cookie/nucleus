import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { Resolution } from '../core/resolution';
import type { Adapter } from '../core/host';
import { submissionSchema, runSchema, outcomeSchema } from '../shared/contracts';
import { createUiSnapshotFactsCache } from '../core/telemetry/ui-snapshot';
import { buildLaneViews, indexOutcomesByLane } from '../core/planning/lanes';
import { publicationBudget, PUBLICATION_BUDGET_FACTOR, PUBLICATION_BUDGET_FREE_MS, PUBLICATION_BUDGET_MAX_GAP_MS } from '../service/web/publication-budget';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-refresh-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  const add = (id: string, repoPath = '/repo', dependsOn: string[] = []) => store.insert(submissionSchema.parse({
    submissionId: id, title: id, repoPath, dependsOn, planningCommit: 'a'.repeat(40), handoffPath: `${id}.md`, originAgentId: 'origin',
  }), 'host', 'h', 'a'.repeat(40));
  const resolution = new Resolution(store, {} as Adapter, () => [], () => true);
  return { store, add, resolution, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('board batch preserves live admission reasons while checking each queued dependency once', () => {
  const f = fixture();
  try {
    const dependency = f.add('dependency');
    f.store.update(dependency.id, { phase: 'done', resolution: { ...dependency.resolution, goalUnmet: 'not satisfied' } });
    const active = f.add('active'); f.store.update(active.id, { phase: 'working' });
    for (let i = 0; i < 30; i++) f.add(`queued-${i}`, i % 2 ? '/repo' : '/other', i % 3 ? [] : [dependency.id]);
    const parked = f.add('parked'); f.store.update(parked.id, { phase: 'awaiting_review' });
    const lease = f.add('lease'); f.store.update(lease.id, { phase: 'verifying' });
    const run = runSchema.parse({ id: 'lease-run', taskId: lease.id, role: 'reviewer', status: 'running', workspaceId: 'ws', createdAt: new Date().toISOString(), generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, profile: null, lastObservedAt: null, active: null, idleSince: null, completion: null, released: false });
    f.store.putRun(run);
    const held = f.add('held'); f.store.update(held.id, { held: true });
    f.store.setMeta('globalLimit', 4); f.store.setMeta('projectLimit', 2);
    const tasks = f.store.admissionCandidates(), runs = f.store.runsForTasks(tasks.map(t => t.id));
    const expected = tasks.map(t => f.resolution.slotAdmissionReason(t, true));
    const original = f.store.dependencyWait.bind(f.store); let calls = 0;
    f.store.dependencyWait = task => { calls++; return original(task); };
    const read = f.resolution.slotAdmissionReader(tasks, runs, true);
    assert.deepEqual(tasks.map(read), expected);
    assert.ok(calls <= tasks.filter(t => t.phase === 'queued').length, `${calls} dependency checks must be bounded by queued tasks`);
    f.store.setMeta('globalLimit', 1);
    const freshTasks = f.store.admissionCandidates();
    const fresh = f.resolution.slotAdmissionReader(freshTasks, runs, true);
    assert.deepEqual(freshTasks.map(fresh), freshTasks.map(t => f.resolution.slotAdmissionReason(t, true)), 'new read observes changed capacity');
    f.store.putRun({ ...run, released: true, status: 'finished' });
    const released = f.resolution.slotAdmissionReader(f.store.admissionCandidates(), f.store.runsForTasks(tasks.map(t => t.id)), true);
    assert.equal(released(f.store.task(lease.id)), f.resolution.slotAdmissionReason(f.store.task(lease.id), true));
  } finally { f.close(); }
});

test('a dispatch pass reads each queued prerequisite once and a later pass sees the change', async () => {
  const f = fixture();
  try {
    const dependency = f.add('dependency');
    const active = f.add('active'); f.store.update(active.id, { phase: 'working' });
    for (let i = 0; i < 40; i++) f.add(`queued-${i}`, '/repo', i % 2 ? [dependency.id] : []);
    f.store.setMeta('globalLimit', 16); f.store.setMeta('projectLimit', 4);
    const queued = () => f.store.admissionCandidates().filter(t => t.phase === 'queued');
    const original = f.store.dependencyWait.bind(f.store); let calls = 0;
    f.store.dependencyWait = task => { calls++; return original(task); };
    const live = queued().map(t => f.resolution.slotAdmissionReason(t));
    const unbounded = calls; calls = 0;
    const inPass = await f.resolution.withDispatchPass(async () => queued().map(t => f.resolution.slotAdmissionReason(t)));
    assert.deepEqual(inPass, live, 'a pass answers the same admission reasons');
    assert.ok(calls <= queued().length, `${calls} prerequisite reads in one pass, against ${unbounded} without it`);
    assert.ok(unbounded > queued().length * 4, `the uncached shape costs the square of the queue (${unbounded})`);
    f.store.update(dependency.id, { phase: 'done' });
    const next = await f.resolution.withDispatchPass(async () => queued().map(t => f.resolution.slotAdmissionReason(t)));
    assert.deepEqual(next, queued().map(t => f.resolution.slotAdmissionReason(t)), 'the next pass reads the finished prerequisite');
  } finally { f.close(); }
});

test('one board batch ranks its requests once and answers what live admission answers', () => {
  const f = fixture();
  try {
    const active = f.add('active'); f.store.update(active.id, { phase: 'working' });
    for (let i = 0; i < 40; i++) f.add(`queued-${i}`);
    f.store.setMeta('globalLimit', 16); f.store.setMeta('projectLimit', 4);
    const tasks = f.store.admissionCandidates(), runs = f.store.runsForTasks(tasks.map(t => t.id));
    const expected = tasks.map(t => f.resolution.slotAdmissionReason(t));
    const queued = tasks.filter(t => t.phase === 'queued');
    const original = f.store.dependencyWait.bind(f.store); let calls = 0;
    f.store.dependencyWait = task => { calls++; return original(task); };
    assert.deepEqual(tasks.map(f.resolution.slotAdmissionReader(tasks, runs)), expected);
    assert.ok(calls <= queued.length, `${calls} reads for ${queued.length} queued tasks`);
  } finally { f.close(); }
});

test('a slow publication waits its turn and a cheap one never does', () => {
  let at = 1000; const budget = publicationBudget(() => at);
  assert.equal(budget.due(), true);
  budget.spent(PUBLICATION_BUDGET_FREE_MS - 1);
  assert.equal(budget.due(), true, 'a small board publishes on every request');
  budget.spent(1000);
  assert.equal(budget.due(), false, 'a slow build leaves the executor time to work');
  at += 1000 * PUBLICATION_BUDGET_FACTOR - 1; assert.equal(budget.due(), false);
  at += 1; assert.equal(budget.due(), true, 'the next tick publishes');
  budget.spent(60_000);
  at += PUBLICATION_BUDGET_MAX_GAP_MS; assert.equal(budget.due(), true, 'the board never lags past the bound');
});

test('lane activity survives task-only refreshes and follows lead, draft and rollback changes', () => {
  const f = fixture(); const stamp = '2026-10-08T00:00:00.000Z';
  try {
    const lead = f.store.addLead({ id: 'lead', title: 'Lead', body: 'large body', repositories: [{ origin: 'owner/repo', path: '/repo' }],
      lanes: ['alpha'], author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: null }, 'owner');
    assert.deepEqual(f.store.laneRecordActivity().get('alpha'), { at: stamp, open: 1 });
    const ownCopy = f.store.laneRecordActivity(); ownCopy.get('alpha')!.open = 100;
    assert.equal(f.store.laneRecordActivity().get('alpha')!.open, 1, 'caller cannot corrupt the cached aggregate');
    const task = f.add('task'); f.store.update(task.id, { reason: 'observed' });
    assert.equal(f.store.laneRecordActivity().get('alpha')!.open, 1);
    f.store.updateLead({ ...lead, lanes: ['beta'], updatedAt: '2026-10-08T01:00:00.000Z' });
    assert.equal(f.store.laneRecordActivity().has('alpha'), false);
    assert.equal(f.store.laneRecordActivity().get('beta')!.open, 1);
    assert.throws(() => f.store.transaction(() => {
      f.store.updateLead({ ...lead, lanes: ['wrong'] });
      assert.equal(f.store.laneRecordActivity().get('wrong')!.open, 1);
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(f.store.laneRecordActivity().has('wrong'), false);
    assert.equal(f.store.laneRecordActivity().get('beta')!.open, 1);

  } finally { f.close(); }
});

test('board reader is rebuilt at a new durable revision, not reused by task effects', () => {
  const f = fixture();
  try {
    const task = f.add('task'); let batches = 0;
    const read = createUiSnapshotFactsCache(f.store, (tasks, runs) => { batches++; return f.resolution.slotAdmissionReader(tasks, runs, true); });
    const first = read(); assert.strictEqual(read(), first); assert.equal(batches, 1);
    f.store.update(task.id, { reason: 'changed' });
    assert.notStrictEqual(read(), first); assert.equal(batches, 2);
  } finally { f.close(); }
});

test('lane views follow lane, outcome, task and event writes and reuse the index in between', () => {
  const f = fixture();
  try {
    const stamp = '2026-10-08T00:00:00.000Z';
    f.store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Alpha ships', repositories: [{ origin: 'owner/repo', path: '/repo' }] });
    const task = f.add('laned'); f.store.update(task.id, { lanes: ['alpha'], laneContext: [{ key: 'alpha', title: 'Alpha', aim: 'Alpha ships' }] });
    const first = f.store.laneViews();
    assert.strictEqual(f.store.laneViews(), first, 'an unchanged revision serves the cached views');
    // A run and a notice are board writes but never lane-view inputs.
    f.store.putRun(runSchema.parse({ id: 'run-1', taskId: task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, profile: null, lastObservedAt: null,
      active: null, idleSince: null, completion: null, released: false, createdAt: stamp }));
    f.store.putNotice({ id: 'notice-1', taskId: task.id, agentId: 'a', recipientAgentId: 'a', workspaceId: 'ws', sources: ['origin'],
      originEntry: false, kind: 'attention', status: 'pending', error: '', text: 't' });
    assert.strictEqual(f.store.laneViews(), first, 'a run or notice write does not rebuild the lane views');
    // Every lane-view input does rebuild them.
    const revisions = [f.store.laneViewRevision()];
    const seen = new Set([first]);
    for (const write of [
      () => f.store.event(task.id, 'probe', 'activity'),
      () => f.store.update(task.id, { reason: 'phase moved' }),
      () => f.store.update(task.id, { phase: 'done' }),
      () => f.store.upsertLane({ key: 'alpha', title: 'Alpha renamed', aim: 'Alpha ships', repositories: [{ origin: 'owner/repo', path: '/repo' }] }),
    ]) {
      write();
      const next = f.store.laneViews();
      assert.equal(seen.has(next), false, 'the write rebuilt the views');
      revisions.push(f.store.laneViewRevision());
      seen.add(next);
    }
    assert.equal(new Set(revisions).size, revisions.length, 'each input write advanced the revision');
    // The cache key is a durable trigger clock, which never moves backwards.
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), 'the lane-view revision only moves forward');
    assert.equal(f.store.laneViews()[0].terminalCount, 1, 'the finished task records one outcome');
    // A query is a filter of the cached views, never a rebuild.
    const views = f.store.laneViews();
    assert.deepEqual(f.store.laneViews({ status: 'active' }), views.filter(lane => lane.status === 'active'));
    assert.deepEqual(f.store.laneViews({ repository: 'owner/repo' }), views);
  } finally { f.close(); }
});

test('indexed lane views answer exactly what the per-lane rescan answered', () => {
  const f = fixture();
  try {
    for (const key of ['alpha', 'beta']) f.store.upsertLane({ key, title: key, aim: `${key} ships`, repositories: [{ origin: 'owner/repo', path: '/repo' }] });
    const tasks = ['one', 'two', 'three'].map(id => f.add(id));
    f.store.update(tasks[0].id, { lanes: ['alpha'], laneContext: [] });
    f.store.update(tasks[1].id, { lanes: ['alpha', 'beta'], laneContext: [] });
    f.store.update(tasks[2].id, { lanes: ['beta'], laneContext: [] });
    f.store.update(tasks[0].id, { phase: 'done' });
    f.store.update(tasks[1].id, { phase: 'cancelled' });
    const index = indexOutcomesByLane(f.store.outcomes());
    for (const lane of ['alpha', 'beta']) {
      const oracle = f.store.outcomes().filter(outcome => outcome.lanes.includes(lane))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
      assert.deepEqual(index.get(lane) ?? [], oracle, `${lane}: the index keeps the read order`);
    }
    const views = buildLaneViews(f.store.lanes(), f.store.uiTasks(), index, new Map(), f.store.laneRecordActivity());
    const alpha = views.find(view => view.key === 'alpha')!;
    // The shared task keeps one identity: both of its terminal outcomes are history in each lane.
    assert.equal(alpha.terminalCount, 2, 'each finished task counts its own outcome once');
    assert.deepEqual(alpha.liveByPhase, {}, 'no live task remains in the lane');
    const beta = views.find(view => view.key === 'beta')!;
    assert.equal(beta.terminalCount, 1, 'a shared task contributes to both lanes');
    assert.deepEqual(beta.liveByPhase, { queued: 1 }, 'the live task stays counted per lane');
    assert.equal(beta.recentOutcomes.length, 1);
  } finally { f.close(); }
});

test('an observation-only write keeps the board projection and moves the observation time', () => {
  const f = fixture();
  try {
    const task = f.add('observed');
    const running = f.store.update(task.id, { phase: 'working', agentId: 'agent', agentIntent: true, workspaceId: 'ws',
      lastAgentStatus: 'running', agentActive: true, lastObservedAt: '2026-10-08T00:00:00.000Z' });
    const read = createUiSnapshotFactsCache(f.store);
    const first = read();
    const revision = f.store.boardRevision(), telemetry = f.store.telemetryRevision();
    const observed = '2026-10-08T00:05:00.000Z';
    f.store.update(task.id, { lastObservedAt: observed, lastAgentStatus: 'running', agentActive: true });
    assert.equal(f.store.boardRevision(), revision, 'the board revision does not move');
    assert.equal(f.store.telemetryRevision(), telemetry, 'observation time does not invalidate telemetry');
    assert.strictEqual(read(), first, 'the projection is reused');
    assert.equal(f.store.observationTimes('task', [task.id]).get(task.id), observed, 'the counter source reads the new time');
    assert.equal(running.version, f.store.task(task.id).version, 'an observation spends no version');
    // A status change is a board fact.
    f.store.update(task.id, { lastAgentStatus: 'idle', agentActive: false, lastObservedAt: observed });
    assert.ok(f.store.boardRevision() > revision, 'a changed status rebuilds the board');
    assert.notStrictEqual(read(), first);
    // The same rule for a run that only records a new observation time.
    const run = runSchema.parse({ id: 'run-observed', taskId: task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', profile: null, lastObservedAt: null,
      active: true, idleSince: null, completion: null, released: false, createdAt: '2026-10-08T00:00:00.000Z' });
    f.store.putRun(run);
    const facts = read(), board = f.store.boardRevision();
    // Parent falsification for the in-memory projection: a run row write fires the `writes`
    // trigger the projection clock keys on, so an observation-only write must acknowledge
    // that clock exactly as a substantive one does. The parent skipped it, and the next
    // task or run read then discarded every projected row and rebuilt from the tables —
    // which is the audit's observation hot path (resolving a still-busy run each pass).
    f.store.liveTasks();
    const projection = (f.store as unknown as { tasksStore: { taskProjection: Map<string, unknown> | null } }).tasksStore.taskProjection;
    assert.ok(projection, 'the projection exists before the observation');
    f.store.putRun({ ...run, lastObservedAt: observed });
    assert.equal(f.store.boardRevision(), board, 'an observation-only run write does not rebuild the board');
    assert.strictEqual(read(), facts);
    const clock = (f.store as unknown as { tasksStore: { projectionClock: number; readProjectionClock(): number } }).tasksStore;
    assert.equal(clock.projectionClock, clock.readProjectionClock(), 'the observation-only run write acknowledged the writes trigger');
    f.store.liveTasks();
    f.store.pendingRuns();
    assert.strictEqual((f.store as unknown as { tasksStore: { taskProjection: Map<string, unknown> | null } }).tasksStore.taskProjection, projection,
      'the next task and run read reuses the projection instead of rebuilding it');
    assert.equal(f.store.observationTimes('run', [run.id]).get(run.id), observed);
    f.store.putRun({ ...f.store.run(run.id)!, status: 'finished' });
    assert.ok(f.store.boardRevision() > board, 'a run status change rebuilds the board');
  } finally { f.close(); }
});

test('a rolled-back write leaks no lane view, outcome index or board revision', () => {
  const f = fixture();
  try {
    f.store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Alpha ships', repositories: [{ origin: 'owner/repo', path: '/repo' }] });
    const live = f.add('live');
    f.store.update(live.id, { lanes: ['alpha'], laneContext: [] });
    assert.equal(f.store.laneViews()[0].terminalCount, 0);
    const board = f.store.boardRevision(), laneRevision = f.store.laneViewRevision();
    assert.throws(() => f.store.transaction(() => {
      f.store.update(live.id, { phase: 'done' });
      assert.equal(f.store.laneViews()[0].terminalCount, 1, 'the transaction sees its own outcome');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(f.store.boardRevision(), board, 'the board revision rewinds with the write');
    assert.ok(f.store.laneViewRevision() >= laneRevision);
    assert.equal(f.store.laneViews()[0].terminalCount, 0, 'no uncommitted outcome is counted');
    assert.deepEqual(f.store.task(live.id).phase, 'queued');
    assert.equal(f.store.outcomes().length, 0);
  } finally { f.close(); }
});

type BoardCounters = { unchanged?: true; revision: number; unsettled: number; occupiedSlots: number };
/** A plain live task for the planning-list test; the plan reads no task row. */
const f_extraTask = (store: Store) => store.insert(submissionSchema.parse({ submissionId: 'planning-task', title: 'Planning task',
  repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' }), 'host', 'h', 'a'.repeat(40));

test('the 45 s unsettled counter crosses its boundary with no write and reads a fresh observation at once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-unsettled-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { QueueRuntime } = await import('../service/runtime-owner');
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  const realNow = Date.now;
  try {
    const store = runtime.store;
    const observedAt = new Date(realNow()).toISOString();
    const task = store.insert(submissionSchema.parse({ submissionId: 'observed-worker', title: 'Observed worker',
      repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' }), 'host', 'h', 'a'.repeat(40));
    store.update(task.id, { phase: 'working', agentId: 'agent', agentIntent: true, workspaceId: 'ws',
      lastAgentStatus: 'running', agentActive: true, lastObservedAt: observedAt });
    const first = runtime.uiSnapshot() as BoardCounters;
    assert.equal(first.occupiedSlots, 1);
    assert.equal(first.unsettled, 0, 'a run observed just now is settled');
    // The task row the board projection kept, which is what a counter reading cached facts would see.
    const projected = store.task(task.id);
    // Elapsed time alone crosses the window: no write, no board revision, a different count.
    Date.now = () => realNow() + 46_000;
    const later = runtime.uiSnapshot({ revision: first.revision }) as BoardCounters;
    assert.equal(later.unchanged, true, 'the projection is still the cached one');
    assert.equal(later.unsettled, 1, 'the stale observation shows without any write');
    assert.equal(runtime.snapshot().unsettled, later.unsettled, 'both board surfaces use the same live observation');
    // A fresh observation is an observation-only write, made while the clock is past the old
    // window: the board does not rebuild, so a counter reading the kept projection would still
    // report the task unsettled after 46 s, and the counter must read the row instead.
    const refreshed = new Date(realNow() + 46_000).toISOString();
    store.update(task.id, { lastObservedAt: refreshed, lastAgentStatus: 'running', agentActive: true });
    assert.equal(store.boardRevision(), first.revision, 'the observation-only write spent no board revision');
    const parentUnsettled = Date.parse(refreshed) - Date.parse(projected.lastObservedAt!) > 45_000 ? 1 : 0;
    assert.equal(parentUnsettled, 1, 'the parent shape — counting the projection it kept — reports this task unsettled');
    const observed = runtime.uiSnapshot({ revision: first.revision }) as BoardCounters;
    assert.equal(observed.unchanged, true, 'still the same projection');
    assert.equal(observed.unsettled, 0, 'the fresh observation is read from the row, not the cache');
    assert.equal(runtime.snapshot().unsettled, observed.unsettled, 'both board surfaces see the fresh observation');
  } finally {
    Date.now = realNow;
    await runtime.stop();
  }
});

test('the planning list follows lead and decision writes, not unrelated board writes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-planning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { QueueRuntime } = await import('../service/runtime-owner');
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    const store = runtime.store;
    const stamp = '2026-10-08T00:00:00.000Z';
    const repositories = [{ origin: 'owner/repo', path: '/repo' }];
    const lead = store.addLead({ id: 'lead', title: 'Lead', body: 'Body', repositories, lanes: [],
      author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null,
      createdAt: stamp, updatedAt: stamp, closedAt: null }, 'owner');
    const task = f_extraTask(store);
    const first = runtime.leadBoard();
    assert.deepEqual(first.cards.map(card => card.id), ['lead']);
    assert.strictEqual(runtime.leadBoard(), first, 'an unchanged revision serves the cached list');
    // A task, run or notice write is a board write but no planning fact.
    store.update(task.id, { reason: 'task moved' });
    store.putRun(runSchema.parse({ id: 'planning-run', taskId: task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, profile: null, lastObservedAt: null,
      active: null, idleSince: null, completion: null, released: false, createdAt: stamp }));
    assert.strictEqual(runtime.leadBoard(), first, 'a task or run write does not rebuild the planning list');
    // A lead write does.
    store.updateLead({ ...lead, title: 'Renamed', updatedAt: stamp });
    const renamed = runtime.leadBoard();
    assert.notStrictEqual(renamed, first, 'a lead write rebuilds the planning list');
    assert.deepEqual(renamed.cards.map(card => card.title), ['Renamed']);
    // A decision is a planning fact too, because its links place cards.
    store.addDecision({ id: 'dec-1', version: 1, question: 'Which lane?', askedBy: { agentId: 'agent-1', project: null },
      links: { tasks: [], leads: ['lead'], papercuts: [] }, status: 'open', createdAt: stamp, updatedAt: stamp });
    const decided = runtime.leadBoard();
    assert.notStrictEqual(decided, renamed, 'a decision write rebuilds the planning list');
    // Rollback leaves the planning list where it was.
    const revision = store.leadRevision();
    assert.throws(() => store.transaction(() => {
      store.updateLead({ ...store.lead('lead'), title: 'Rolled back', updatedAt: stamp });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.leadRevision(), revision, 'the lead revision rewinds with the write');
    assert.deepEqual(runtime.leadBoard().cards.map(card => card.title), ['Renamed']);
  } finally { await runtime.stop(); }
});

test('1030 the board carries per-domain planning revisions that unrelated writes leave alone', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-board-domains-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { QueueRuntime } = await import('../service/runtime-owner');
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    const store = runtime.store;
    const stamp = '2026-10-08T00:00:00.000Z';
    const repositories = [{ origin: 'owner/repo', path: '/repo' }];
    const task = f_extraTask(store);
    const planningOf = () => { const board = runtime.uiSnapshot(); assert.ok(!('unchanged' in board)); return board.planning!; };
    const start = planningOf();
    assert.deepEqual(start, store.planningRevisions(), 'the full board carries the store values');
    // Run events, run writes, observations and telemetry move the board but no planning list.
    const boardBefore = store.boardRevision();
    store.update(task.id, { reason: 'task moved' });
    store.event(task.id, 'note', 'a run event');
    store.putRun(runSchema.parse({ id: 'domain-run', taskId: task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, profile: null, lastObservedAt: null,
      active: null, idleSince: null, completion: null, released: false, createdAt: stamp }));
    store.update(task.id, { lastObservedAt: '2026-10-08T00:05:00.000Z' });
    assert.ok(store.boardRevision() > boardBefore, 'the board revision moved');
    assert.deepEqual(planningOf(), start, 'no planning revision moved');
    // Each domain write moves its own revision, and the board revision with it.
    const lead = store.addLead({ id: 'lead', title: 'Lead', body: 'Body', repositories, lanes: [],
      author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null,
      createdAt: stamp, updatedAt: stamp, closedAt: null }, 'owner');
    const afterLead = planningOf();
    assert.ok(afterLead.leads > start.leads, 'a lead write moves the leads revision');
    assert.equal(afterLead.decisions, start.decisions);
    store.updateLead({ ...lead, title: 'Renamed', updatedAt: stamp });
    assert.ok(planningOf().leads > afterLead.leads, 'a lead update moves the leads revision');
    const beforeDecision = planningOf();
    store.addDecision({ id: 'dec-1', version: 1, question: 'Which lane?', askedBy: { agentId: 'agent-1', project: null },
      links: { tasks: [], leads: [], papercuts: [] }, status: 'open', createdAt: stamp, updatedAt: stamp });
    const afterDecision = planningOf();
    assert.ok(afterDecision.decisions > beforeDecision.decisions, 'a decision write moves the decisions revision');
    assert.equal(afterDecision.plans, beforeDecision.plans, 'a decision write leaves plans alone');
    const beforeLane = store.boardRevision();
    store.upsertLane({ key: 'domain-lane', title: 'Lane', aim: 'Aim', repositories });
    const afterLane = planningOf();
    assert.ok(afterLane.plans > afterDecision.plans, 'a lane write moves the plans revision');
    assert.ok(store.boardRevision() > beforeLane);
    store.setPlan({ repository: '/repo', version: 0, entries: [{ lane: 'domain-lane' }], author: 'owner' });
    assert.ok(planningOf().plans > afterLane.plans, 'a plan write moves the plans revision');
    // A rollback rewinds the trigger clocks with the write.
    const held = store.planningRevisions();
    assert.throws(() => store.transaction(() => {
      store.updateDecision({ ...store.decision('dec-1'), question: 'Rolled back' });
      throw new Error('rollback');
    }), /rollback/);
    assert.deepEqual(store.planningRevisions(), held);
  } finally { await runtime.stop(); }
});

test('every substantive board write invalidates it and only an observation-only write does not', () => {
  const f = fixture();
  try {
    const task = f.add('mutable');
    f.store.update(task.id, { phase: 'working', agentId: 'agent', agentIntent: true, workspaceId: 'ws',
      lastAgentStatus: 'running', agentActive: true, lastObservedAt: '2026-10-08T00:00:00.000Z' });
    const run = runSchema.parse({ id: 'substantive-run', taskId: task.id, role: 'revision', status: 'running', workspaceId: 'ws',
      generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: 'agent', profile: null, lastObservedAt: null,
      active: true, idleSince: null, completion: null, released: false, createdAt: '2026-10-08T00:00:00.000Z' });
    f.store.putRun(run);
    const substantive: Array<[string, () => void]> = [
      ['task field', () => f.store.update(task.id, { reason: 'moved on' })],
      ['task phase', () => f.store.update(task.id, { phase: 'reviewing' })],
      ['run status', () => f.store.putRun({ ...f.store.run(run.id)!, status: 'finished' })],
      ['run release', () => f.store.putRun({ ...f.store.run(run.id)!, released: true })],
      ['notice', () => f.store.putNotice({ id: 'substantive-notice', taskId: task.id, agentId: 'a', recipientAgentId: 'a',
        workspaceId: 'ws', sources: ['origin'], originEntry: false, kind: 'attention', status: 'pending', error: '', text: 't' })],
      ['lane', () => f.store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Alpha ships', repositories: [{ origin: 'owner/repo', path: '/repo' }] })],
      ['lane status', () => f.store.setLaneStatus('alpha', 'paused')],
      ['project', () => f.store.upsertProject({ key: 'app', name: 'App', repositories: [{ origin: 'owner/repo', path: '/repo' }] })],
      ['late outcome', () => f.store.putOutcome({ ...outcomeSchema.parse({ taskId: 'late', submissionId: 'late', title: 'Late',
        repository: { origin: 'owner/repo', path: '/repo' }, outcome: 'done', reason: 'Completed', pr: null, mergeCommit: null,
        syncedCommit: null, review: null, validation: null, closeout: null, brief: { digest: `sha256:${'c'.repeat(64)}`,
          mediaType: 'text/markdown', text: '' }, workers: [], reviewers: [], siblings: [], startedAt: '2026-10-08T00:00:00.000Z',
        finishedAt: '2026-10-08T00:00:00.000Z', backfilled: true, lanes: [] }) })],
    ];
    for (const [label, write] of substantive) {
      const board = f.store.boardRevision();
      write();
      assert.ok(f.store.boardRevision() > board, `${label}: the board revision advances`);
    }
    // The observation-only shapes the lifecycle writes on every pass.
    const observationOnly: Array<[string, () => void]> = [
      ['task observation', () => f.store.update(task.id, { lastObservedAt: '2026-10-08T06:00:00.000Z', lastAgentStatus: 'running', agentActive: true })],
      ['run observation', () => f.store.putRun({ ...f.store.run(run.id)!, lastObservedAt: '2026-10-08T06:00:00.000Z' })],
    ];
    for (const [label, write] of observationOnly) {
      const board = f.store.boardRevision();
      write();
      assert.equal(f.store.boardRevision(), board, `${label}: the board revision stays put`);
    }
  } finally { f.close(); }
});
