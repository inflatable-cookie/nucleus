import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { QueueRuntime } from '../service/runtime-owner';
import { Decisions } from '../core/planning/decisions';
import { briefDigest } from '../core/planning/brief';
import { scopeContains } from '../shared/project-scope';
import { projectCarriedText } from '../shared/project-removal';
import { outcomeSchema, projectGet, projectPark, projectRemove, projectRemovalBlockers, projectRemoveRepository, projectMerge, projectSchema, projectQaRunSchema, projectUnpark, projectUpsert, repositoryGet, repositorySet, submissionSchema, summarizeTask, taskNumberLabel, visibleTaskSummaries } from '../shared/contracts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-membership-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Store(join(dir, 'queue.sqlite'));
}
function submit(store: Store, repoPath: string, origin: string | null, id: string) {
  const input = submissionSchema.parse({ submissionId: id, title: id, repoPath, planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
  return store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, origin);
}
const alpha = { origin: 'acme/alpha', path: '/repos/alpha' };
const projectRepositoryHas = (project: { repositories: Array<{ origin: string | null; path: string }> }, repo: { origin: string; path: string }) =>
  project.repositories.some(member => member.origin === repo.origin || member.path === repo.path);
const beta = { origin: 'acme/beta', path: '/repos/beta' };

test('Spec 027 #11 park and unpark keep running and blocked tasks and project settings intact; repeat is idempotent and stale version fails', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    const running = store.update(submit(store, alpha.path, alpha.origin, 'running').id, { phase: 'working' });
    const blocked = store.update(submit(store, beta.path, beta.origin, 'blocked').id, { phase: 'blocked' });

    assert.ok(projectPark.input.safeParse({ key: 'suite', version: project.version }).success);
    assert.equal(projectPark.input.safeParse({ key: 'suite' }).success, false);
    const parked = store.setProjectVisibility({ key: 'suite', version: project.version }, 'parked');
    assert.equal(parked.visibility, 'parked');
    assert.equal(store.setProjectVisibility({ key: 'suite', version: parked.version }, 'parked').version, parked.version);
    assert.throws(() => store.setProjectVisibility({ key: 'suite', version: project.version }, 'active'), /Stale project version/);
    assert.deepEqual(store.task(running.id), running);
    assert.deepEqual(store.task(blocked.id), blocked);
    assert.equal(store.projectFor(alpha.path, alpha.origin)?.visibility, 'parked');
    assert.ok(projectUnpark.input.safeParse({ key: 'suite', version: parked.version }).success);
    const unparked = store.setProjectVisibility({ key: 'suite', version: parked.version }, 'active');
    assert.equal(unparked.visibility, 'active');
    assert.deepEqual(unparked.repositories, project.repositories);
    assert.deepEqual(store.task(running.id), running);
    assert.deepEqual(store.task(blocked.id), blocked);
  } finally { store.close(); }
});

test('Spec 027 #11 schema 50 retains project visibility and later edits', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] });
    const path = String(store.db.prepare('PRAGMA database_list').all()[0].file);
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    store.close();
    const migrated = new Store(path);
    try {
      assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA);
      assert.equal(migrated.projectByKey('suite')?.visibility, 'active');
      assert.equal(migrated.projectByKey('suite')?.version, 1);
      const parked = migrated.setProjectVisibility({ key: 'suite', version: 1 }, 'parked');
      const edited = migrated.upsertProject({ key: 'suite', name: 'Renamed', repositories: [alpha] });
      assert.equal(edited.visibility, 'parked');
      assert.equal(edited.version, parked.version + 1);
    } finally { migrated.close(); }
  } catch (error) { try { store.close(); } catch {} throw error; }
});

test('Spec 027 #1 schema 50 preserves projects, tasks, numbers and settings', t => {
  const store = fixture(t);
  try {
    const task = submit(store, alpha.path, alpha.origin, 'first');
    store.putRepository(alpha, 'agent', 'keep', null);
    store.putRepository({ origin: null, path: beta.path }, 'queue', 'path-only', null);
    submit(store, beta.path, beta.origin, 'second');
    const taskRecord = store.task(task.id);
    const settingsJson = store.db.prepare('SELECT data FROM repository_settings WHERE key=?').get(alpha.origin)!.data;
    const number = store.numberFor(task.id);
    store.upsertProject({ key: 'alpha', name: 'Alpha', repositories: [alpha] });
    store.upsertProject({ key: 'beta', name: 'Beta', repositories: [beta] });
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    const path = String(store.db.prepare('PRAGMA database_list').all()[0].file);
    store.close();
    const migrated = new Store(path);
    try {
      assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA);
      assert.equal(migrated.projects().length, 2);
      assert.deepEqual(migrated.projectFor(alpha.path, alpha.origin)?.repositories, [alpha]);
      assert.deepEqual(migrated.projectFor(beta.path, beta.origin)?.repositories, [beta]);
      assert.deepEqual(migrated.projectFor(alpha.path, alpha.origin)?.primary, alpha);
      assert.deepEqual(migrated.projectFor(beta.path, beta.origin)?.primary, beta);
      assert.deepEqual(migrated.task(task.id), taskRecord);
      assert.equal(migrated.db.prepare('SELECT data FROM repository_settings WHERE key=?').get(alpha.origin)!.data, settingsJson);
      assert.deepEqual(migrated.numberFor(task.id), number);
    } finally { migrated.close(); }
  } catch (error) { try { store.close(); } catch {} throw error; }
});

test('g01.070 schema 50 preserves primary, membership and plan identity', t => {
  const store = fixture(t);
  try {
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [beta, alpha], primary: beta });
    const path = String(store.db.prepare('PRAGMA database_list').all()[0].file);
    store.db.exec('CREATE TABLE papercuts(id TEXT PRIMARY KEY,repository TEXT NOT NULL,state TEXT NOT NULL,content_key TEXT UNIQUE,data TEXT NOT NULL)');
    store.setMeta('schema', 50);
    store.close();
    const migrated = new Store(path);
    try {
      assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA);
      assert.deepEqual(migrated.projectByKey('suite')?.primary, beta);
      assert.deepEqual(migrated.projectByKey('suite')?.repositories, [beta, alpha]);
      assert.equal(migrated.planProject({ repository: alpha.origin }).key, 'suite');
    } finally { migrated.close(); }
  } catch (error) { try { store.close(); } catch {} throw error; }
});

test('g01.070 upsert requires a member primary for several repositories and defaults a single member', t => {
  const store = fixture(t);
  try {
    assert.equal(projectUpsert.input.safeParse({ key: 'suite', name: 'Suite', repositories: [alpha, beta] }).success, false);
    assert.throws(() => store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta] }), /Primary repository is required/);
    assert.throws(() => store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: { origin: 'acme/outside', path: '/repos/outside' } }), /Primary repository must belong/);
    assert.deepEqual(store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] }).primary, alpha);
    const named = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: beta });
    assert.deepEqual(named.repositories, [beta, alpha]);
    assert.deepEqual(store.projectByKey('suite')?.primary, beta);
    assert.deepEqual(store.projects().find(project => project.key === 'suite')?.repositories, [beta, alpha]);
    assert.throws(() => store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] }), /Primary repository is required|Name another primary/);
    assert.equal(store.projectByKey('suite')?.primary.origin, beta.origin);
    const changed = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha], primary: alpha });
    assert.deepEqual(changed.primary, alpha);
    assert.deepEqual(store.projectFor(beta.path, beta.origin)?.primary, beta);
  } finally { store.close(); }
});

test('Spec 027 #2 a two-repository project owns each member once and removed members return to defaults', t => {
  const store = fixture(t);
  try {
    store.ensureProject(alpha.path, alpha.origin); store.ensureProject(beta.path, beta.origin);
    const named = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    assert.equal(named.repositories.length, 2);
    assert.equal(store.projectFor(alpha.path, alpha.origin)?.key, 'suite');
    assert.throws(() => store.upsertProject({ key: 'other', name: 'Other', repositories: [beta] }), /already belongs/);
    assert.equal(store.projectFor(beta.path, beta.origin)?.key, 'suite');
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha] });
    assert.equal(store.projectFor(beta.path, beta.origin)?.name, 'beta');
  } finally { store.close(); }
});

test('Spec 027 #3 submissions belong to their project and keep repository numbering', t => {
  const store = fixture(t);
  try {
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [{ ...alpha, path: '' }, { ...beta, path: '' }], primary: alpha });
    const one = submit(store, alpha.path, alpha.origin, 'alpha-1');
    const two = submit(store, beta.path, beta.origin, 'beta-1');
    const three = submit(store, alpha.path, alpha.origin, 'alpha-2');
    assert.equal(store.projectFor(one.repoPath, one.repository)?.key, 'suite');
    assert.equal(store.projectFor(two.repoPath, two.repository)?.key, 'suite');
    assert.deepEqual(store.projectByKey('suite')?.primary, alpha);
    assert.deepEqual(store.projectByKey('suite')?.repositories, [alpha, beta]);
    assert.deepEqual([one.number, two.number, three.number], [1, 1, 2]);
    assert.equal(one.repoPath, alpha.path);
  } finally { store.close(); }
});

test('Spec 027 #4 project queries and board scope include both repositories with qualified numbers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: beta });
    assert.equal(runtime.listProjects().length, 1);
    assert.deepEqual(runtime.listProjects()[0].repositories, [beta, alpha]);
    const snapshot = runtime.uiSnapshot({});
    assert.ok('projects' in snapshot);
    assert.deepEqual(snapshot.projects[0].primary, beta);
    assert.equal((await runtime.getProject({ key: 'suite' }))?.name, 'Suite');
    assert.equal((await runtime.getProject({ repository: alpha }))?.key, 'suite');
    const one = submit(runtime.store, alpha.path, alpha.origin, 'alpha');
    const two = submit(runtime.store, beta.path, beta.origin, 'beta');
    assert.equal(taskNumberLabel(summarizeTask(one), true), 'alpha#001');
    assert.equal(taskNumberLabel(summarizeTask(two), true), 'beta#001');
    assert.equal(visibleTaskSummaries([one], runtime.store.projects())[0].repository, undefined, 'matching path hints stay compact');
    assert.equal(visibleTaskSummaries([one], [{ key: 'suite', name: 'Suite', version: 1, visibility: 'active', repositories: [{ ...alpha, path: '/other' }], primary: { ...alpha, path: '/other' }, drain: null }])[0].repository, alpha.origin);
    assert.ok(visibleTaskSummaries([one, { ...two, repoPath: alpha.path }], runtime.store.projects()).every(task => task.repository));
    // Scoped work counts both repositories, and a contradicting origin is out of scope (#866
    // retired the Lanes table; the scope predicate is what these facts belong to).
    const contains = scopeContains(runtime.listProjects(), ['suite']);
    const tasks = [one, two, { ...two, id: 'outside', repoPath: alpha.path, repository: 'other/repo', lanes: [] }];
    assert.equal(tasks.filter(task => contains(task.repoPath, task.repository)).length, 2, 'both repositories are in scope and a contradicting origin is not');
    assert.ok('projects' in runtime.uiSnapshot({}));
  } finally { await runtime.stop(); }
});

test('Spec 027 #5 old project.get call refuses and repository settings round-trip', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    const old = { repository: alpha.origin, closeout: 'agent', note: 'keep' };
    assert.ok(projectGet.input.safeParse({ repository: alpha.origin }).success);
    await assert.rejects(runtime.getProject({ repository: alpha.origin }), /repository.get/);
    assert.ok(repositorySet.input.safeParse(old).success);
    const saved = await runtime.setRepository(repositorySet.input.parse(old));
    assert.equal(saved.closeout, 'agent');
    assert.ok(repositoryGet.input.safeParse({ repository: alpha.origin }).success);
    assert.equal((await runtime.getRepository({ repository: alpha.origin }))?.note, 'keep');
  } finally { await runtime.stop(); }
});

const stamp = '2026-09-30T00:00:00.000Z';

test('Spec 027 removal: an unused project is deleted, tombstoned and its settings row cleared', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'stale', name: 'Stale', repositories: [alpha, beta], primary: alpha });
    store.putRepository(alpha, 'agent', 'stale settings', null);
    assert.throws(() => store.removeProject({ key: 'stale', version: project.version + 1, reason: 'cleanup' }), /Stale project version/);
    const tombstone = store.removeProject({ key: 'stale', version: project.version, reason: 'Repository moved to the acme org' });
    assert.equal(store.projectByKey('stale'), null);
    assert.equal(store.projectFor(alpha.path, alpha.origin), null);
    assert.equal(store.repositoryByKey(alpha.origin), null);
    assert.deepEqual(tombstone.repositories, [alpha, beta]);
    assert.equal(tombstone.reason, 'Repository moved to the acme org');
    assert.ok(Number.isFinite(Date.parse(tombstone.removedAt)));
    assert.deepEqual(store.projectTombstones().map(item => item.key), ['stale']);
    assert.throws(() => store.removeProject({ key: 'stale', version: 1, reason: 'again' }), /Unknown project stale/);
    // An explicit re-create clears the tombstone so the project exports again.
    const recreated = store.upsertProject({ key: 'stale', name: 'Stale again', repositories: [alpha] });
    assert.equal(store.projectTombstones().find(item => item.key === 'stale') ?? null, null);
    assert.deepEqual(store.projectTombstones(), []);
    assert.equal(recreated.name, 'Stale again');
    assert.equal(projectRemove.input.safeParse({ key: 'stale', version: 1, reason: 'again' }).success, true);
    assert.equal(projectRemove.input.safeParse({ key: 'stale', version: 1, reason: '' }).success, false);
  } finally { store.close(); }
});

test('Spec 027 removal: each blocker type is refused and named; done work does not block', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha, beta], primary: alpha });
    store.update(submit(store, alpha.path, alpha.origin, 'settled').id, { phase: 'done' });
    store.update(submit(store, beta.path, beta.origin, 'running').id, { phase: 'working' });
    store.addLead({ id: 'open-lead', title: 'Open lead', body: '', repositories: [alpha], state: 'open', author: 'operator', version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: null }, 'operator');
    store.addPapercut({ id: 'open-cut', repository: alpha, area: null, title: 'Open papercut', happened: 'h', impact: '', fix: null, filedBy: 'operator', filedAt: stamp,
      state: 'open', taskId: null, closedReason: null, draftId: null, note: null, closedAt: null, source: null, lanes: [] });
    store.upsertLane({ key: 'active-lane', title: 'Active lane', aim: 'aim', repositories: [alpha] });
    new Decisions(store).add({ question: 'Delete or keep?', askedBy: 'agent', project: alpha });
    store.acceptOperation({ key: 'submit:pending', kind: 'submit', inputHash: 'a'.repeat(64),
      payload: { type: 'submit', submission: submissionSchema.parse({ submissionId: 'pending', title: 'Pending submission', repoPath: beta.path, planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' }) },
      submissionId: 'pending', repoPath: beta.path });
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }), (error: Error) => {
      for (const pattern of [/1 task \(beta#001\)/, /1 open lead \(Open lead\)/, /1 open papercut \(Open papercut\)/,
        /1 active lane \(Active lane\)/, /1 pending submission \(Pending submission\)/, /1 open decision \(Delete or keep\?\)/])
        assert.match(error.message, pattern);
      return true;
    });
    assert.ok(store.projectByKey('inuse'), 'a refused removal keeps the project');
    assert.equal(store.projectTombstones().find(item => item.key === 'inuse') ?? null, null);
  } finally { store.close(); }
});

test('Spec 027 removal: outcomes, closed leads and events keep resolving their repository', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'stale', name: 'Stale', repositories: [alpha], primary: alpha });
    store.putOutcome(outcomeSchema.parse({
      taskId: 'history-task', submissionId: 'submission-history', title: 'History', repository: alpha, outcome: 'done', reason: 'Merged',
      pr: null, mergeCommit: null, syncedCommit: null, review: null, validation: null, closeout: { authority: 'queue', commit: null },
      brief: { digest: briefDigest('Brief'), mediaType: 'text/markdown', text: 'Brief', source: 'handoff', version: null, earlierDigests: [] },
      workers: [], reviewers: [], startedAt: stamp, finishedAt: stamp, backfilled: false,
    }));
    store.addLead({ id: 'closed-lead', title: 'Closed lead', body: '', repositories: [alpha], state: 'closed', author: 'operator',
      closure: { reason: 'completed', note: null, at: stamp }, version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: stamp }, 'operator');
    store.event('history-task', 'closed_out', 'merged');
    store.removeProject({ key: 'stale', version: project.version, reason: 'duplicate' });
    assert.equal(store.outcome('history-task')?.repository.origin, alpha.origin);
    assert.equal(store.searchOutcomes({ repository: alpha.origin }).results[0]?.taskId, 'history-task');
    assert.equal(store.lead('closed-lead').state, 'closed');
    assert.ok(store.eventsAll('history-task').some(row => row.kind === 'closed_out'));
  } finally { store.close(); }
});

test('Spec 027 removal: a repository settings row another project still uses is kept', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'stale', name: 'Stale', repositories: [alpha], primary: alpha });
    store.putRepository(alpha, 'agent', 'shared settings', null);
    store.db.prepare('INSERT INTO projects(key,data) VALUES(?,?)').run('other',
      JSON.stringify(projectSchema.parse({ key: 'other', name: 'Other', repositories: [alpha], primary: alpha, version: 1, visibility: 'active' })));
    store.removeProject({ key: 'stale', version: project.version, reason: 'duplicate' });
    assert.equal(store.projectByKey('stale'), null);
    assert.equal(store.repositoryByKey(alpha.origin)?.note, 'shared settings');
  } finally { store.close(); }
});

test('Spec 027 removal: an open decision linked only through terminal history still blocks', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    const task = submit(store, alpha.path, alpha.origin, 'settled');
    store.update(task.id, { phase: 'done' });
    store.addLead({ id: 'closed-lead', title: 'Closed lead', body: '', repositories: [alpha], state: 'closed', author: 'operator',
      closure: { reason: 'completed', note: null, at: stamp }, version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: stamp }, 'operator');
    store.addPapercut({ id: 'closed-cut', repository: alpha, area: null, title: 'Closed papercut', happened: 'h', impact: '', fix: null, filedBy: 'operator', filedAt: stamp,
      state: 'closed', taskId: null, closedReason: 'completed', draftId: null, note: null, closedAt: stamp, source: null, lanes: [] });
    new Decisions(store).add({ question: 'Was this handled?', askedBy: 'agent', tasks: [task.id], leads: ['closed-lead'], papercuts: ['closed-cut'] });
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }),
      /1 open decision \(Was this handled\?\)/);
    assert.ok(store.projectByKey('inuse'));
  } finally { store.close(); }
});

test('Spec 027 removal: a removed non-terminal task still blocks', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    const task = store.update(submit(store, alpha.path, alpha.origin, 'removed').id, { phase: 'working' });
    store.update(task.id, { removedAt: stamp });
    assert.equal(store.tasks().some(item => item.id === task.id), false, 'the task leaves the live view');
    assert.equal(store.allTasks().some(item => item.id === task.id), true);
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }), /1 task \(/);
    assert.ok(store.projectByKey('inuse'));
  } finally { store.close(); }
});

test('Spec 027 removal: an open decision linked only to a purged task outcome still blocks', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    const task = submit(store, alpha.path, alpha.origin, 'gone');
    store.update(task.id, { phase: 'done' });
    store.putOutcome(outcomeSchema.parse({
      taskId: task.id, submissionId: task.submissionId, title: task.title, repository: alpha, outcome: 'done', reason: 'Merged',
      pr: null, mergeCommit: null, syncedCommit: null, review: null, validation: null, closeout: { authority: 'queue', commit: null },
      brief: { digest: briefDigest('Brief'), mediaType: 'text/markdown', text: 'Brief', source: 'handoff', version: null, earlierDigests: [] },
      workers: [], reviewers: [], startedAt: stamp, finishedAt: stamp, backfilled: false,
    }));
    // Task 1183: the decision is recorded while its task still exists, then the task is purged.
    new Decisions(store).add({ question: 'Purged link?', askedBy: 'agent', tasks: [task.id] });
    store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    assert.equal(store.allTasks().some(item => item.id === task.id), false, 'the task is purged, only its outcome remains');
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }),
      /1 open decision \(Purged link\?\)/);
  } finally { store.close(); }
});

test('Spec 027 removal: a matching pending submission beyond the old 200-row read cap still blocks', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    store.setMeta('operationLimit', 256);
    const pending = (id: string, repoPath: string) => submissionSchema.parse({ submissionId: id, title: id, repoPath, planningCommit: 'a'.repeat(40), handoffPath: 'h.md', originAgentId: 'origin' });
    for (let i = 0; i < 200; i++)
      store.acceptOperation({ key: `submit:other-${i}`, kind: 'submit', inputHash: 'a'.repeat(64),
        payload: { type: 'submit', submission: pending(`other-${i}`, '/other/repo') }, submissionId: `other-${i}`, repoPath: '/other/repo' });
    store.acceptOperation({ key: 'submit:mine', kind: 'submit', inputHash: 'a'.repeat(64),
      payload: { type: 'submit', submission: pending('mine', alpha.path) }, submissionId: 'mine', repoPath: alpha.path });
    assert.equal(store.pendingSubmissions().length, 201, 'every pending submission is read, not just the first 200');
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }),
      /1 pending submission \(mine\)/);
  } finally { store.close(); }
});

test('Spec 027 removal: project.removal-blockers reads the full scan for the board', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-blockers-rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha] });
    const task = runtime.store.update(submit(runtime.store, alpha.path, alpha.origin, 'removed').id, { phase: 'working' });
    runtime.store.update(task.id, { removedAt: stamp });
    assert.throws(() => runtime.removalBlockers({ key: 'missing' }), /Unknown project missing/);
    const blockers = projectRemovalBlockers.output.parse(runtime.removalBlockers({ key: 'inuse' }));
    assert.deepEqual(blockers.map(blocker => blocker.kind), ['task'], 'a removed non-terminal task shows on the board read');
    assert.equal(blockers[0].names.length, 1);
    assert.equal(runtime.removalBlockers({ key: 'inuse' }).length, 1, 'the read does not mutate');
  } finally { await runtime.stop(); }
});

test('nucleus#967 remove a repository: Separate project keeps today\'s split; Remove from Nucleus leaves no project for it', t => {
  const store = fixture(t);
  const gamma = { origin: 'acme/gamma', path: '/repos/gamma' };
  try {
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta, gamma], primary: alpha });
    store.update(submit(store, gamma.path, gamma.origin, 'history').id, { phase: 'done' });
    // Separate project: today's membership write splits gamma into its own project.
    const split = store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    assert.deepEqual(store.projectFor(gamma.path, gamma.origin)?.repositories, [gamma], 'Separate project leaves a one-repository project');
    store.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta, gamma], primary: alpha });
    const suite = store.projectByKey('suite')!;
    assert.ok(suite.version > split.version);
    assert.deepEqual(store.removalBlockers('suite', 'acme/gamma'), [], 'a done task does not block');
    assert.throws(() => store.removeProjectRepository({ key: 'suite', version: suite.version - 1, repository: 'acme/gamma', reason: 'renamed' }), /Stale project version/);
    assert.throws(() => store.removeProjectRepository({ key: 'suite', version: suite.version, repository: 'acme/alpha', reason: 'renamed' }), /Name another primary repository/);
    assert.throws(() => store.removeProjectRepository({ key: 'suite', version: suite.version, repository: 'acme/missing', reason: 'renamed' }), /not in project suite/);
    const { project, tombstone } = store.removeProjectRepository({ key: 'suite', version: suite.version, repository: 'acme/gamma', reason: 'renamed to suite-v2' });
    assert.deepEqual(project.repositories, [alpha, beta]);
    assert.equal(project.version, suite.version + 1);
    assert.equal(store.projectFor(gamma.path, gamma.origin), null, 'no project for the removed repository');
    assert.deepEqual(tombstone.repositories, [gamma]);
    assert.equal(tombstone.reason, 'renamed to suite-v2');
    assert.ok(store.projectTombstones().find(item => item.key === tombstone.key), 'its one-repository project is tombstoned like any removed project');
    assert.equal(store.allTasks().filter(task => task.repoPath === gamma.path).length, 1, 'history stays readable');
    assert.equal(projectRemoveRepository.input.safeParse({ key: 'suite', version: 1, repository: 'acme/gamma', reason: '' }).success, false);
  } finally { store.close(); }
});

test('nucleus#967 remove a repository: a blocked repository is refused whole and named; other members do not block it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-remove-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.upsertProject({ key: 'suite', name: 'Suite', repositories: [alpha, beta], primary: alpha });
    runtime.store.update(submit(runtime.store, alpha.path, alpha.origin, 'primary-work').id, { phase: 'working' });
    assert.deepEqual(projectRemovalBlockers.output.parse(runtime.removalBlockers({ key: 'suite', repository: 'acme/beta' })), [], 'the primary\'s task does not block beta');
    runtime.store.update(submit(runtime.store, beta.path, beta.origin, 'open').id, { phase: 'working' });
    const blockers = projectRemovalBlockers.output.parse(runtime.removalBlockers({ key: 'suite', repository: 'acme/beta' }));
    assert.deepEqual(blockers.map(blocker => [blocker.kind, blocker.names]), [['task', ['beta#001']]]);
    assert.ok(projectRemovalBlockers.input.safeParse({ key: 'suite', repository: 'acme/beta' }).success);
    const suite = runtime.store.projectByKey('suite')!;
    assert.throws(() => runtime.removeProjectRepository({ key: 'suite', version: suite.version, repository: 'acme/beta', reason: 'gone' }),
      /Repository acme\/beta cannot be removed: 1 task \(beta#001\)/);
    assert.deepEqual(runtime.store.projectByKey('suite'), suite, 'nothing changed: still a member, same version');
    assert.equal(runtime.store.projectFor(beta.path, beta.origin)?.key, 'suite', 'not split off either');
    assert.deepEqual(runtime.store.projectTombstones(), []);
  } finally { await runtime.stop(); }
});

test('nucleus#969 merge: every repository moves into the target in one step, the target keeps its primary, the source goes', t => {
  const store = fixture(t);
  const gamma = { origin: 'acme/gamma', path: '/repos/gamma' }, delta = { origin: 'acme/delta', path: '/repos/delta' };
  try {
    const target = store.upsertProject({ key: 'site', name: 'Site', repositories: [alpha] });
    const source = store.upsertProject({ key: 'book', name: 'Book', repositories: [beta, gamma, delta], primary: gamma });
    store.patchRepository(beta, { note: 'book policy' });
    store.setProjectDispatchLimitOverride('book', 3);
    store.setProjectDispatchLimitOverride('site', 5);
    const done = store.update(submit(store, beta.path, beta.origin, 'history').id, { phase: 'done' });
    assert.throws(() => store.mergeProject({ source: 'book', target: 'book', versions: { source: source.version, target: source.version }, reason: 'x' }), /different project/);
    assert.throws(() => store.mergeProject({ source: 'book', target: 'site', versions: { source: source.version - 1 || 9, target: target.version }, reason: 'x' }), /Stale project version for book/);
    assert.throws(() => store.mergeProject({ source: 'book', target: 'site', versions: { source: source.version, target: target.version + 1 }, reason: 'x' }), /Stale project version for site/);
    const result = store.mergeProject({ source: 'book', target: 'site', versions: { source: source.version, target: target.version }, reason: 'Book belongs under Site' });
    assert.equal(result.project.key, 'site');
    assert.equal(result.project.name, 'Site');
    assert.deepEqual(result.project.primary, alpha, 'the target\'s primary stays primary');
    assert.deepEqual(result.project.repositories, [alpha, gamma, beta, delta], 'the source\'s members follow in its order');
    assert.equal(result.project.version, target.version + 1);
    assert.equal(result.source, null);
    assert.equal(result.tombstone?.key, 'book');
    assert.equal(store.projectByKey('book'), null);
    for (const repo of [alpha, beta, gamma, delta]) assert.equal(store.projects().filter(project => projectRepositoryHas(project, repo)).length, 1, `${repo.origin} is in exactly one project`);
    assert.equal(store.repositorySettingsFor(beta)?.note, 'book policy', 'repository settings follow the repository');
    assert.deepEqual(store.projectDispatchLimitOverrides(), { site: 5 }, 'the source\'s slot override is dropped, the target\'s stays');
    assert.equal(store.projectFor(beta.path, beta.origin)?.key, 'site');
    assert.deepEqual(store.task(done.id), done, 'tasks follow their repositories unchanged');
    assert.ok(projectMerge.input.safeParse({ source: 'a', target: 'b', versions: { source: 1, target: 1 }, reason: 'r' }).success);
    assert.equal(projectMerge.input.safeParse({ source: 'a', target: 'b', versions: { source: 1, target: 1 }, reason: ' ' }).success, false);
  } finally { store.close(); }
});

test('nucleus#984 merge: open leads, papercuts, a queued task, a lane and the plan come along under the target; remove still refuses on them', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.upsertProject({ key: 'project-k', name: 'project-k', repositories: [alpha] });
    await runtime.upsertProject({ key: 'project-i', name: 'project-i', repositories: [beta] });
    const store = runtime.store;
    const task = submit(store, beta.path, beta.origin, 'queued-task');
    const lead = store.addLead({ id: 'lab-lead', title: 'Button density at md with a bare label', body: '', repositories: [beta], state: 'open', author: 'operator', version: 1, dropReason: null, targets: [], source: null, createdAt: stamp, updatedAt: stamp, closedAt: null }, 'operator');
    store.addPapercut({ id: 'lab-cut', repository: beta, area: null, title: 'No Effigy format selector for TypeScript', happened: 'h', impact: '', fix: null, filedBy: 'operator', filedAt: stamp,
      state: 'open', taskId: null, closedReason: null, draftId: null, note: null, closedAt: null, source: null, lanes: [] });
    store.upsertLane({ key: 'lab-lane', title: 'Lab', aim: 'aim', repositories: [beta] });
    store.upsertLane({ key: 'project-k-lane', title: 'Project-K', aim: 'aim', repositories: [alpha] });
    store.setPlan({ project: 'project-i', version: 0, entries: [{ lane: 'lab-lane', horizon: 'next' }], author: 'lab planner' });
    store.setPlan({ project: 'project-k', version: 0, entries: [{ lane: 'project-k-lane', horizon: 'later' }], author: 'project-k planner', idle: 'Waiting on Tom' });
    assert.throws(() => store.removeProject({ key: 'project-i', version: store.projectByKey('project-i')!.version, reason: 'x' }), /1 open lead \(Button density at md with a bare label\)/,
      'remove keeps its blockers');
    const check = runtime.mergeCheck({ source: 'project-i' });
    assert.deepEqual(check.blockers, [], 'open work is not a move blocker');
    assert.equal(projectCarriedText(check.carried), '1 task, 1 lead, 1 papercut, 1 lane');
    const lab = store.projectByKey('project-i')!, projectK = store.projectByKey('project-k')!;
    const result = runtime.mergeProject({ source: 'project-i', target: 'project-k', versions: { source: lab.version, target: projectK.version }, reason: 'Moved into project-k in Settings' });
    assert.equal(result.tombstone?.key, 'project-i');
    assert.equal(store.projectByKey('project-i'), null);
    assert.deepEqual(store.task(task.id), task, 'the task keeps its identity');
    assert.deepEqual(store.lead(lead.id), lead, 'the lead keeps its identity and stays open');
    assert.equal(store.lead('lab-cut')?.state, 'open', 'the papercut stays open');
    const target = store.projectByKey('project-k')!;
    assert.deepEqual(store.removalBlockers('project-k').map(blocker => [blocker.kind, blocker.names]),
      [['task', [task.reference ?? task.id]], ['lead', ['Button density at md with a bare label']], ['papercut', ['No Effigy format selector for TypeScript']], ['lane', ['Lab', 'Project-K']]],
      'everything now shows under the target');
    assert.equal(store.projectFor(beta.path, beta.origin)?.key, target.key);
    const plan = store.plan({ project: 'project-k' });
    assert.deepEqual(plan.entries.map(entry => [entry.lane, entry.horizon]), [['project-k-lane', 'later'], ['lab-lane', 'next']], 'the source\'s plan order joins the end of the target\'s');
    assert.equal(plan.idle, undefined, 'a joining next lane clears the target\'s idle mark');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM project_plans WHERE project=?').get('project-i')!.n, 0, 'no plan is left under the removed key');
  } finally { await runtime.stop(); }
});

test('nucleus#984 merge: a queued or running project QA or an in-flight re-key on a moving repository refuses the move; nothing changes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-project-merge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  const gamma = { origin: 'acme/gamma', path: '/repos/gamma' };
  try {
    await runtime.upsertProject({ key: 'site', name: 'Site', repositories: [alpha] });
    await runtime.upsertProject({ key: 'book', name: 'Book', repositories: [beta, gamma], primary: beta });
    runtime.store.putQaRun(projectQaRunSchema.parse({ id: 'book-qa', repository: gamma, key: gamma.origin, state: 'running', baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'], digest: 'b'.repeat(64),
      exitCode: null, durationMs: 0, outputTail: '', startedAt: stamp, finishedAt: null, pid: null, admission: null, capacityWait: null, capacityUnavailable: false }));
    const site = runtime.store.projectByKey('site')!, book = runtime.store.projectByKey('book')!;
    const versions = { source: book.version, target: site.version };
    assert.deepEqual(runtime.mergeCheck({ source: 'book' }).blockers, [{ kind: 'qa', label: 'project QA run', names: ['acme/gamma running'] }]);
    assert.deepEqual(runtime.mergeCheck({ source: 'book', repository: 'acme/beta' }).blockers, [], 'a member without the QA is free to move');
    assert.throws(() => runtime.mergeProject({ source: 'book', target: 'site', versions, reason: 'move' }), /Book cannot move into Site: 1 project QA run \(acme\/gamma running\)/);
    assert.throws(() => runtime.mergeProject({ source: 'book', target: 'site', versions, repository: 'acme/gamma', reason: 'move' }), /Book cannot move into Site: 1 project QA run/,
      'moving the QA\'s own member is refused too');
    assert.deepEqual(runtime.store.projectByKey('site'), site);
    assert.deepEqual(runtime.store.projectByKey('book'), book);
    assert.deepEqual(runtime.store.projectTombstones(), []);
    runtime.store.putQaRun({ ...runtime.store.qaRun('book-qa')!, state: 'passed', finishedAt: stamp });
    runtime.store.acceptOperation({ key: 'repository-rekey:x', kind: 'repository_rekey', inputHash: 'c'.repeat(64),
      payload: { type: 'repository_rekey', input: { source: 'acme/beta', target: { origin: 'acme/beta2' }, reason: 'renamed', relayedBy: null } } as never });
    assert.deepEqual(runtime.mergeCheck({ source: 'book' }).blockers, [{ kind: 'operation', label: 'repository re-key', names: ['acme/beta'] }]);
    assert.throws(() => runtime.mergeProject({ source: 'book', target: 'site', versions, reason: 'move' }), /1 repository re-key \(acme\/beta\)/);
  } finally { await runtime.stop(); }
});

test('nucleus#984 carried text counts each kind, singular and plural, and is empty when nothing comes', () => {
  assert.equal(projectCarriedText([]), '');
  assert.equal(projectCarriedText([{ kind: 'lead', label: 'open lead', names: ['a', 'b'] }, { kind: 'papercut', label: 'open papercut', names: ['c'] }, { kind: 'decision', label: 'open decision', names: [] }]), '2 leads, 1 papercut');
});

test('nucleus#969 adding a repository that has a project moves it: a sole member\'s project goes, a shared member leaves its project', t => {
  const store = fixture(t);
  const gamma = { origin: 'acme/gamma', path: '/repos/gamma' }, delta = { origin: 'acme/delta', path: '/repos/delta' };
  try {
    store.upsertProject({ key: 'site', name: 'Site', repositories: [alpha] });
    store.upsertProject({ key: 'book', name: 'Book', repositories: [beta] });
    store.upsertProject({ key: 'tools', name: 'Tools', repositories: [gamma, delta], primary: gamma });
    assert.throws(() => store.upsertProject({ key: 'site', name: 'Site', repositories: [alpha, beta], primary: alpha }), /already belongs to project book/,
      'a plain membership write never puts a repository in two projects');
    const v = (key: string) => store.projectByKey(key)!.version;
    const sole = store.mergeProject({ source: 'book', target: 'site', versions: { source: v('book'), target: v('site') }, repository: 'acme/beta', reason: 'Added to Site' });
    assert.deepEqual(sole.project.repositories, [alpha, beta]);
    assert.equal(store.projectByKey('book'), null, 'the sole member\'s old project is removed');
    assert.equal(sole.tombstone?.key, 'book');
    assert.throws(() => store.mergeProject({ source: 'tools', target: 'site', versions: { source: v('tools'), target: v('site') }, repository: 'acme/gamma', reason: 'x' }),
      /Name another primary repository in Tools/);
    const shared = store.mergeProject({ source: 'tools', target: 'site', versions: { source: v('tools'), target: v('site') }, repository: 'acme/delta', reason: 'Added to Site' });
    assert.deepEqual(shared.project.repositories, [alpha, beta, delta]);
    assert.deepEqual(shared.source?.repositories, [gamma], 'the rest of its project stays');
    assert.equal(shared.tombstone, null);
    assert.equal(store.projects().filter(project => projectRepositoryHas(project, delta)).length, 1, 'no implicit project is left behind');
    const implicit = store.ensureProject('/repos/epsilon', 'acme/epsilon');
    const absorbed = store.mergeProject({ source: implicit.key, target: 'site', versions: { source: implicit.version, target: v('site') }, reason: 'x' });
    assert.equal(absorbed.tombstone, null, 'an implicit project is absorbed as project.upsert always has');
    assert.equal(store.projectByKey(implicit.key), null);
  } finally { store.close(); }
});

test('Spec 027 removal: an origin-backed project still matches a task whose identity is its checkout path', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    const task = submit(store, alpha.path, null, 'originless');
    assert.equal(task.repository, alpha.path, 'an origin-less checkout stores its path as the identity');
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }), /1 task \(/);
    assert.ok(store.projectByKey('inuse'));
  } finally { store.close(); }
});

test('Spec 027 removal: an open decision linked only to a purged task without an outcome still blocks', t => {
  const store = fixture(t);
  try {
    const project = store.upsertProject({ key: 'inuse', name: 'In use', repositories: [alpha], primary: alpha });
    const task = submit(store, alpha.path, alpha.origin, 'purged');
    // Task 1183: the decision is recorded while its task still exists, then the task is purged.
    new Decisions(store).add({ question: 'Purged without outcome?', askedBy: 'agent', tasks: [task.id] });
    store.db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    assert.equal(store.allTasks().some(item => item.id === task.id), false, 'the task row is gone');
    assert.equal(store.outcome(task.id), null, 'no outcome survives');
    assert.throws(() => store.removeProject({ key: 'inuse', version: project.version, reason: 'cleanup' }),
      /1 open decision \(Purged without outcome\?\)/);
    assert.ok(store.projectByKey('inuse'));
  } finally { store.close(); }
});

test('project management: moving a live project preserves all work and both plans, tombstones the source, and is replay safe', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Same label',repositories:[alpha]});
    const destination=store.upsertProject({key:'destination',name:'Same label',repositories:[beta]});
    const task=store.update(submit(store,alpha.path,alpha.origin,'live').id,{phase:'working'});
    const lead=store.addLead({id:'move-lead',title:'Move me',body:'approved expanded brief',repositories:[alpha],state:'open',author:'operator',version:1,dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
    store.upsertLane({key:'source-lane',title:'Source',aim:'aim',repositories:[alpha]});
    store.upsertLane({key:'destination-lane',title:'Destination',aim:'aim',repositories:[beta]});
    store.setPlan({project:source.key,version:0,entries:[{lane:'source-lane',horizon:'later'}],author:'source-owner'});
    store.setPlan({project:destination.key,version:0,entries:[{lane:'destination-lane',horizon:'now'}],author:'target-owner'});
    const preview=store.projectManagementPreview({key:source.key,target:destination.key});
    assert.equal(preview.tasks[0].taskId,task.id);
    const input={key:source.key,version:source.version,digest:preview.digest,target:destination.key,reason:'Consolidate duplicate labels'};
    const tombstone=store.manageRemoveProject(input);
    assert.equal(store.projectByKey(source.key),null);
    assert.equal(store.projectFor(alpha.path,alpha.origin)?.key,destination.key);
    assert.deepEqual(store.task(task.id),task);
    assert.deepEqual(store.lead(lead.id),lead);
    assert.deepEqual(store.plan({project:destination.key}).entries.map(entry=>[entry.lane,entry.horizon]),[['destination-lane','now'],['source-lane','later']]);
    assert.equal(store.projectByKey(destination.key)?.version,destination.version+1);
    assert.deepEqual(store.manageRemoveProject(input),tombstone,'lost-response replay is idempotent');
    store.upsertProject({key:source.key,name:'Recreated',repositories:[{origin:'acme/new',path:'/new'}]});
    assert.deepEqual(store.manageRemoveProject(input),tombstone);
    assert.equal(store.projectByKey(source.key)?.name,'Recreated','a stale receipt cannot remove a recreated project');
    assert.throws(()=>store.manageRemoveProject({...input,reason:'Different action'}),/already belongs/);
  }finally{store.close()}
});

test('project management: stale source, new task, changed brief, target plan and same-target choices refuse without mutations', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    store.upsertProject({key:'destination',name:'Target',repositories:[beta]});
    const lead=store.addLead({id:'stale-lead',title:'Lead',body:'before',repositories:[alpha],state:'open',author:'operator',version:1,dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
    const preview=store.projectManagementPreview({key:source.key});
    store.updateLead({...lead,body:'new approved work'});
    assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:preview.digest,reason:'cleanup'}),/changed/);
    const next=store.projectManagementPreview({key:source.key});
    submit(store,alpha.path,alpha.origin,'arrived');
    assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:next.digest,reason:'cleanup'}),/changed/);
    const move=store.projectManagementPreview({key:source.key,target:'destination'});
    store.upsertLane({key:'target-lane',title:'Target lane',aim:'aim',repositories:[beta]});
    store.setPlan({project:'destination',version:0,entries:[{lane:'target-lane',horizon:'now'}],author:'operator'});
    assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:move.digest,target:'destination',reason:'move'}),/changed/);
    assert.throws(()=>store.projectManagementPreview({key:source.key,target:source.key}),/different/);
    assert.equal(store.projectByKey(source.key)?.name,'Source');
    assert.equal(store.lead(lead.id).state,'open');
  }finally{store.close()}
});

test('project management: removal closes records without destroying approved bodies, provenance or decision history', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    const lead=store.addLead({id:'drop-me',title:'Lead',body:'retain original approved body',repositories:[alpha,beta],state:'open',author:'operator',version:1,dropReason:null,targets:[],source:null,createdAt:stamp,updatedAt:stamp,closedAt:null},'operator');
    store.addPapercut({id:'deprecate-me',repository:alpha,area:null,title:'Cut',happened:'h',impact:'impact',fix:null,filedBy:'operator',filedAt:stamp,state:'open',taskId:null,closedReason:null,draftId:null,note:null,closedAt:null,source:null,lanes:[]});
    const cut=store.updateLead({...store.lead('deprecate-me'),body:'expanded approved papercut task brief'});
    store.upsertLane({key:'paused-lane',title:'Paused',aim:'aim',repositories:[alpha]});
    store.setLaneStatus('paused-lane','paused');
    const decision=new Decisions(store).add({question:'Keep?',askedBy:'operator',project:alpha});

    const preview=store.projectManagementPreview({key:source.key});
    assert.ok(preview.items.find(item=>item.id===lead.id)?.shared);
    store.manageRemoveProject({key:source.key,version:source.version,digest:preview.digest,reason:'Removed repository'});
    assert.equal(store.lead(lead.id).state,'dropped');
    assert.equal(store.lead(lead.id).body,lead.body);
    assert.deepEqual(store.lead(lead.id).repositories,lead.repositories);
    assert.equal(store.lead(cut.id).state,'closed');
    assert.equal(store.lead(cut.id).body,cut.body);
    assert.equal(store.lead(cut.id).closure?.reason,'deprecated');
    assert.equal(store.laneByKey('paused-lane')?.status,'abandoned');
    assert.equal(store.decision(decision.id).status,'withdrawn');
    assert.equal(store.decision(decision.id).versions.length,decision.versions.length+1);
    assert.deepEqual(store.decision(decision.id).versions[0],decision.versions[0]);
  }finally{store.close()}
});

test('project management: task cancellation is required and unfinished preservation refuses final deletion', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    const task=submit(store,alpha.path,alpha.origin,'cancel-me');
    const preview=store.projectManagementPreview({key:source.key});
    const input={key:source.key,version:source.version,digest:preview.digest,reason:'cleanup'};
    assert.throws(()=>store.manageRemoveProject(input),/Cancel the listed tasks/);
    store.update(task.id,{phase:'cancelled'});
    assert.equal(store.projectManagementPreview({key:source.key}).digest,preview.digest,'task progress alone does not replace the confirmed identity');
    assert.throws(()=>store.manageRemoveProject({...input,cancellationOperationId:'not-complete'}),/has not completed/);
    store.setMeta('bulkDisposition:complete',{status:'complete',action:'cancel',workDisposition:'preserve',items:[{taskId:task.id}]});
    store.manageRemoveProject({...input,cancellationOperationId:'complete'});
    assert.equal(store.task(task.id).phase,'cancelled');
  }finally{store.close()}
});

test('project management: pending admission refuses deletion, but moves with its preserved repository identity', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    store.upsertProject({key:'target',name:'Target',repositories:[beta]});
    const accepted=store.acceptOperation({key:'submit:future',kind:'submit',inputHash:'c'.repeat(64),payload:{type:'submit',submission:submissionSchema.parse({submissionId:'future',title:'Future',repoPath:alpha.path,planningCommit:'a'.repeat(40),handoffPath:'h.md',originAgentId:'operator'})},submissionId:'future',repoPath:alpha.path});
    assert.ok("accepted" in accepted);
    const preview=store.projectManagementPreview({key:source.key});
    assert.ok(preview.items.some(item=>item.kind==='submission'));
    assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:preview.digest,reason:'delete'}),/submissions|operations/);
    const move=store.projectManagementPreview({key:source.key,target:'target'});
    store.manageRemoveProject({key:source.key,version:source.version,digest:move.digest,target:'target',reason:'move pending work'});
    assert.deepEqual(store.operation(accepted.operation.id),accepted.operation);
    assert.equal(store.projectFor(alpha.path,alpha.origin)?.key,'target');
  }finally{store.close()}
});


test('project management: active QA blocks both reassignment and deletion without cancelling the run', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    store.upsertProject({key:'target',name:'Target',repositories:[beta]});
    const run=projectQaRunSchema.parse({id:'active-qa',repository:alpha,key:alpha.origin,state:'queued',baseBranch:'main',base:'a'.repeat(40),argv:['effigy','qa'],digest:'b'.repeat(64),exitCode:null,durationMs:0,outputTail:'',startedAt:stamp,finishedAt:null,pid:null,admission:null,capacityWait:null,capacityUnavailable:false});
    store.putQaRun(run);
    for (const target of [undefined,'target']) {
      const preview=store.projectManagementPreview({key:source.key,target});
      assert.ok(preview.items.some(item=>item.kind==='qa'));
      assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:preview.digest,target,reason:'cleanup'}),/QA must settle/);
    }
    assert.deepEqual(store.qaRun(run.id),run);
    assert.ok(store.projectByKey(source.key));
  } finally {store.close()}
});

test('project management: reset only a proven unaccepted stale cancellation; late delivery remains fenced', async t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    const task=submit(store,alpha.path,alpha.origin,'reset-me');
    const operationId='project-removal-source-refused';
    const reset={key:source.key,operationId,tasks:[{taskId:task.id,version:task.version}]};
    assert.throws(()=>store.resetProjectCancellation(reset),/definitive refusal/);
    store.update(task.id,{title:'Author advanced while preview was open'});
    const {Engine}=await import('../core/engine');
    const engine=Object.assign(Object.create(Engine.prototype),{store,control:async(fn:()=>unknown)=>fn(),scheduleBulk:()=>assert.fail('must not deliver')}) as InstanceType<typeof Engine>;
    const request={operationId,tasks:reset.tasks,action:'cancel' as const,workDisposition:'preserve' as const,reason:'cleanup'};
    await assert.rejects(Engine.prototype.startBulkDisposition.call(engine,request),/Task changed/);
    assert.deepEqual(store.resetProjectCancellation(reset),{reset:true});
    await assert.rejects(Engine.prototype.startBulkDisposition.call(engine,request),/retired/);
    assert.equal(store.task(task.id).disposition,null);
    store.setMeta('bulkDisposition:project-removal-source-accepted',{status:'pending'});
    assert.throws(()=>store.resetProjectCancellation({...reset,operationId:'project-removal-source-accepted'}),/was accepted/);
    assert.throws(()=>store.resetProjectCancellation({...reset,operationId:'another-project-operation'}),/does not belong/);
  }finally{store.close()}
});

test('project management: an unsettled operation remains attached through its durable repository path', t => {
  const store=fixture(t);
  try {
    const source=store.upsertProject({key:'source',name:'Source',repositories:[alpha]});
    const operation=store.acceptOperation({key:'check:former-lead',kind:'lead_check',inputHash:'a'.repeat(64),repoPath:alpha.path,payload:{type:'lead_check',id:'closed-or-removed-lead',version:1,digest:'sha256:'+ 'b'.repeat(64),agentId:'operator'}});
    assert.ok('accepted' in operation);
    const preview=store.projectManagementPreview({key:source.key});
    assert.ok(preview.items.some(item=>item.kind==='operation'&&item.id===operation.operation.id));
    assert.throws(()=>store.manageRemoveProject({key:source.key,version:source.version,digest:preview.digest,reason:'cleanup'}),/operations must settle/);
    assert.ok(store.projectByKey(source.key));
  }finally{store.close()}
});
