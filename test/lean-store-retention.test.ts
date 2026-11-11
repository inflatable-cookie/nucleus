import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, CURRENT_SCHEMA, HOST_RUN_KEEP_PER_SELECTOR, PROJECT_QA_KEEP_PER_REPOSITORY, ASSIGNMENT_HISTORY_KEEP } from '../core/store/store';
import { submissionSchema, type Task } from '../shared/contracts';
import { hookRecordSchema, type HookRecord } from '../shared/hooks';
import { reapHookCheckouts } from '../core/hooks/hook-cleanup';

/**
 * Lean store 2 (task 987): the retention windows for rows that outlive their task or run.
 *
 * Each rule runs through the store's own prune, purge or reaper on a real file-backed store, and
 * every case names what must survive: unsettled rows, live rows and anything a live row still
 * points at. The schema-52 step runs the same windows on open of a schema-51 store.
 */

const day = 86_400_000;
const HEAD = 'a'.repeat(40);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function fixture(name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nsq-lean2-${name}-`)));
  const store = new Store(join(dir, 'queue.sqlite'));
  const add = (id: string): Task => store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: join(dir, 'repo'), planningCommit: HEAD,
    handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', HEAD, {});
  const finish = (task: Task, finishedAt = ago(10 * day)): Task => {
    store.update(task.id, { phase: 'done' });
    store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(finishedAt, task.id);
    return store.task(task.id);
  };
  return { dir, store, add, finish, close() { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

const count = (store: Store, sql: string, ...params: string[]) => Number((store.db.prepare(sql).get(...params) as { n: number }).n);
const prune = (store: Store) => store.transaction(() => store.pruneRetainedRows(Date.now()));

test('operations: a finished operation of a purged task keeps 30 days; unsettled, live and task-less rows stay', () => {
  const f = fixture('operations');
  try {
    const live = f.add('live').id;
    const insert = (id: string, state: string, taskId: string | null, settledAt: string) => f.store.db.prepare(
      'INSERT INTO operations(id,key,kind,inputHash,state,taskId,createdAt,payload,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, `key-${id}`, 'task_control', 'h', state, taskId, settledAt, '{}', JSON.stringify({ id, state, settledAt }));
    insert('old-gone', 'succeeded', 'purged-task', ago(40 * day));
    insert('recent-gone', 'succeeded', 'purged-task', ago(5 * day));
    insert('pending-gone', 'pending', 'purged-task', ago(40 * day));
    insert('attention-gone', 'needs_attention', 'purged-task', ago(40 * day));
    insert('old-live', 'failed', live, ago(40 * day));
    insert('old-taskless', 'succeeded', null, ago(40 * day));

    prune(f.store);
    const left = f.store.db.prepare('SELECT id FROM operations ORDER BY id').all().map(row => String(row.id));
    assert.deepEqual(left, ['attention-gone', 'old-live', 'old-taskless', 'pending-gone', 'recent-gone']);
  } finally { f.close(); }
});

test('per-task meta: a purged task takes its check-policy observation; a live task keeps it; a backlog key goes', () => {
  const f = fixture('meta');
  try {
    const gone = f.finish(f.add('done-gone'));
    const live = f.add('live');
    f.store.setMeta(`checkPolicyObservation:${gone.id}`, { observed: true });
    f.store.setMeta(`checkPolicyObservation:${live.id}`, { observed: true });
    f.store.setMeta('checkPolicyObservation:orphan-task', { observed: true });
    assert.deepEqual(f.store.purgeOldTasks(Date.now()), [gone.id]);
    assert.equal(f.store.getMeta(`checkPolicyObservation:${gone.id}`), undefined, 'the purged task owns no observation afterwards');
    assert.ok(f.store.getMeta(`checkPolicyObservation:${live.id}`), 'a live task keeps its observation');
    prune(f.store);
    assert.equal(f.store.getMeta('checkPolicyObservation:orphan-task'), undefined, 'a key whose task is already gone is cleared by the window');
  } finally { f.close(); }
});

test('QA schedule merges: only a repository with a schedule keeps its rows', () => {
  const f = fixture('qa-merges');
  try {
    f.store.db.prepare('INSERT INTO repository_settings(key,data) VALUES(?,?)').run('acme/unscheduled',
      JSON.stringify({ repository: { origin: 'acme/unscheduled', path: '/x' }, qa: {} }));
    f.store.db.prepare('INSERT INTO repository_settings(key,data) VALUES(?,?)').run('acme/scheduled',
      JSON.stringify({ repository: { origin: 'acme/scheduled', path: '/y' }, qa: { schedule: { maxIntervalHours: 24, afterMerges: 1 } } }));
    for (const [taskId, repository] of [['t1', 'acme/unscheduled'], ['t2', 'acme/scheduled'], ['t3', 'acme/unscheduled']])
      f.store.db.prepare('INSERT INTO qa_schedule_merges(taskId,repository) VALUES(?,?)').run(taskId, repository);
    prune(f.store);
    assert.deepEqual(f.store.db.prepare('SELECT taskId FROM qa_schedule_merges').all().map(row => String(row.taskId)), ['t2'],
      'the unscheduled backlog is deleted; the scheduled repository keeps its unreconciled merge');
  } finally { f.close(); }
});

test('project and lane notices and events: settled entries expire after 30 days; pending, recent and task rows stay', () => {
  const f = fixture('notices');
  try {
    const notice = (id: string, taskId: string, status: string) => f.store.db.prepare('INSERT INTO notices(id,taskId,data) VALUES(?,?,?)')
      .run(id, taskId, JSON.stringify({ id, taskId, status }));
    const oldDrain = `lane-drain:consumer:${ago(40 * day)}`, oldAim = `next-aim:'project-c':${ago(40 * day)}`;
    const pendingAim = `pending-aim:'project-c':${ago(40 * day)}`, recentDrain = `lane-drain:consumer:${ago(2 * day)}`;
    const taskNotice = `attention:${ago(40 * day)}`;
    notice(oldDrain, 'lane:consumer', 'delivered');
    notice(oldAim, 'project:project-c', 'superseded');
    notice(pendingAim, 'project:project-c', 'pending');
    notice(recentDrain, 'lane:consumer', 'delivered');
    notice(taskNotice, 'task-1', 'delivered');
    const event = (taskId: string, at: string) => f.store.db.prepare('INSERT INTO events(taskId,at,kind,detail) VALUES(?,?,?,?)').run(taskId, at, 'project_owner_assigned', '{}');
    event('project:project-c', ago(40 * day));
    event('project:project-c', ago(3 * day));
    event('task-1', ago(40 * day));

    prune(f.store);
    const left = f.store.db.prepare('SELECT id FROM notices ORDER BY id').all().map(row => String(row.id)).sort();
    assert.deepEqual(left, [pendingAim, recentDrain, taskNotice].sort(), 'only the old settled project and lane notices go');
    assert.equal(count(f.store, "SELECT COUNT(*) AS n FROM events WHERE taskId LIKE 'project:%'"), 1, 'only the recent project event stays');
    assert.equal(count(f.store, "SELECT COUNT(*) AS n FROM events WHERE taskId='task-1'"), 1, 'task events are not touched by this rule');
  } finally { f.close(); }
});

test('host runs: the latest 50 settled per selector stay, with unsettled, custody-held rows and sidecars', () => {
  const f = fixture('host-runs');
  try {
    const run = (id: string, selector: string, state: string) => f.store.db.prepare('INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
      .run(id, 'acme/repo', state, JSON.stringify({ id, selector, state }));
    // Inserted oldest first, so rowid order is submission order.
    run('queued-old', 'sel', 'queued');
    run('custody', 'sel', 'settled');
    for (let i = 0; i < HOST_RUN_KEEP_PER_SELECTOR + 4; i++) run(`s-${i}`, 'sel', 'settled');
    run('other-selector', 'other', 'settled');
    run('running-now', 'sel', 'running');
    f.store.setMeta('hostRunAccountingDisposition:custody', { disposition: 'accounting_retired', disposedAt: ago(day) });
    f.store.setMeta('hostRunIdentity:s-0', { ok: true });
    f.store.setMeta('hostRunCpuCoverage:s-0', { ok: true });
    f.store.setMeta('hostRunIdentity:s-40', { ok: true });

    prune(f.store);
    const left = new Set(f.store.db.prepare('SELECT id FROM host_run_records').all().map(row => String(row.id)));
    // 'sel' settled rows, newest first: s-53..s-4 are the window; s-0..s-3 and custody rank beyond it.
    assert.equal(left.size, 1 + 1 + 1 + HOST_RUN_KEEP_PER_SELECTOR + 1, 'queued, running, custody, the window and the other selector remain');
    assert.ok(left.has('queued-old') && left.has('running-now'), 'unsettled rows are never pruned');
    assert.ok(left.has('custody'), 'a settled run whose accounting retirement is inside the history window stays');
    assert.ok(left.has('other-selector'), 'the window is per selector');
    assert.ok(left.has(`s-${HOST_RUN_KEEP_PER_SELECTOR + 3}`) && left.has('s-4'), 'the newest 50 settled stay');
    assert.ok(!left.has('s-0') && !left.has('s-3'), 'settled rows beyond the newest 50 are removed');
    assert.equal(f.store.getMeta('hostRunIdentity:s-0'), undefined, 'a pruned run takes its identity sidecar');
    assert.equal(f.store.getMeta('hostRunCpuCoverage:s-0'), undefined, 'and its CPU sidecar');
    assert.ok(f.store.getMeta('hostRunIdentity:s-40'), 'a kept run keeps its sidecar');
  } finally { f.close(); }
});

test('project QA runs: the latest 50 per repository stay, with active, referenced and latest green runs', () => {
  const f = fixture('qa-runs');
  try {
    const run = (id: string, repository: string, state: string) => f.store.db.prepare('INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)')
      .run(id, repository, JSON.stringify({ id, repository, state, baseBranch: 'main' }));
    run('green-old', 'acme/repo', 'passed');
    run('red-referenced', 'acme/repo', 'failed');
    run('active-old', 'acme/repo', 'running');
    for (let i = 0; i < PROJECT_QA_KEEP_PER_REPOSITORY + 5; i++) run(`red-${i}`, 'acme/repo', 'failed');
    run('other-repo-old', 'acme/other', 'failed');
    f.store.db.prepare('INSERT INTO project_qa_latest(key,id) VALUES(?,?)').run('acme/repo', 'red-referenced');

    prune(f.store);
    const left = new Set(f.store.db.prepare('SELECT id FROM project_qa_runs').all().map(row => String(row.id)));
    assert.ok(left.has('active-old'), 'an active run is never pruned');
    assert.ok(left.has('red-referenced'), 'a run a status row still names is never pruned');
    assert.ok(left.has('green-old'), 'the latest passing main run of its repository is never pruned');
    assert.ok(left.has('other-repo-old'), 'the window is per repository');
    assert.ok(left.has(`red-${PROJECT_QA_KEEP_PER_REPOSITORY + 4}`), 'the newest 50 stay');
    assert.ok(!left.has('red-0'), 'an older failed run beyond the window goes');
  } finally { f.close(); }
});

test('retained output failures whose run is gone settle; assignment history keeps 50', () => {
  const f = fixture('failures');
  try {
    f.store.db.prepare('INSERT INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)').run('kept-run', 'acme/repo', 'settled', JSON.stringify({ id: 'kept-run', selector: 's', state: 'settled' }));
    const failure = (runId: string) => f.store.db.prepare('INSERT INTO host_run_output_failures(runId,epoch,firstSeen,lastSeen,attempts,nextRetryAt,reason,streams) VALUES(?,?,?,?,?,?,?,?)')
      .run(runId, 1, ago(day), ago(day), 3, ago(-day), 'retained output absent', null);
    failure('kept-run');
    failure('gone-run');
    for (let i = 0; i < ASSIGNMENT_HISTORY_KEEP + 10; i++) f.store.db.prepare('INSERT INTO assignment_history(group_id,profile_id,at) VALUES(?,?,?)').run('g', `p${i}`, ago(day));

    prune(f.store);
    assert.deepEqual(f.store.db.prepare('SELECT runId FROM host_run_output_failures').all().map(row => String(row.runId)), ['kept-run']);
    assert.equal(count(f.store, 'SELECT COUNT(*) AS n FROM assignment_history'), ASSIGNMENT_HISTORY_KEEP);
  } finally { f.close(); }
});

test('hook reaper: a settled occurrence that names no checkout is reconciled; an unsettled one is kept', async () => {
  const f = fixture('hook-orphans');
  try {
    const task = f.add('hooked');
    const record = (eventId: string, state: HookRecord['state']) => hookRecordSchema.parse({
      id: `hook-${eventId}`, taskId: task.id, hookId: 'closeout', event: 'task.closeout', eventId, occurrence: 1,
      mode: 'integration_write', delivery: 'required', state,
      manifest: { path: '.paseo/queue.json', commit: HEAD, digest: `sha256:${'a'.repeat(64)}` },
      program: { kind: 'repository', executable: { path: '.paseo/hooks/closeout', commit: HEAD, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
      instruction: null, baseBranch: 'main', baseCommit: HEAD, attempt: 1, timeoutMs: 10_000, maxOutputBytes: 65_536,
      allowedPaths: ['docs/'], commitSubject: { prefix: 'queue: closeout', maxBytes: 80 }, eventDigest: 'b'.repeat(64),
      eventPayload: null, workspace: null, processId: null, result: null, commit: null, remote: null,
      summary: '', error: '', createdAt: ago(10 * day), updatedAt: ago(10 * day), reconciledAt: null,
    });
    f.store.putHookEvent(record('a'.repeat(48), 'published'));
    f.store.putHookEvent(record('b'.repeat(48), 'running'));
    // The task goes; its occurrences are the orphans the pre-fix reaper skipped forever.
    f.store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);

    const health = await reapHookCheckouts(f.store);
    assert.equal(health.reconciledCount, 1, 'the settled record with no checkout holds none and is reconciled');
    assert.deepEqual(f.store.db.prepare('SELECT eventId FROM hook_events').all().map(row => String(row.eventId)), ['b'.repeat(48)],
      'the unsettled record may still own a checkout and stays');
  } finally { f.close(); }
});

test('the freed pages of a prune are released to the file, in bounded passes', () => {
  const f = fixture('reclaim');
  try {
    const detail = 'x'.repeat(1024);
    f.store.transaction(() => { for (let i = 0; i < 4000; i++) f.store.event('lane:bulk', 'bulk', detail); });
    f.store.transaction(() => f.store.db.prepare("DELETE FROM events WHERE taskId='lane:bulk'").run());
    assert.ok(f.store.storeFacts().freePages > 1000, 'the delete left a freelist behind');
    const pass = f.store.reclaimFreedPages({ maxPages: 1200, budgetMs: 10_000 });
    assert.ok(pass.pages > 0, 'a pass releases pages');
    assert.ok(pass.pages <= 1200 + 256, 'a pass stays inside its page budget, plus at most one chunk');
    assert.ok(pass.fileBytesAfter < pass.fileBytesBefore, 'the file gets smaller');
    assert.equal(pass.error, null);
  } finally { f.close(); }
});

test('the schema-52 step runs the same windows on open of a schema-51 store', () => {
  const f = fixture('migrate');
  try {
    f.finish(f.add('done'));
    for (let i = 0; i < ASSIGNMENT_HISTORY_KEEP + 3; i++) f.store.db.prepare('INSERT INTO assignment_history(group_id,profile_id,at) VALUES(?,?,?)').run('g', `p${i}`, ago(day));
    f.store.db.prepare("UPDATE meta SET value='51' WHERE key='schema'").run();
    f.store.close();
    const reopened = new Store(join(f.dir, 'queue.sqlite'));
    try {
      assert.equal(Number(JSON.parse(String(reopened.db.prepare("SELECT value FROM meta WHERE key='schema'").get()!.value))), CURRENT_SCHEMA);
      assert.equal(count(reopened, 'SELECT COUNT(*) AS n FROM assignment_history'), ASSIGNMENT_HISTORY_KEEP, 'the backlog is trimmed on open');
    } finally { reopened.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
