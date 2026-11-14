import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store/store';
import { EventLoopDelayMonitor } from '../core/telemetry/event-loop-delay';
import { submissionSchema, taskSchema, taskHasUnreleasedRun, compactLiveTask } from '../shared/contracts';

const head = 'a'.repeat(40);
const submission = (id: string) => submissionSchema.parse({
  submissionId: id, title: id, repoPath: '/repo-a', planningCommit: head, handoffPath: `${id}.md`, originAgentId: 'origin',
});
const insert = (store: Store, id: string) => store.insert(submission(id), 'host', 'handoff', head);

test('memoised task lists follow every task write, including a rolled-back one', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.admissionCandidates(), []);
    assert.deepEqual(store.liveTasks(), []);
    const first = insert(store, 'cache-1');
    assert.deepEqual(store.admissionCandidates().map(task => task.id), [first.id]);
    assert.deepEqual(store.liveTasks().map(task => task.id), [first.id]);
    assert.deepEqual(store.maintenanceTasks().map(task => task.id), [first.id]);
    assert.deepEqual(store.lifecycleTasks().map(task => task.id), [first.id]);
    // Read twice so the second answer is a memo hit, then write and read again.
    store.admissionCandidates();
    store.update(first.id, { phase: 'cancelled', reason: 'test' } as never);
    assert.equal(store.liveTasks().length, 0, 'a task write invalidates the live list');
    assert.equal(store.admissionCandidates().length, 0);
    assert.throws(() => store.transaction(() => { insert(store, 'cache-2'); assert.equal(store.liveTasks().length, 1); throw new Error('rollback'); }), /rollback/);
    assert.equal(store.liveTasks().length, 0, 'a rolled-back insert leaves no memoised row behind');
    assert.equal(store.admissionCandidates().length, 0);
  } finally { store.close(); }
});

test('callers cannot corrupt a memoised list by mutating a returned task', () => {
  const store = new Store(':memory:');
  try {
    const task = insert(store, 'cache-3');
    store.admissionCandidates()[0].title = 'mutated';
    assert.equal(store.admissionCandidates()[0].title, task.title);
    store.liveTasks()[0].title = 'mutated';
    assert.equal(store.liveTasks()[0].title, task.title);
  } finally { store.close(); }
});

test('lane views see new events and outcomes after the memoised facts were built', () => {
  const store = new Store(':memory:');
  try {
    store.upsertLane({ key: 'lane-a', title: 'Lane A', aim: 'Done looks like lane A shipped.', repositories: [{ origin: 'acme/alpha', path: '/repo-a' }] });
    const task = store.insert(submissionSchema.parse({ ...submission('lane-task'), lanes: ['lane-a'] }), 'host', 'handoff', head);
    const before = store.laneViews()[0].lastActivityAt!;
    store.laneViews();
    store.event(task.id, 'probe', 'later activity');
    const after = store.laneViews()[0].lastActivityAt!;
    assert.ok(after >= before);
    assert.equal(after, store.eventsAll(task.id).at(-1)!.at, 'the newest event time wins');
  } finally { store.close(); }
});

test('event-loop monitor reports blocked time and survives a stop', async () => {
  const monitor = new EventLoopDelayMonitor();
  monitor.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  const end = Date.now() + 300;
  while (Date.now() < end) { /* block the loop */ }
  await new Promise(resolve => setTimeout(resolve, 50));
  const report = monitor.report();
  assert.ok(report.maxMs >= 200, `blocked 300 ms, reported max ${report.maxMs}`);
  assert.ok(report.maxSinceStartMs >= report.maxMs);
  assert.ok(report.p50Ms <= report.p99Ms && report.p99Ms <= report.maxMs + 11);
  monitor.stop();
  monitor.stop();
});

test('unreleasedRunsForAgent equals the full-scan filter it replaces', async () => {
  // 2026-10-03: thread archival scanned every run per released run on each pass,
  // stalling the runtime thread for up to 14 s on 7,134 runs.
  const { runSchema } = await import('../shared/contracts');
  const store = new Store(':memory:');
  try {
    const live = insert(store, 'runs-live');
    const gone = insert(store, 'runs-gone');
    const run = (id: string, taskId: string, agentId: string | null, released: boolean) => store.putRun(runSchema.parse({
      id, taskId, role: 'reviewer', generation: 1, head, base: head, agentId, workspaceId: 'w', profile: null, status: 'finished',
      createdAt: new Date(0).toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released,
    }));
    run('a-open', live.id, 'agent-a', false);
    run('a-done', live.id, 'agent-a', true);
    run('b-open', live.id, 'agent-b', false);
    run('null-agent', live.id, null, false);
    run('a-on-removed', gone.id, 'agent-a', false);
    store.update(gone.id, { removedAt: new Date().toISOString() });
    for (const agent of ['agent-a', 'agent-b', 'agent-c']) {
      const expected = store.runs().filter(r => r.agentId === agent && !r.released).map(r => r.id);
      assert.deepEqual(store.unreleasedRunsForAgent(agent).map(r => r.id), expected, agent);
    }
    assert.deepEqual(store.unreleasedRunsForAgent('agent-a').map(r => r.id), ['a-open']);
  } finally { store.close(); }
});

test('a completed cancellation releases its slot even with a stuck unreleased run row', async () => {
  // project-a #1636 (cancelled 2026-09-26) kept a project slot for a week through an
  // agentless recovery run that was never released.
  const { runSchema } = await import('../shared/contracts');
  const { occupiesSlot } = await import('../core/dispatch/capacity');
  const store = new Store(':memory:');
  try {
    const task = insert(store, 'ghost-slot');
    store.putRun(runSchema.parse({ id: 'stuck-recovery', taskId: task.id, role: 'recovery', generation: 1, head, base: head, agentId: null,
      workspaceId: 'w', profile: null, status: 'intent', createdAt: new Date(0).toISOString(), lastObservedAt: null, active: null,
      idleSince: null, completion: null, released: false }));
    const at = new Date().toISOString();
    store.update(task.id, { phase: 'cancelled', agentIntent: true, agentId: 'agent', agentActive: false, disposition: {
      kind: 'cancel', status: 'complete', requestedAt: at, requestedBy: 'operator control', reason: 'test', replacementTaskId: null,
      replacementBranch: null, replacementWorkspaceId: null, workDisposition: 'archive_if_empty', workspaceId: 'w', workspaceArchived: false,
      workspaceEvidence: '', hookEmitted: true, effects: [], completedAt: at, attention: '' } } as never);
    // PR 824 (task 578): a settled cancellation is not in the capacity inventory
    // at all, and the slot predicate holds no slot for it even when the caller
    // saw an unreleased run row.
    const row = store.task(task.id);
    assert.equal(store.admissionCandidates().some(candidate => candidate.id === task.id), false, 'a settled cancellation is not in the capacity inventory');
    assert.equal(occupiesSlot(row), false, 'a settled cancellation holds no slot');
    assert.equal(occupiesSlot(row, store.runs(task.id)), false, 'not even when the caller saw an unreleased run');
  } finally { store.close(); }
});

// Task 160: the incremental projection must answer every projected list exactly as
// a full table scan would, after mixed writes, a rolled-back transaction and a purge.
// The oracles below are the retired full-scan SQL the projection replaces.
// A stored row names its texts by digest and keeps observation fields beside it
// (audit B6, schema 45), so the oracle decodes the raw row through the store's own
// row resolver — never through the projection under test.
const oracleTask = (store: Store, data: string) => {
  const task = taskSchema.parse((store as unknown as { taskWritesStore: { resolveStoredTask(raw: Record<string, unknown>): unknown } }).taskWritesStore.resolveStoredTask(JSON.parse(data)));
  const number = store.numberFor(task.id);
  return number ? { ...task, ...number } : task;
};
const oracleRows = (store: Store, sql: string, params: Array<string | number> = []) =>
  (store.db.prepare(sql).all(...params) as Array<Record<string, unknown>>)
    .map(row => oracleTask(store, String(row.data)));
const oracleLive = (store: Store) => oracleRows(store,
  "SELECT data FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND json_extract(data,'$.phase') NOT IN ('done','cancelled') ORDER BY rowid DESC");
const oracleMaintenance = (store: Store) => oracleRows(store, `SELECT data FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND (
  json_extract(data,'$.phase') NOT IN ('done','cancelled')
  OR COALESCE(json_extract(data,'$.originError'),'') <> ''
  OR json_extract(data,'$.resolution.attention')=1
  OR (json_extract(data,'$.resolution.roleReplacements')<>0 AND substr(json_extract(data,'$.reason'),1,11)='No eligible')
  OR json_extract(data,'$.resolution.recoveryActive')=1
  OR (json_extract(data,'$.disposition') IS NOT NULL AND json_extract(data,'$.disposition.status')<>'complete')
  OR (json_extract(data,'$.checkpoints.intent') IS NOT NULL AND json_extract(data,'$.checkpoints.intent.status')<>'delivered')
  OR EXISTS (SELECT 1 FROM runs r WHERE r.id=json_extract(tasks.data,'$.resolution.recovery.runId') AND COALESCE(json_extract(r.data,'$.released'),0)=0)
) ORDER BY rowid DESC`);
// PR 824 (task 578): terminal tasks never enter the capacity inventory, whatever
// recovery or merge state they still carry.
const oracleCapacity = (store: Store) =>
  (store.db.prepare(`SELECT tasks.data,
    EXISTS (SELECT 1 FROM runs WHERE runs.taskId=tasks.id AND COALESCE(json_extract(runs.data,'$.released'),0)=0) AS hasUnreleasedResolutionRun,
    EXISTS (SELECT 1 FROM runs WHERE runs.taskId=tasks.id
      AND COALESCE(json_extract(runs.data,'$.released'),0)=0
      AND json_extract(runs.data,'$.status') NOT IN ('finished','superseded')
      AND json_extract(runs.data,'$.completion') IS NULL
      AND json_extract(runs.data,'$.active') IS NOT 0
      AND (json_extract(runs.data,'$.agentId') IS NOT NULL OR json_extract(runs.data,'$.status') IN ('intent','uncertain'))) AS hasLiveRun
    FROM tasks WHERE json_extract(tasks.data,'$.removedAt') IS NULL AND json_extract(tasks.data,'$.phase') NOT IN ('done','cancelled') AND (
      json_extract(tasks.data,'$.phase') NOT IN ('done','cancelled') OR json_extract(tasks.data,'$.resolution.recoveryActive')=1 OR
      (json_extract(tasks.data,'$.resolution.mergeIntent')=1 AND json_extract(tasks.data,'$.resolution.mergedCommit') IS NULL) OR
      EXISTS (SELECT 1 FROM runs WHERE runs.taskId=tasks.id AND COALESCE(json_extract(runs.data,'$.released'),0)=0)
    ) ORDER BY tasks.rowid DESC`).all() as Array<Record<string, unknown>>).map(row => {
    const task = oracleTask(store, String(row.data));
    // Spec 058 (task 629): the projection and the retired full scan agree on
    // slot signals — any unreleased run, and a live-or-starting agent run.
    return Object.assign(task, { hasUnreleasedRun: taskHasUnreleasedRun(task, Boolean(row.hasUnreleasedResolutionRun)), hasLiveRun: Boolean(row.hasLiveRun) });
  });
const oracleLifecycle = (store: Store) => oracleRows(store, `SELECT data FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND (
  json_extract(data,'$.phase') NOT IN ('done','cancelled') OR (json_extract(data,'$.phase')='done' AND (
    ((json_extract(data,'$.reviewEntry') IS NULL OR json_extract(data,'$.reviewEntry.preserveWorkspace')=0) AND json_extract(data,'$.workspaceId') IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM json_each(json_extract(data,'$.resolution.archivedWorkspaceIds')) WHERE value=json_extract(tasks.data,'$.workspaceId')))
    OR (json_extract(data,'$.resolution.closeoutWorkspaceId') IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM json_each(json_extract(data,'$.resolution.archivedWorkspaceIds')) WHERE value=json_extract(tasks.data,'$.resolution.closeoutWorkspaceId')))
  ))) ORDER BY rowid DESC`);
const oracleUi = (store: Store) => oracleRows(store, `SELECT data FROM tasks
  WHERE json_extract(data, '$.removedAt') IS NULL AND (
    json_extract(data, '$.phase') NOT IN ('done','cancelled')
    OR COALESCE(json_extract(data, '$.originError'),'') <> ''
    OR COALESCE(json_extract(data, '$.originLookupError'),'') <> ''
    OR (json_extract(data, '$.resolution.mergeIntent') = 1 AND json_extract(data, '$.resolution.mergedCommit') IS NULL)
    OR json_extract(data, '$.resolution.archiveIntentWorkspaceId') IS NOT NULL
    OR COALESCE(json_extract(data, '$.resolution.cleanupReason'),'') <> ''
    OR EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.resolution.buildOutputCleanups')) WHERE json_extract(value, '$.state') IN ('intent','skipped','uncertain'))
    OR EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.resolution.runtimeRetirements')) WHERE json_extract(value, '$.state') IN ('pending','failed'))
    OR (json_extract(data, '$.resolution.closeoutWorkspaceIntent') = 1 AND json_extract(data, '$.resolution.closeoutWorkspaceId') IS NULL)
  ) ORDER BY rowid DESC`);
const oraclePendingRuns = (store: Store) =>
  (store.db.prepare(`SELECT runs.data FROM runs JOIN tasks ON tasks.id=runs.taskId
    WHERE json_extract(tasks.data,'$.removedAt') IS NULL
      AND (COALESCE(json_extract(runs.data,'$.released'),0)=0 OR json_extract(runs.data,'$.status')='superseded')
    ORDER BY runs.rowid`).all() as Array<Record<string, unknown>>).map(row => JSON.parse(String(row.data)));
const oracleTasks = (store: Store) => oracleRows(store,
  "SELECT data FROM tasks WHERE json_extract(data, '$.removedAt') IS NULL ORDER BY rowid DESC");
const oracleAllTasks = (store: Store) => oracleRows(store, "SELECT data FROM tasks ORDER BY rowid DESC");
const oracleRetirement = (store: Store) => oracleRows(store, `SELECT data FROM tasks WHERE json_extract(data,'$.removedAt') IS NULL AND EXISTS (
  SELECT 1 FROM json_each(json_extract(data,'$.resolution.runtimeRetirements'))
  WHERE json_extract(value,'$.state') IN ('pending','failed')) ORDER BY rowid DESC`);
const checkProjection = (store: Store, label: string) => {
  assert.deepEqual(store.liveTasks(), oracleLive(store), `${label}: liveTasks`);
  assert.deepEqual(store.maintenanceTasks(), oracleMaintenance(store), `${label}: maintenanceTasks`);
  const capacityIds = new Set(oracleCapacity(store).map(task => task.id));
  assert.ok(store.admissionCandidates().every(task => capacityIds.has(task.id)), `${label}: admission candidates are unfinished`);
  assert.deepEqual(store.lifecycleTasks(), oracleLifecycle(store), `${label}: lifecycleTasks`);
  assert.deepEqual(store.uiTasks(), oracleUi(store), `${label}: uiTasks`);
  assert.deepEqual(store.pendingRuns(), oraclePendingRuns(store), `${label}: pendingRuns`);
  assert.deepEqual(store.tasks(), oracleTasks(store), `${label}: tasks`);
  assert.deepEqual(store.allTasks(), oracleAllTasks(store), `${label}: allTasks`);
  assert.deepEqual(store.retirementTasks(), oracleRetirement(store), `${label}: retirementTasks`);
  const snapshot = store.liveSnapshot({});
  assert.deepEqual(snapshot.tasks, oracleLive(store).map(task => compactLiveTask(task)), `${label}: liveSnapshot`);
  assert.equal(snapshot.hasMore, false, `${label}: liveSnapshot fits one page`);
};

test('incremental projection matches full scans after mixed writes', async () => {
  const { runSchema } = await import('../shared/contracts');
  const store = new Store(':memory:');
  try {
    const ids: Record<string, string> = {};
    for (const name of ['queued', 'working', 'done-kept', 'done-archived', 'done-error', 'cancelled-hold', 'checkpoint',
      'run-open', 'run-released', 'run-superseded', 'removed', 'merge-intent', 'recovery-active', 'attention',
      'no-eligible', 'recovery-run', 'closeout-intent', 'build-cleanup', 'retirement', 'closeout-ws', 'lookup-error',
      'archive-intent', 'cleanup-reason']) ids[name] = insert(store, `proj-${name}`).id;
    const put = (id: string, taskId: string, released: boolean, status = 'finished') => store.putRun(runSchema.parse({
      id, taskId, role: 'reviewer', generation: 1, head, base: head, agentId: null, workspaceId: 'w', profile: null, status,
      createdAt: new Date(0).toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released,
    }));
    const patch = (name: string, change: Record<string, unknown>) =>
      store.update(ids[name], { ...change, ...(change.resolution ? { resolution: { ...store.task(ids[name]).resolution, ...(change.resolution as Record<string, unknown>) } } : {}) } as never);
    store.update(ids.working, { phase: 'working', reason: 'dispatched' } as never);
    patch('done-kept', { phase: 'done', workspaceId: 'ws-kept' });
    patch('done-archived', { phase: 'done', workspaceId: 'ws-old', resolution: { archivedWorkspaceIds: ['ws-old'] } });
    patch('done-error', { phase: 'done', originError: 'boom' });
    patch('cancelled-hold', { phase: 'cancelled', disposition: { kind: 'cancel', status: 'needs_attention', requestedAt: new Date(0).toISOString(), requestedBy: 'op', reason: 'hold', workDisposition: 'preserve' } });
    patch('checkpoint', { checkpoints: { records: [], intent: { id: 'ck', ordinal: 1, summary: 's', head, runId: 'r', eventId: 'e', status: 'pending', createdAt: new Date(0).toISOString(), deliveredAt: null, attempts: 0, error: '' } } });
    put('proj-run-open', ids['run-open'], false);
    put('proj-run-released', ids['run-released'], true);
    put('proj-run-superseded', ids['run-superseded'], true, 'superseded');
    put('proj-run-removed', ids.removed, false);
    store.update(ids.removed, { removedAt: new Date(0).toISOString() } as never);
    patch('merge-intent', { phase: 'done', resolution: { mergeIntent: true, mergedCommit: null } });
    patch('recovery-active', { phase: 'done', resolution: { recoveryActive: true } });
    patch('attention', { phase: 'done', resolution: { attention: true } });
    patch('no-eligible', { phase: 'done', reason: 'No eligible profile for this lane', resolution: { roleReplacements: 1 } });
    put('proj-recovery-run', ids['recovery-run'], false);
    patch('recovery-run', { phase: 'done', resolution: { recovery: { id: 'rec', key: 'k', generation: 1, runId: 'proj-recovery-run', agentId: null, status: 'pending', summary: 's', idleSince: null, incidentId: null } } });
    patch('closeout-intent', { phase: 'done', resolution: { closeoutWorkspaceIntent: true, closeoutWorkspaceId: null } });
    patch('build-cleanup', { phase: 'done', resolution: { buildOutputCleanups: [{ workspaceId: 'w', directory: '/w', state: 'intent', detail: '', at: new Date(0).toISOString() }] } });
    patch('retirement', { phase: 'done', resolution: { runtimeRetirements: [{ workspaceId: 'w', directory: '/w', scope: null, state: 'pending', capturedAt: new Date(0).toISOString(), provedAt: null, attempts: 0, error: '', outputTail: '', nextAttemptAt: null }] } });
    patch('closeout-ws', { phase: 'done', resolution: { closeoutWorkspaceId: 'ws-closeout' } });
    patch('lookup-error', { phase: 'done', originLookupError: 'gone' });
    patch('archive-intent', { phase: 'done', resolution: { archiveIntentWorkspaceId: 'ws-archive' } });
    patch('cleanup-reason', { phase: 'done', resolution: { cleanupReason: 'scope left files' } });
    checkProjection(store, 'mixed writes');
    // Non-task writes (events, notices, outcomes) must not disturb the projection.
    store.event(ids.queued, 'probe', 'activity');
    store.putNotice({ id: 'notice-1', taskId: ids.queued, agentId: 'a', recipientAgentId: 'a', workspaceId: 'w',
      sources: ['origin'], originEntry: false, kind: 'attention', status: 'pending', error: '', text: 't' });
    checkProjection(store, 'after event and notice writes');
    // A rolled-back transaction leaves no projected row behind.
    assert.throws(() => store.transaction(() => {
      insert(store, 'proj-rolled-back');
      store.update(ids.queued, { reason: 'rolled back' });
      put('proj-run-rolled-back', ids.queued, false);
      throw new Error('rollback');
    }), /rollback/);
    checkProjection(store, 'after rollback');
    assert.equal(store.pendingRuns().some(run => run.id === 'proj-run-rolled-back'), false);
    // Releasing and re-adding runs updates the slot and lease lists in place.
    put('proj-run-open', ids['run-open'], true);
    checkProjection(store, 'after run release');
    put('proj-run-open', ids['run-open'], false);
    checkProjection(store, 'after run reopen');
  } finally { store.close(); }
});

test('incremental projection matches full scans across a purge', () => {
  const store = new Store(':memory:');
  try {
    const live = insert(store, 'purge-live');
    const old = insert(store, 'purge-old');
    const ancient = new Date(Date.now() - 20 * 86400000).toISOString();
    store.update(old.id, { phase: 'done', removedAt: ancient, finishedAt: ancient } as never);
    checkProjection(store, 'before purge');
    const purged = store.purgeOldTasks(Date.now());
    assert.deepEqual(purged, [old.id]);
    checkProjection(store, 'after purge');
    assert.equal(store.liveTasks().map(task => task.id).includes(live.id), true);
  } finally { store.close(); }
});

test('funnel writes reuse the projection; only an out-of-funnel write rebuilds it', async () => {
  const { runSchema } = await import('../shared/contracts');
  const store = new Store(':memory:');
  try {
    const task = insert(store, 'reuse-1');
    assert.deepEqual(store.liveTasks().map(t => t.id), [task.id]);
    const live = (store as any).tasksStore.taskProjection;
    assert.ok(live, 'first read builds the projection');
    store.update(task.id, { reason: 'funnel write' });
    store.event(task.id, 'probe', 'non-task writes never touch the projection');
    store.putRun(runSchema.parse({ id: 'reuse-run', taskId: task.id, role: 'reviewer', generation: 1, head, base: head,
      agentId: null, workspaceId: 'w', profile: null, status: 'finished', createdAt: new Date(0).toISOString(),
      lastObservedAt: null, active: null, idleSince: null, completion: null, released: false }));
    assert.deepEqual(store.liveTasks().map(t => t.id), [task.id]);
    assert.deepEqual(store.pendingRuns().map(r => r.id), ['reuse-run']);
    assert.equal((store as any).tasksStore.taskProjection, live, 'no rebuild across funnel writes');
    store.db.prepare("UPDATE tasks SET data=json_set(data,'$.reason','direct') WHERE id=?").run(task.id);
    assert.equal(store.task(task.id).reason, 'direct', 'an out-of-funnel write is still read fresh');
    assert.notEqual((store as any).tasksStore.taskProjection, live, 'the out-of-funnel write rebuilds once');
    const rebuilt = (store as any).tasksStore.taskProjection;
    store.update(task.id, { reason: 'funnel again' });
    assert.deepEqual(store.liveTasks().map(t => t.id), [task.id]);
    assert.equal((store as any).tasksStore.taskProjection, rebuilt, 'live again after the rebuild');
  } finally { store.close(); }
});

test('plan entries refuse a multi-line doneWhen (Spec 041, contract 008 at 72465d6)', async () => {
  // nucleus#086: Nucleus SetProjectPlan refuses CR/LF, so a Queue-saved multi-line value would not import.
  const { planEntrySchema } = await import('../shared/contracts');
  assert.equal(planEntrySchema.safeParse({ lane: 'alpha', doneWhen: 'Alpha shipped' }).success, true);
  for (const bad of ['Alpha\nshipped', 'Alpha\rshipped', 'Alpha\r\nshipped'])
    assert.equal(planEntrySchema.safeParse({ lane: 'alpha', doneWhen: bad }).success, false, JSON.stringify(bad));
});
