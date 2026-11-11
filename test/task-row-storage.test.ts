import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { cpus, loadavg, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { briefDigest } from '../core/planning/brief';
import { submissionSchema, taskDetailView, taskNextSchema, type Task } from '../shared/contracts';

/**
 * Audit B6 (2026-10-25 performance audit, baseline main d5e20937; Tom's "Slimmer
 * task rows" ruling a1a817c3): one copy of a task's brief text, pins resolved by
 * key/version/digest, and observation-only writes that touch neither the task row
 * nor the board revision.
 *
 * Every fixture here is an isolated store under a fresh temporary directory. No
 * live database, profile, pause state, credential or process is read or written.
 * The benchmark's parent lane is the pre-change write (the whole task row, text
 * included) implemented beside the new one, so the comparison never depends on
 * another commit or another machine's load.
 */

const HEAD = 'a'.repeat(40);
const STAMP = '2026-10-08T00:00:00.000Z';
const repo = { origin: 'owner/repo', path: '/repo' };
const HANDOFF = `# Handoff\n\nKeep these exact bytes.\n${'h'.repeat(90_000)}\n  trailing  \n`;
const SECOND_HANDOFF = `# Handoff (old committed form)\n\nDifferent bytes from the brief.${'g'.repeat(64)}\n`;
const BRIEF = `# Brief\n\nA Queue-held brief.${'b'.repeat(80_000)}\n`;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const round = (value: number) => Number(value.toFixed(2));
const taskRowData = (store: Store, id: string) => String((store.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as { data: string }).data);
const count = (store: Store, table: string, id: string) => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE taskId=?`).get(id) as { n: number }).n);

/** The whole file as one consistent copy, WAL included. */
function checkpointCopy(store: Store, from: string, to: string) {
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(from, to);
}

/** A store on a real file so a restart and a rolled-back copy can be opened again. */
function fileStore(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'ns-task-row-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'queue.sqlite') };
}

function submit(store: Store, id: string, extra: Record<string, unknown> = {}) {
  return store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo',
    planningCommit: HEAD, handoffPath: `${id}.md`, originAgentId: 'origin', ...extra }), 'host', HANDOFF, HEAD);
}

function briefSubmission(id: string, text: string) {
  return submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo', planningCommit: HEAD,
    originAgentId: 'origin', brief: { text, mediaType: 'text/markdown' } });
}

/** The row a pre-schema-45 build wrote: every copy inline. */
function inlineRow(task: Task): string {
  const { briefVersions: _versions, resolution: { review: _review, reviews: _reviews, ...resolution }, ...row } = task;
  return JSON.stringify({ ...row, resolution });
}

/** Every public read this task can produce, canonicalised. */
async function publicReads(store: Store, ids: string[]) {
  const { ownerTaskNext, collectOwnerVerbFacts } = await import('../core/verbs/owner-verbs');
  const tasks: Record<string, unknown> = {}, details: Record<string, unknown> = {}, next: Record<string, unknown> = {};
  for (const id of ids) {
    const task = store.task(id);
    tasks[id] = task;
    details[id] = taskDetailView(task);
    next[id] = taskNextSchema.parse(ownerTaskNext(collectOwnerVerbFacts(store, task)));
  }
  return JSON.stringify({ tasks, details, next, outcomes: store.outcomes() });
}

test('a legacy author-escalation row is stripped on open; its events stay readable', t => {
  const { path } = fileStore(t);
  let store = new Store(path);
  try {
    const task = submit(store, 'legacy-escalation');
    const legacy = { id: 'old-escalation', status: 'completed' as const, at: STAMP,
      reviews: [1, 2, 3].map(index => ({ runId: `review-${index}`, eventId: `event-${index}` })),
      oldProfileId: 'worker-old', oldModel: 'vendor/old', oldCapability: 'medium' as const,
      newProfileId: 'worker-new', newModel: 'vendor/new', newCapability: 'high' as const,
      head: HEAD, briefVersion: null, revisionRuns: 3, sourceDigest: 'b'.repeat(64),
      oldAgentId: 'old-agent', oldRunId: 'old-run' };
    const raw = JSON.parse(taskRowData(store, task.id)) as { resolution: Record<string, unknown> };
    raw.resolution.authorEscalations = [legacy];
    store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(raw), task.id);
    store.event(task.id, 'author_escalation_reserved', JSON.stringify(legacy));
    store.close();
    store = new Store(path);
    assert.equal('authorEscalations' in (store.task(task.id).resolution as unknown as Record<string, unknown>), false,
      'the store step strips the retired escalation history the strict schema refuses');
    const event = store.eventsAll(task.id).at(-1)!;
    assert.equal(event.kind, 'author_escalation_reserved');
    assert.deepEqual(JSON.parse(event.detail), legacy);
  } finally { store.close(); }
});

/** A task, a lane document pinned at v1, and the document later edited to v2. */
function pinnedFixture(store: Store, id = 'pinned') {
  store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Alpha ships', repositories: [repo] });
  const document = store.editLaneDocument({ key: 'alpha', version: 0, text: 'Pinned lane document v1 bytes', author: 'owner' });
  const task = store.insert(submissionSchema.parse({ submissionId: id, title: id, repoPath: '/repo', planningCommit: HEAD,
    handoffPath: `${id}.md`, originAgentId: 'origin', laneDocuments: ['alpha'] }), 'host', HANDOFF, HEAD);
  const pins = store.laneDocumentPinsFor(store.task(task.id))!;
  const pinned = store.update(task.id, { laneDocumentPins: pins });
  // The document moves on; the pin must keep v1.
  store.editLaneDocument({ key: 'alpha', version: document.version, text: 'Pinned lane document v2 bytes', author: 'owner' });
  return { task: pinned, document };
}

test('shared brief text resolves from its version and independent handoffs retain their bytes', () => {
  const store = new Store(':memory:');
  try {
    const handoff = submit(store, 'handoff');
    const brief = store.insert(briefSubmission('brief', BRIEF), 'host', BRIEF, HEAD);
    // An uneven historical form: the handoff bytes are not the brief bytes.
    const uneven = store.insert(briefSubmission('uneven', BRIEF), 'host', SECOND_HANDOFF, HEAD);

    for (const [id, text, briefText] of [[handoff.id, HANDOFF, null], [brief.id, BRIEF, BRIEF], [uneven.id, SECOND_HANDOFF, BRIEF]] as const) {
      const row = JSON.parse(taskRowData(store, id)) as Record<string, unknown>;
      if (id === brief.id) {
        assert.equal(Object.hasOwn(row, 'handoffText'), false, `${id}: shared handoff is referenced`);
        assert.equal(row.handoffDigest, briefDigest(text));
      } else assert.equal(row.handoffText, text, `${id}: independent handoff stays inline`);
      assert.equal(Object.hasOwn(row, 'briefVersions'), false);
      const storedBrief = row.brief as Record<string, unknown> | null;
      if (briefText !== null) assert.equal(Object.hasOwn(storedBrief!, 'text'), false, `${id}: the row stores no brief text`);
      const resolution = row.resolution as Record<string, unknown>;
      const read = store.task(id);
      for (const key of ['buildOutputCleanups', 'runtimeRetirements', 'externalWorkspaceArchives', 'ownerAcceptances', 'reviewSupersessions'] as const) {
        assert.equal(Object.hasOwn(resolution, key), false, `${id}: empty ${key} is omitted`);
        assert.deepEqual(read.resolution[key], [], `${id}: ${key} defaults on read`);
      }
      assert.equal(read.handoffText, text, `${id}: the handoff text is the exact submitted bytes`);
      if (briefText !== null) assert.equal(read.brief!.text, briefText, `${id}: the brief text is the exact submitted bytes`);
      // Host selection adds a bounded identity and provenance object to each row.
      if (id === brief.id) assert.ok(taskRowData(store, id).length < 4_100, `${id}: shared text keeps the row slim`);
    }
    assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_texts'").get(), undefined);
    for (const id of [brief.id, uneven.id]) {
      const versions = store.task(id).briefVersions;
      assert.deepEqual(versions.map(version => version.text), [BRIEF]);
      assert.equal(versions[0].digest, briefDigest(BRIEF));
    }
    assert.deepEqual(store.task(uneven.id).briefVersions.map(version => version.text), [BRIEF]);
  } finally { store.close(); }
});

test('current stores read retained inline task history across restart and backup', async t => {
  const { dir, path } = fileStore(t);
  const rollback = join(dir, 'pre-migration.sqlite');
  let store = new Store(path);
  const handoff = submit(store, 'migrate-handoff');
  store.update(handoff.id, { phase: 'working', agentId: 'agent', agentIntent: true, workspaceId: 'ws',
    lastAgentStatus: 'running', agentActive: true, lastObservedAt: STAMP, idleSince: STAMP });
  const brief = store.insert(briefSubmission('migrate-brief', BRIEF), 'host', BRIEF, HEAD);
  // The uneven form: a brief task whose stored handoff bytes were never the brief.
  const uneven = store.insert(briefSubmission('migrate-uneven', BRIEF), 'host', SECOND_HANDOFF, HEAD);
  const pinned = pinnedFixture(store, 'migrate-pinned');
  store.update(brief.id, { phase: 'done', prUrl: 'https://github.com/owner/repo/pull/7', prHead: HEAD,
    resolution: { ...store.task(brief.id).resolution, mergedCommit: 'c'.repeat(40) } });
  const ids = [handoff.id, brief.id, uneven.id, pinned.task.id];
  const baseline = await publicReads(store, ids);
  assert.ok(store.task(handoff.id).handoffText === HANDOFF);

  // The schema 44 shape: the same tasks, every copy inline, no side storage.
  store.transaction(() => {
    for (const id of ids) store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(inlineRow(store.task(id)), id);
    store.db.exec('DELETE FROM task_observations;');
  });
  checkpointCopy(store, path, rollback);
  // The rolled-back copy is the same pre-migration fixture the migration's backup holds.
  assert.equal(JSON.parse(taskRowData(store, handoff.id)).handoffText, HANDOFF);
  store.close();

  for (const [label, target] of [['migrate', path], ['restart', path], ['rollback', rollback]] as const) {
    store = new Store(target);
    assert.equal(store.getMeta('schema'), CURRENT_SCHEMA, `${label}: the store is at the current schema`);
    assert.equal(await publicReads(store, ids), baseline, `${label}: every public task, detail, next and outcome read is byte-identical`);
    const read = store.task(handoff.id);
    assert.equal(read.handoffText, HANDOFF, `${label}: legacy handoff bytes survive exactly`);
    assert.equal(store.task(uneven.id).handoffText, SECOND_HANDOFF, `${label}: the unequal handoff keeps its own bytes`);
    assert.equal(store.task(uneven.id).brief!.text, BRIEF, `${label}: the unequal brief keeps its own bytes`);
    assert.equal(store.task(pinned.task.id).laneDocumentPins![0].text, 'Pinned lane document v1 bytes', `${label}: the pin resolves v1, not the edited document`);
    assert.equal(store.task(handoff.id).lastObservedAt, STAMP, `${label}: the observation reads as written`);
    assert.equal(store.task(handoff.id).lastAgentStatus, 'running');
    assert.equal(JSON.parse(taskRowData(store, handoff.id)).handoffText, HANDOFF, `${label}: retained inline bytes are unchanged`);
    assert.equal(Object.hasOwn(JSON.parse(taskRowData(store, pinned.task.id)) as Record<string, unknown>, 'handoffText'), true);
    const pins = JSON.parse(taskRowData(store, pinned.task.id)).laneDocumentPins as Array<Record<string, unknown>>;
    assert.equal(Object.hasOwn(pins[0], 'text'), true, `${label}: retained inline pin text is unchanged`);
    assert.equal(pins[0].version, 1);
    assert.equal(count(store, 'task_observations', handoff.id), 0);
    store.close();
  }
});

test('pins keep the pinned version through edits and refuse an unknown or corrupt document', async t => {
  const { dir, path } = fileStore(t);
  const corruptDigest = join(dir, 'corrupt-digest.sqlite');
  let store = new Store(path);
  const { task } = pinnedFixture(store);
  assert.deepEqual(store.task(task.id).laneDocumentPins!.map(({ key, version, digest, text }) => ({ key, version, digest, text })),
    [{ key: 'alpha', version: 1, digest: briefDigest('Pinned lane document v1 bytes'), text: 'Pinned lane document v1 bytes' }]);
  assert.equal(store.laneDocument('alpha')!.version, 2, 'the document moved on');
  checkpointCopy(store, path, corruptDigest);
  store.close();

  // A document version that is not stored refuses; the current text is never substituted.
  // The older version may live in either storage form (audit B1 reverse deltas), so remove it
  // wherever the store keeps it.
  const dropped = new DatabaseSync(path);
  dropped.exec("DELETE FROM lane_documents WHERE lane='alpha' AND version=1; DELETE FROM lane_document_deltas WHERE lane='alpha' AND version=1");
  dropped.close();
  const missing = new Store(path);
  assert.throws(() => missing.task(task.id), /pins lane document alpha v1, which is not stored; refusing to resolve its text/);
  missing.close();

  // Bytes that do not match the pinned digest refuse too.
  const tampered = new DatabaseSync(corruptDigest);
  tampered.prepare("UPDATE tasks SET data=json_set(data,'$.laneDocumentPins[0].digest',?) WHERE id=?")
    .run(`sha256:${'f'.repeat(64)}`, task.id);
  tampered.close();
  const corrupt = new Store(corruptDigest);
  assert.throws(() => corrupt.task(task.id), /stored bytes do not match sha256:f{64}; refusing to resolve its text/);
  corrupt.close();
});

test('observation-only writes land in the side row and never rewrite the task row or the board', () => {
  const store = new Store(':memory:');
  try {
    const task = submit(store, 'observed');
    store.update(task.id, { phase: 'working', agentId: 'agent', agentIntent: true, workspaceId: 'ws',
      lastAgentStatus: 'running', agentActive: true, lastObservedAt: STAMP });
    const before = store.task(task.id), row = taskRowData(store, task.id);
    const board = store.boardRevision();
    const observed = '2026-10-08T00:05:00.000Z';
    store.update(task.id, { lastObservedAt: observed });
    assert.equal(taskRowData(store, task.id), row, 'the task row is not rewritten');
    assert.equal(store.boardRevision(), board, 'no board revision');
    assert.equal(store.observationTimes('task', [task.id]).get(task.id), observed, 'the counters read the fresh time');
    const after = store.task(task.id);
    assert.equal(after.lastObservedAt, observed);
    // The write time is the observation row's, so every reader sees the time the parent write
    // would have stamped; two writes inside one millisecond may share it, hence no strict >.
    const side = JSON.parse(store.db.prepare('SELECT data FROM task_observations WHERE taskId=?').get(task.id)!.data as string) as { updatedAt: string };
    assert.equal(after.updatedAt, side.updatedAt, 'the write time is the one the observation recorded');
    assert.ok(after.updatedAt >= before.updatedAt);
    assert.equal(after.version, before.version, 'an observation spends no version');
    assert.equal(after.lastSubstantiveVersion, before.lastSubstantiveVersion);
    store.update(task.id, { lastObservedAt: observed, hostSelection: before.hostSelection });
    store.update(task.id, { lastObservedAt: observed, hostSelection: undefined });
    assert.equal(taskRowData(store, task.id), row, 'repeating or omitting selection never rewrites the row');
    assert.deepEqual(store.task(task.id).hostSelection, before.hostSelection);
    assert.throws(() => store.update(task.id, { hostSelection: { hostId: 'other', basis: 'explicit' } }), /host selection cannot be changed/);
    assert.equal(count(store, 'task_observations', task.id), 1);
    // A state change is a board fact and still spends a version, as before.
    const changed = store.update(task.id, { lastAgentStatus: 'idle', agentActive: false });
    assert.ok(store.boardRevision() > board, 'a changed status rebuilds the board');
    assert.equal(changed.version, before.version + 1);
    assert.equal(store.task(task.id).lastAgentStatus, 'idle');
    assert.equal(store.observationTimes('task', [task.id]).get(task.id), observed);
    // Optimistic concurrency is unchanged: an observation-only write leaves the version alone,
    // so a control holding it still applies, while the state change above makes it stale.
    const fresh = store.update(task.id, { lastObservedAt: observed });
    assert.equal(store.update(task.id, { reason: 'a control at the observed version' }, undefined, '', fresh.version).reason,
      'a control at the observed version', 'an observation-only write does not stale a held version');
    assert.throws(() => store.update(task.id, { reason: 'stale' }, undefined, '', before.version), /Task changed; refresh before retrying/);
  } finally { store.close(); }
});

/**
 * Review 5644429596: an observation-only write is the task row's write boundary too, so its
 * side table advances the projection's writes clock exactly as the task row does. A rollback
 * rewinds that clock, which discards the warm projection instead of serving the rolled-back
 * time — the SQL and the cached read have to answer the same thing.
 */
test('a rolled-back observation writes nothing a reader can see, warm projection included', () => {
  const store = new Store(':memory:');
  try {
    const task = submit(store, 'rolled-back');
    const committed = store.update(task.id, { phase: 'working', agentId: 'agent', workspaceId: 'ws',
      lastAgentStatus: 'running', agentActive: true, lastObservedAt: STAMP });
    assert.equal(store.task(task.id).lastObservedAt, STAMP, 'the projection is warm before the rollback');
    const board = store.boardRevision();
    const projections = () => (store as unknown as { tasksStore: { taskProjection: Map<string, unknown> | null } }).tasksStore.taskProjection;
    const warm = projections();
    assert.ok(warm, 'a projected row exists before the rolled-back write');
    const leaked = '2026-10-08T00:05:00.000Z';
    assert.throws(() => store.transaction(() => {
      store.update(task.id, { lastObservedAt: leaked });
      assert.equal(store.task(task.id).lastObservedAt, leaked, 'the transaction sees its own observation');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.task(task.id).lastObservedAt, STAMP, 'the warm projection does not keep the rolled-back observation');
    assert.equal(store.task(task.id).updatedAt, committed.updatedAt, 'nor the write time it moved');
    assert.strictEqual(projections(), warm, 'rollback restores the warm projection in place');
    assert.equal(store.observationTimes('task', [task.id]).get(task.id), STAMP, 'the counter read rewound with the row');
    assert.equal(store.boardRevision(), board, 'a rolled-back observation spends no board revision');
    const clock = (store as unknown as { tasksStore: { projectionClock: number; readProjectionClock(): number } }).tasksStore;
    assert.equal(clock.projectionClock, clock.readProjectionClock(), 'the restored projection acknowledged the rewound clock');
  } finally { store.close(); }
});

/**
 * Audit B6's measurement: serialized task rows and write bytes under observation
 * churn on representative 90 KB rows. The parent lane writes the whole task row
 * exactly as the pre-change store did; the new lane writes only the observation
 * row. Both lanes hold the same public task.
 */
test('nine representative rows: observation churn writes a bounded side row, not the whole task row', t => {
  const { dir } = fileStore(t);
  const ROWS = 9;
  const PASSES = 20;
  const build = (name: string) => {
    const path = join(dir, `${name}.sqlite`);
    const store = new Store(path);
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    const ids: string[] = [];
    for (let index = 0; index < ROWS; index++) {
      const task = store.insert(submissionSchema.parse({ submissionId: `${name}-${index}`, title: `${name} ${index}`,
        repoPath: '/repo', planningCommit: HEAD, brief: { text: HANDOFF, mediaType: 'text/markdown' }, originAgentId: 'origin' }), 'host', HANDOFF, HEAD);
      ids.push(store.update(task.id, { phase: 'working', agentId: 'agent', workspaceId: 'ws', lastAgentStatus: 'running',
        agentActive: true, lastObservedAt: STAMP }).id);
    }
    return { store, ids, path };
  };
  const child = build('child');
  const parent = build('parent');
  // The parent lane's rows are the pre-change shape: text and observations inline.
  parent.store.transaction(() => {
    for (const id of parent.ids) parent.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(inlineRow(parent.store.task(id)), id);
    parent.store.db.exec('DELETE FROM task_observations;');
  });
  const inlineTask = (store: Store, id: string) => {
    const { briefVersions: _v, resolution: { review: _r, reviews: _rs, ...resolution }, ...row } = store.task(id);
    return JSON.stringify({ ...row, resolution });
  };

  /** Bytes of every write statement and its bound values, and the task-row rewrites among them. */
  const meter = (store: Store) => {
    const target = store.db as unknown as { prepare: (sql: string) => unknown };
    const original = store.db.prepare.bind(store.db);
    const counts = { bytes: 0, taskRows: 0, briefRows: 0 };
    target.prepare = (sql: string) => {
      const statement = original(sql) as unknown as { run: (...args: never[]) => unknown };
      const run = statement.run.bind(statement);
      statement.run = ((...args: never[]) => {
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
          counts.bytes += Buffer.byteLength(sql) + args.reduce<number>((sum, arg) => sum + (typeof arg === 'string' ? Buffer.byteLength(arg) : typeof arg === 'number' ? 8 : 0), 0);
          if (/^\s*UPDATE\s+tasks\s/i.test(sql)) counts.taskRows++;
          if (/^\s*(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?task_brief_versions\b/i.test(sql)) counts.briefRows++;
        }
        return run(...args);
      }) as never;
      return statement;
    };
    return { counts, restore() { target.prepare = original as unknown as (sql: string) => unknown; } };
  };
  const walBytes = (path: string) => existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
  const run = (store: Store, path: string, write: (id: string, index: number) => void) => {
    const watch = meter(store);
    try {
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const start = walBytes(path);
      for (let index = 0; index < PASSES; index++)
        for (const id of store === child.store ? child.ids : parent.ids) write(id, index);
      return { bytes: watch.counts.bytes, taskRows: watch.counts.taskRows, briefRows: watch.counts.briefRows, wal: walBytes(path) - start };
    } finally { watch.restore(); }
  };
  try {
    const observation = (index: number) => new Date(Date.parse(STAMP) + (index + 1) * 1_000).toISOString();
    const childRun = run(child.store, child.path, (id, index) => child.store.update(id, { lastObservedAt: observation(index) }));
    // The parent write is the pre-change store's `UPDATE tasks SET data=?` with the whole row.
    const parentRun = run(parent.store, parent.path, (id, index) => {
      const row = JSON.parse(inlineTask(parent.store, id)) as Record<string, unknown>;
      row.lastObservedAt = observation(index);
      row.updatedAt = observation(index);
      parent.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify({ ...row,
        briefVersions: undefined, resolution: { ...(row.resolution as Record<string, unknown>) } }), id);
    });

    // An ordinary substantive update rewrites the slim row and no text at all, where the
    // parent rewrote the whole row for the same change.
    const childSubstantive = run(child.store, child.path, (id, index) => child.store.update(id, { reason: `moved ${index}` }));
    const parentSubstantive = run(parent.store, parent.path, (id, index) => {
      const row = JSON.parse(inlineTask(parent.store, id)) as Record<string, unknown>;
      row.reason = `moved ${index}`;
      row.updatedAt = observation(index);
      parent.store.db.prepare('UPDATE tasks SET data=? WHERE id=?')
        .run(JSON.stringify({ ...row, resolution: { ...(row.resolution as Record<string, unknown>) } }), id);
    });
    assert.equal(childSubstantive.briefRows, 0, 'an ordinary update writes no copy of the task text');
    assert.ok(childSubstantive.bytes * 10 < parentSubstantive.bytes,
      `an ordinary update spends a fraction of the parent bytes: ${childSubstantive.bytes} vs ${parentSubstantive.bytes}`);
    const childRow = child.ids.reduce((sum, id) => sum + Buffer.byteLength(taskRowData(child.store, id)), 0);
    const parentRow = parent.ids.reduce((sum, id) => sum + Buffer.byteLength(inlineTask(parent.store, id)), 0);
    // Include the bounded host-selection provenance in the slim-row allowance.
    assert.ok(taskRowData(child.store, child.ids[0]).length < 4_100, 'a slim row stays small');
    assert.ok(childRow * 10 < parentRow, `slim rows are at least ten times smaller: ${childRow} vs ${parentRow}`);
    assert.equal(childRun.taskRows, 0, 'no observation churn rewrites a task row');
    assert.equal(parentRun.taskRows, ROWS * PASSES, 'the parent rewrote the whole row on every pass');
    assert.ok(childRun.bytes * 20 < parentRun.bytes, `observation writes spend a fraction of the parent bytes: ${childRun.bytes} vs ${parentRun.bytes}`);
    assert.ok(childRun.wal * 2 < parentRun.wal, `the WAL grows by a fraction: ${childRun.wal} vs ${parentRun.wal}`);
    // The values every reader sees did move in both lanes.
    assert.equal(child.store.task(child.ids[0]).lastObservedAt, observation(PASSES - 1));
    assert.equal(child.store.observationTimes('task', child.ids).get(child.ids[0]), observation(PASSES - 1));
    const repeated = [0, 1, 2].map(() => run(child.store, child.path, (id, index) => child.store.update(id, { lastObservedAt: observation(index) })).bytes);
    console.log(JSON.stringify({
      benchmark: 'audit B6 task row storage and observation churn',
      command: 'effigy test unit -- test/task-row-storage.test.ts',
      environment: { node: process.version, cpu: cpus()[0]?.model, cpus: cpus().length, totalMemGiB: round(totalmem() / 1024 ** 3), loadavg: loadavg().map(round) },
      fixture: { tasks: ROWS, handoffTextBytes: Buffer.byteLength(HANDOFF), passes: PASSES,
        cache: 'warm projection, WAL checkpointed with autocheckpoint off, one process per run' },
      rows: { slimBytes: childRow, parentBytes: parentRow, ratio: round(parentRow / childRow) },
      observationChurn: { slimWriteBytes: childRun.bytes, parentWriteBytes: parentRun.bytes,
        writeByteRatio: round(parentRun.bytes / childRun.bytes), slimTaskRowRewrites: childRun.taskRows, parentTaskRowRewrites: parentRun.taskRows,
        slimWalBytes: childRun.wal, parentWalBytes: parentRun.wal, slimMedianRepeatedBytes: median(repeated) },
      substantiveUpdate: { slimWriteBytes: childSubstantive.bytes, parentWriteBytes: parentSubstantive.bytes,
        writeByteRatio: round(parentSubstantive.bytes / childSubstantive.bytes), briefVersionWrites: childSubstantive.briefRows },
      note: 'The audit live baseline (4 % CPU, 830 MB RSS, average task row 90 KB weighted by event count) is Supervisor b885\u2019s measurement, not this task\u2019s result. These are isolated fixture counts.',
    }));
  } finally { child.store.close(); parent.store.close(); }
});
