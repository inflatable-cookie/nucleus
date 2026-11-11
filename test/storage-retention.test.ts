import { isolationRootFor, isolationDataDirFor } from '../core/hooks/hooks';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { hookRecordSchema, type HookRecord } from '../shared/hooks';
import { submissionSchema, type Task } from '../shared/contracts';
import { command, git } from '../core/git/index';
import { reapHookCheckouts } from '../core/hooks/hook-cleanup';
import { HOOK_CLEANUP_ERROR_LIMIT, hookRetentionBlocksPurge } from '../core/hooks/hook-retention';
import { buildOutputCleanupHooks } from '../core/workspaces/worktree-cleanup';
import { Leads } from '../core/planning/leads';

/**
 * Audit B2/B5/B7/B8/B10/A10 receipts (2026-10-25 performance audit, main at d5e20937).
 *
 * Each test drives the production route rather than a stand-in: the real store, the real
 * reaper against a real Git repository, the real cleanup hook builder and the real lead
 * service. The parent shape is reproduced inside the test where the audit's claim is that
 * a read or a retention rule changed, so a failing expectation names the old behaviour.
 */

const day = 86_400_000;
const HEAD = 'a'.repeat(40);
const stamp = (offsetDays = 0) => new Date(Date.now() + offsetDays * day).toISOString();

function fixture(name: string) {
  // The reaper compares recorded checkout paths with Git's own resolved common
  // directory, so the fixture root is its real path (a temp root is a symlink on macOS).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nsq-${name}-`)));
  const store = new Store(join(dir, 'queue.sqlite'));
  const submit = (id: string) => submissionSchema.parse({ submissionId: id, title: id, repoPath: join(dir, 'repo'), planningCommit: HEAD,
    handoffPath: 'handoff.md', originAgentId: 'origin' });
  const add = (id: string, extra: Partial<Task> = {}) => {
    const task = store.insert(submit(id), 'host', 'handoff', HEAD, extra);
    return task;
  };
  const finish = (id: string, finishedAt = stamp(-10)) => {
    store.update(id, { phase: 'done' });
    store.db.prepare("UPDATE tasks SET data=json_set(data,'$.finishedAt',?) WHERE id=?").run(finishedAt, id);
    return store.task(id);
  };
  return { dir, store, submit, add, finish, close() { try { store.close(); } catch { /* already closed by the test */ } rmSync(dir, { recursive: true, force: true }); } };
}

function hookRecord(taskId: string, overrides: Partial<HookRecord> = {}): HookRecord {
  const eventId = overrides.eventId ?? 'e'.repeat(48);
  return hookRecordSchema.parse({
    id: `hook-${eventId}-${Math.random().toString(16).slice(2)}`, taskId, hookId: 'closeout', event: 'task.closeout', eventId, occurrence: 1,
    mode: 'integration_write', delivery: 'required', state: 'published',
    manifest: { path: '.paseo/queue.json', commit: HEAD, digest: `sha256:${'a'.repeat(64)}` },
    program: { kind: 'repository', executable: { path: '.paseo/hooks/closeout', commit: HEAD, digest: `sha256:${'c'.repeat(64)}` }, argv: [] },
    instruction: null, baseBranch: 'main', baseCommit: HEAD, attempt: 1, timeoutMs: 10_000, maxOutputBytes: 65_536,
    allowedPaths: ['docs/'], commitSubject: { prefix: 'queue: closeout', maxBytes: 80 }, eventDigest: 'b'.repeat(64),
    eventPayload: null, workspace: null, processId: null, result: null, commit: null, remote: null,
    summary: '', error: '', createdAt: stamp(-10), updatedAt: stamp(-10), reconciledAt: null,
    ...overrides,
  });
}

test('B5: a task keeps its history while an owned hook checkout exists, and the purge removes its hook rows with it', () => {
  const f = fixture('hook-purge');
  try {
    const checkout = join(f.dir, 'owned-checkout');
    mkdirSync(checkout);
    const task = f.finish(f.add('done-with-hook').id);
    f.store.putHookEvent(hookRecord(task.id, { workspace: { path: checkout, head: HEAD } }));

    // The settlement gate refuses: the record names a checkout Queue still owns.
    assert.deepEqual(f.store.purgeOldTasks(Date.now()), [], 'an existing owned checkout keeps the whole task history');
    assert.equal(f.store.task(task.id).phase, 'done');
    assert.equal(f.store.hookEvents(task.id).length, 1);
    assert.deepEqual(f.store.retentionCandidates(Date.now()).map(candidate => candidate.id), [task.id],
      'the candidate list still names it, so the reaper can clear the checkout first');

    // Once the checkout is gone the same pass deletes the task and its occurrences.
    rmSync(checkout, { recursive: true, force: true });
    assert.deepEqual(f.store.purgeOldTasks(Date.now()), [task.id]);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM hook_events').get()!.n, 0, 'no orphan occurrence outlives its task');
    assert.throws(() => f.store.task(task.id), /purged/);
  } finally { f.close(); }
});

test('B5: the pre-fix retention shape leaves orphan hook rows, and an unresolved occurrence still blocks the purge', () => {
  const f = fixture('hook-parent');
  try {
    const task = f.finish(f.add('done-with-hook').id);
    f.store.putHookEvent(hookRecord(task.id, { state: 'published' }));
    // An occurrence whose execution never settled keeps the task: unknown delivery is not gone,
    // whether or not its recorded checkout still exists (review 5644182473, verdict
    // `b5-purge-unresolved-delivery`: a gone path must not stand in for a settled delivery).
    f.store.putHookEvent(hookRecord(task.id, { eventId: 'f'.repeat(48), state: 'running', workspace: null }));
    assert.deepEqual(f.store.purgeOldTasks(Date.now()), [], 'a running occurrence is unresolved ownership');
    assert.equal(f.store.hookEvents(task.id).length, 2);
  } finally { f.close(); }

  // The reviewed defect fixture: every unsettled state, each with a recorded checkout path
  // that no longer exists, keeps the task and its occurrences.
  for (const state of ['running', 'uncertain', 'intent'] as const) {
    const unsettled = fixture(`hook-parent-${state}`);
    try {
      const task = unsettled.finish(unsettled.add('done-with-hook').id);
      const gone = join(unsettled.dir, 'gone-checkout');
      unsettled.store.putHookEvent(hookRecord(task.id, { state, workspace: { path: gone, head: HEAD } }));
      assert.equal(existsSync(gone), false, `${state}: the recorded checkout is gone`);
      const record = unsettled.store.hookEvents(task.id)[0];
      assert.equal(hookRetentionBlocksPurge(record, () => false), true,
        `${state}: an unsettled occurrence blocks on its state alone, with no checkout to find`);
      assert.deepEqual(unsettled.store.purgeOldTasks(Date.now()), [], `${state}: unresolved delivery blocks the purge even with an absent recorded path`);
      assert.equal(unsettled.store.hookEvents(task.id).length, 1, `${state}: the occurrence is kept`);
    } finally { unsettled.close(); }
  }

  // The gate is not a blanket hold: a settled occurrence whose checkout is gone never blocks.
  const settled = fixture('hook-parent-settled');
  try {
    const task = settled.finish(settled.add('done-with-hook').id);
    settled.store.putHookEvent(hookRecord(task.id, { state: 'published', workspace: { path: join(settled.dir, 'gone-checkout'), head: HEAD } }));
    assert.equal(hookRetentionBlocksPurge(settled.store.hookEvents(task.id)[0], () => false), false,
      'a settled occurrence blocks only for a checkout that exists');
    assert.deepEqual(settled.store.purgeOldTasks(Date.now()), [task.id], 'a settled occurrence with an absent checkout purges normally');
  } finally { settled.close(); }

  // Parent falsification: the pre-fix purge deleted every other per-task table by name and
  // left hook_events behind, which is the 10,460-row growth the audit measured.
  const parent = fixture('hook-parent-old');
  try {
    const task = parent.finish(parent.add('done-with-hook').id);
    parent.store.putHookEvent(hookRecord(task.id));
    for (const table of ['events', 'runs', 'notices']) parent.store.db.prepare(`DELETE FROM ${table} WHERE taskId=?`).run(task.id);
    parent.store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    assert.equal(parent.store.db.prepare('SELECT COUNT(*) AS n FROM hook_events WHERE taskId=?').get(task.id)!.n, 1,
      'the old purge left the occurrence orphaned');
  } finally { parent.close(); }
});

test('B5: the reaper reconciles an orphan only when its recorded checkout is positively absent, and skips purged tasks', async () => {
  const f = fixture('hook-orphan');
  try {
    const task = f.finish(f.add('orphan').id);
    const gone = join(f.dir, 'gone-checkout');
    const present = join(f.dir, 'present-checkout');
    mkdirSync(present);
    f.store.putHookEvent(hookRecord(task.id, { eventId: '1'.repeat(48), workspace: { path: gone, head: HEAD } }));
    f.store.putHookEvent(hookRecord(task.id, { eventId: '2'.repeat(48), workspace: { path: present, head: HEAD } }));
    // A settled occurrence that never recorded a checkout holds none (hook-retention.ts), so the
    // orphan reaper reconciles it (task 987); an unsettled one may still own a checkout and stays.
    f.store.putHookEvent(hookRecord(task.id, { eventId: '3'.repeat(48), workspace: null }));
    f.store.putHookEvent(hookRecord(task.id, { eventId: '4'.repeat(48), state: 'running', workspace: null }));
    // Simulate the pre-fix orphans: the task row is gone, the occurrences are not.
    f.store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);

    const health = await reapHookCheckouts(f.store);
    assert.equal(health.reconciledCount, 2, 'the row whose checkout is absent and the settled row with no checkout are reconciled');
    assert.equal(health.remainingCount, 1, 'the row whose checkout exists is kept and stays visible');
    const left = f.store.db.prepare('SELECT data FROM hook_events ORDER BY rowid').all().map(row => hookRecordSchema.parse(JSON.parse(String(row.data))).eventId);
    assert.deepEqual(left, ['2'.repeat(48), '4'.repeat(48)], 'nothing is deleted while an owned path might exist or an unsettled occurrence might own one');
    assert.ok(existsSync(present));
    assert.equal(health.errorCount, 0, 'a purged task is skipped, not an error per occurrence');
    // Idempotent: a second pass reconciles nothing new.
    assert.equal((await reapHookCheckouts(f.store)).reconciledCount, 0);
  } finally { f.close(); }
});

test('A10: the reaper bounds carried errors by count while keeping each identity and reason', async () => {
  const f = fixture('hook-errors');
  try {
    const repo = join(f.dir, 'repo');
    mkdirSync(repo);
    await command('git', ['init', '-q', repo], f.dir);
    const task = f.add('terminal-hooks');
    f.store.update(task.id, { repoPath: repo, phase: 'done' });
    const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const root = isolationRootFor(isolationDataDirFor(f.store), common);
    mkdirSync(root, { recursive: true });
    const outside = join(f.dir, 'outside');
    mkdirSync(outside);
    const count = HOOK_CLEANUP_ERROR_LIMIT + 7;
    for (let index = 0; index < count; index++) {
      const eventId = index.toString(16).padStart(2, '0').repeat(24);
      // A symlinked checkout is refused by the ownership root proof, once per occurrence.
      symlinkSync(outside, join(root, eventId));
      f.store.putHookEvent(hookRecord(task.id, { eventId, workspace: { path: join(root, eventId), head: HEAD } }));
    }
    const health = await reapHookCheckouts(f.store);
    assert.equal(health.errorCount, count, 'every refusal is counted');
    assert.equal(health.errors.length, HOOK_CLEANUP_ERROR_LIMIT, 'the carried list is bounded');
    assert.match(health.errors[0], /^[0-9a-f]{48}: /, 'each carried entry names its occurrence');
    assert.match(health.errors[0], /not a real Queue-owned directory/, 'and its reason');
    assert.equal(existsSync(join(outside, 'safe')), false);
  } finally { f.close(); }
});

test('B8: an identical cleanup observation writes no event, and a changed one still does', () => {
  const f = fixture('cleanup-repeat');
  try {
    const directory = join(f.dir, 'checkout');
    mkdirSync(directory);
    const task = f.add('cleanup', { workspaceId: 'ws-1' });
    const hooks = buildOutputCleanupHooks(f.store, task.id, 'ws-1', directory, () => true);
    const events = () => f.store.eventsAll(task.id).filter(event => event.kind.startsWith('build_output_cleanup_'));
    const result = { detail: 'Removed task-local Cargo target output at /checkout/target', removed: true, safe: true };
    hooks.observed(result);
    assert.equal(events().length, 1);
    const version = f.store.task(task.id).version;
    for (let index = 0; index < 5; index++) hooks.observed({ ...result });
    assert.equal(events().length, 1, 'a repeated identical observation is not a new fact');
    assert.equal(f.store.task(task.id).version, version, 'and rewrites no task row');
    hooks.observed({ ...result, detail: `${result.detail}; first failure: /checkout/target: Git reports tracked files` });
    assert.equal(events().length, 2, 'a new detail is kept');
    assert.match(events()[1].detail, /first failure: .*Git reports tracked files$/);
    assert.equal(f.store.task(task.id).resolution.buildOutputCleanups[0]!.state, 'complete');
  } finally { f.close(); }
});

test('B7: a lead detail reads every version but only the current body, and the checks read one exact version', () => {
  const f = fixture('lead-history');
  try {
    const leads = new Leads(f.store);
    const repository = { origin: 'audit/repository', path: '/audit' };
    let lead = f.store.addLead({ id: 'ledger', title: 'Ledger', body: 'body 1', repositories: [repository], lanes: ['lane-a'],
      author: 'owner', state: 'open', version: 1, dropReason: null, targets: [], source: null, createdAt: stamp(-1), updatedAt: stamp(-1), closedAt: null }, 'owner');
    for (let version = 2; version <= 40; version++)
      lead = f.store.updateLead({ ...lead, body: `body ${version}`, version, updatedAt: stamp(-1) }, 'owner');
    f.store.recordLeadCheck(lead.id, lead.version, { ok: true, message: 'checked', checkedAt: stamp(), planningCommit: HEAD, baseBranch: 'main' });
    lead = f.store.lead(lead.id);

    const detail = leads.getSummary({ id: lead.id });
    assert.equal(detail.versions.length, 40, 'every retained version is listed');
    assert.equal((detail.versions.at(-1) as { body?: string }).body, `body ${lead.version}`, 'the current version keeps its body');
    for (const version of detail.versions.slice(0, -1))
      assert.equal('body' in version, false, `version ${version.version} carries metadata only`);
    assert.equal(detail.versions.at(-1)!.approval, null);
    assert.equal(f.store.leadVersion(lead.id, lead.version).check?.ok, true, 'the check landed on the exact version');

    // The digest list the promotion path pins equals the parent computation over full versions.
    const parentDigests = f.store.leadVersions(lead.id).slice(0, -1).flatMap(version => version.digest ? [version.digest] : []);
    assert.deepEqual(f.store.leadVersionDigestsBeforeLatest(lead.id), parentDigests);
  } finally { f.close(); }
});

test('B7: open leads and the lead-to-lane index answer exactly what the full reads answered', () => {
  const f = fixture('lead-lanes');
  try {
    const repository = { origin: 'audit/repository', path: '/audit' };
    const addLead = (id: string, lanes: string[], state: 'open' | 'promoted') => f.store.addLead({ id, title: id, body: id, repositories: [repository],
      lanes, author: 'owner', state, version: 1, dropReason: null, targets: [], source: null, createdAt: stamp(-1), updatedAt: stamp(-1), closedAt: null }, 'owner');
    addLead('open-a', ['lane-a', 'lane-b'], 'open');
    addLead('open-b', ['lane-b'], 'open');
    addLead('promoted-c', ['lane-c'], 'promoted');

    assert.deepEqual(f.store.openLeads().map(lead => lead.id), ['open-a', 'open-b']);
    assert.deepEqual(f.store.openLeads(), f.store.leads().filter(lead => lead.state === 'open'), 'the narrowed read equals the parent filter');

    // The parent read: json_each over every retained lead on every activity rebuild.
    const parent = () => {
      const activity = new Map<string, { at: string | null; open: number }>();
      const note = (lane: string, at: string | null, open: number) => {
        const current = activity.get(lane) ?? { at: null, open: 0 };
        activity.set(lane, { at: at && (!current.at || at > current.at) ? at : current.at, open: current.open + open });
      };
      for (const row of f.store.db.prepare(`SELECT l.value AS lane, MAX(json_extract(r.data,'$.updatedAt')) AS at, SUM(r.state='open') AS open
          FROM leads r, json_each(r.data,'$.lanes') l GROUP BY l.value`).all() as { lane: string; at: string | null; open: number }[])
        note(String(row.lane), row.at == null ? null : String(row.at), Number(row.open ?? 0));
      return activity;
    };
    const indexActivity = () => new Map([...f.store.laneRecordActivity()].map(([key, value]) => [key, { at: value.at, open: value.open }]));
    assert.deepEqual(indexActivity(), parent(), 'the index answers the parent activity map');

    // A lane move rewrites the index in the same write, including the closed lead.
    f.store.updateLead({ ...f.store.lead('promoted-c'), lanes: ['lane-a'] });
    f.store.laneRecordActivity();
    assert.deepEqual(new Map([...f.store.laneRecordActivity()].map(([key, value]) => [key, { at: value.at, open: value.open }])), parent(),
      'the closed lead’s old lane leaves the index with the move');

    // A write that bypassed the funnel (a repair, an older build) moves the lead revision
    // without moving the index, so the next read rebuilds from the rows.
    f.store.db.prepare("UPDATE leads SET data=json_set(data,'$.lanes',json('[\"lane-z\"]')) WHERE id='open-a'").run();
    f.store.setMeta('leadRevision', f.store.leadRevision() + 1);
    f.store.close();
    const reopened = new Store(join(f.dir, 'queue.sqlite'));
    try {
      assert.equal(reopened.laneRecordActivity().get('lane-z')!.open, 1, 'an out-of-band lane edit is rebuilt, not served stale');
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('B10: the absence proof and the notice reads answer the parent queries', () => {
  const f = fixture('operations');
  try {
    const task = f.add('task');
    const hex = (index: number) => index.toString(16).padStart(64, '0');
    const names = new Map<string, string>();
    const shape = { kind: 'submit' as const, inputHash: hex(1), createdAt: stamp(-1) };
    let next = 16;
    const put = (name: string, submissionId: string, state: 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_attention') => {
      const id = hex(next++);
      names.set(id, name);
      f.store.putOperation({ ...shape, id, key: `key-${name}`, state, taskId: null, startedAt: null, settledAt: null,
        attempts: 0, diagnostic: '', result: null, effect: null, submissionId } as never);
    };
    put('mine-settled', 'submission-mine', 'succeeded');
    put('mine-failed', 'submission-mine', 'failed');
    put('mine-pending', 'submission-mine', 'pending');
    put('other-settled', 'submission-other', 'succeeded');
    put('other-running', 'submission-other', 'running');
    put('other-attention', 'submission-other', 'needs_attention');
    const ids = (rows: unknown[]) => rows.map(row => names.get((row as { id: string }).id) ?? (row as { id: string }).id).sort();
    const parent = f.store.db.prepare("SELECT data FROM operations WHERE state != 'failed' AND (json_extract(data,'$.submissionId')=? OR state IN ('pending','running','needs_attention')) ORDER BY rowid")
      .all('submission-mine').map(row => JSON.parse(String((row as { data: string }).data)));
    assert.deepEqual(ids(f.store.operationsForAbsenceProof('submission-mine')), ids(parent));
    assert.deepEqual(ids(parent), ['mine-pending', 'mine-settled', 'other-attention', 'other-running']);

    const notice = (id: string, status: string) => f.store.putNotice({ id, taskId: task.id, agentId: 'a', recipientAgentId: 'a', workspaceId: null,
      sources: [], originEntry: false, kind: 'completion', status: status as never, error: '', text: id } as never);
    notice('n-pending', 'pending'); notice('n-intent', 'intent'); notice('n-uncertain', 'uncertain'); notice('n-delivered', 'delivered');
    assert.deepEqual(f.store.pendingNotices().map(item => item.id), ['n-pending', 'n-intent']);
    assert.equal(f.store.unsettledNoticeCount(), 3);
    const plans = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notices WHERE json_extract(data,'$.status') IN ('pending','intent','uncertain')").all()
      .map(row => String((row as { detail: string }).detail)).join(' | ');
    assert.match(plans, /notices_status/, 'the notice status read is indexed, not a table scan');
    const absencePlan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM operations WHERE state != 'failed' AND (json_extract(data,'$.submissionId')=? OR state IN ('pending','running','needs_attention')) ORDER BY rowid").all('x')
      .map(row => String((row as { detail: string }).detail)).join(' | ');
    assert.match(absencePlan, /MULTI-INDEX OR/, 'the absence proof reads both branches through indexes instead of a scan');
    assert.match(absencePlan, /operations_submission/);
  } finally { f.close(); }
});

test('B7: a rollback keeps the projections it did not touch and never serves a rolled-back task', () => {
  const f = fixture('rollback');
  try {
    const task = f.add('rollback-task', { phase: 'working' });
    f.store.tasks();
    // Count the whole-table projection scans the store performs from here on.
    const db = f.store.db as unknown as { prepare: (sql: string) => unknown };
    const original = db.prepare.bind(f.store.db);
    let scans = 0;
    db.prepare = (sql: string) => { if (/SELECT id,data FROM tasks ORDER BY rowid DESC/.test(sql)) scans++; return original(sql); };

    // A refused write that touched no task or run row leaves the projection valid.
    assert.throws(() => f.store.transaction(() => {
      f.store.putNotice({ id: 'refused-notice', taskId: task.id, agentId: 'a', recipientAgentId: 'a', workspaceId: null, sources: [], originEntry: false,
        kind: 'completion', status: 'pending', error: '', text: 'never lands' } as never);
      throw new Error('refused');
    }), /refused/);
    assert.equal(f.store.tasks().find(item => item.id === task.id)!.title, 'rollback-task');
    assert.equal(scans, 0, 'an untouched projection is kept, not rebuilt (audit B7)');
    assert.equal(f.store.notices(task.id).length, 0, 'the rolled-back notice is gone');

    // A refused task write restores its projection entry without a whole-table rebuild.
    assert.throws(() => f.store.transaction(() => {
      f.store.update(task.id, { title: 'rolled back' });
      throw new Error('refused');
    }), /refused/);
    assert.equal(f.store.task(task.id).title, 'rollback-task', 'no stale data after the rollback');
    assert.equal(f.store.tasks().find(item => item.id === task.id)!.title, 'rollback-task', 'the restored list projection has no rolled-back value');
    assert.equal(scans, 0, 'row-scoped rollback restores the projection without scanning all tasks');
  } finally { f.close(); }
});

test('B7: telemetry hooks join live tasks, so an orphan occurrence is never parsed into a fact bundle', () => {
  const f = fixture('telemetry-join');
  try {
    const kept = f.add('kept');
    f.store.putHookEvent(hookRecord(kept.id));
    const orphanTask = f.add('orphan');
    f.store.putHookEvent(hookRecord(orphanTask.id, { eventId: '9'.repeat(48) }));
    f.store.db.prepare('DELETE FROM tasks WHERE id=?').run(orphanTask.id);
    const facts = f.store.telemetryFacts();
    assert.deepEqual([...facts.hooksByTask.keys()], [kept.id]);
    assert.equal(facts.hooksByTask.get(kept.id)!.length, 1);
    // The migrated row still counts for the live task.
    f.store.update(kept.id, { phase: 'done' });
    assert.ok(f.store.telemetryFacts().hooksByTask.has(kept.id));
  } finally { f.close(); }
});

test('B10: external-content search follows outcome rows without copying their text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-fts-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const store = new Store(path);
    const repository = { origin: 'audit/repository', path: '/audit' };
    const outcome = (taskId: string, brief: string) => store.putOutcome({
      taskId, submissionId: taskId, title: taskId, repository, outcome: 'done' as const, reason: 'Completed', pr: null,
      mergeCommit: null, syncedCommit: null, review: null, validation: null, closeout: { authority: 'queue' as const, commit: null },
      brief: { digest: `sha256:${'b'.repeat(64)}`, mediaType: 'text/markdown', text: brief }, workers: [], reviewers: [], siblings: [],
      startedAt: stamp(-2), finishedAt: stamp(-1), backfilled: false, lanes: [],
    } as never);
    outcome('alpha', 'alpha zebra');
    outcome('beta', 'beta zebra');
    const rowids = store.db.prepare('SELECT o.taskId AS taskId,o.rowid AS rid,f.rowid AS fts FROM outcomes o JOIN outcomes_fts f ON f.taskId=o.taskId ORDER BY o.taskId').all() as { taskId: string; rid: number; fts: number }[];
    assert.deepEqual(rowids.map(row => [row.rid, row.fts]), rowids.map(row => [row.rid, row.rid]), 'the index row carries the outcome rowid');
    assert.equal(store.searchOutcomes({ text: 'zebra' } as never).results.length, 2);

    // A rewrite deletes exactly one index row, so a rebuilt projection has no duplicates.
    store.rebuildOutcomeSearchIndex();
    assert.equal(store.searchOutcomes({ text: 'zebra' } as never).results.length, 2, 'a rebuild never duplicates an outcome');

    // The FTS index owns no content shadow table; snippets read the outcome-backed view.
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='outcomes_fts_content'").get(), undefined);
    store.db.prepare("UPDATE outcomes SET data=json_set(data,'$.brief.text',?) WHERE taskId=?").run('new quokka words', 'alpha');
    const changed = store.searchOutcomes({ text: 'quokka' } as never).results;
    assert.equal(changed.length, 1);
    assert.equal(changed[0].taskId, 'alpha');
    assert.match(changed[0].excerpt!.text, /\[quokka\]/i);
    assert.equal(store.searchOutcomes({ text: 'zebra' } as never).results.length, 1, 'the old index terms are removed');
    store.db.prepare("DELETE FROM outcomes WHERE taskId=?").run('beta');
    assert.equal(store.searchOutcomes({ text: 'zebra' } as never).results.length, 0, 'deletion removes index terms');
    store.close();

    const reopened = new Store(path);
    try {
      assert.equal(reopened.searchOutcomes({ text: 'quokka' } as never).results[0].taskId, 'alpha');
      assert.equal(reopened.searchOutcomes({ text: 'zebra' } as never).results.length, 0);
    } finally { reopened.close(); }

  } finally { rmSync(dir, { recursive: true, force: true }); }
});
