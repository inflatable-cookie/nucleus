import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, loadavg, totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA, Store, digest } from '../core/store/store';
import { Leads } from '../core/planning/leads';
import { briefDigest } from '../core/planning/brief';
import {
  DELTA_FORMAT, HistoryBodyCache, MAX_DELTA_CHAIN, PlanningHistory, SNAPSHOT_INTERVAL, applyHistoryDelta, encodeHistoryDelta,
  historyDigest, parseHistoryDelta, readStoredHistory, splitHistoryLines,
} from '../core/planning/planning-history';
import { laneDocumentVersionSchema, leadVersionSchema, submissionSchema, type LeadVersion } from '../shared/contracts';

/**
 * Audit B1 (2026-10-25 performance audit, baseline main d5e20937; Tom's "Lead version
 * storage" ruling a1a817c3): the latest lead or lane-document body is stored in full,
 * older versions are reverse line deltas against the next version with a full snapshot
 * every SNAPSHOT_INTERVAL versions, and every rebuilt version is checked against its
 * stored digest. Contract 008 exports stay full with the same digests.
 *
 * Every fixture is an isolated store in a fresh temporary directory. No live database,
 * profile, pause state, credential or process is read or written. The benchmark's parent
 * lane is the pre-change storage (every version full) written beside the new one in the
 * same test and process, so the comparison never depends on another commit or host load.
 */

const HEAD = 'a'.repeat(40);
const alpha = { origin: 'owner/alpha', path: '/fixture/alpha' };
const STAMP = '2026-10-08T00:00:00.000Z';
const VERSIONS = 100;

const clearCache = (store: Store) => (store as unknown as { planningStore: { clearHistoryCache(): void } }).planningStore.clearHistoryCache();
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const round = (value: number) => Number(value.toFixed(2));

function fileStore(t: { after: (fn: () => void) => void }, prefix = 'ns-planning-history-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'queue.sqlite') };
}

/** A deterministic pseudo-random source, so a failing delta fixture is reproducible. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
}

/** Bodies that cover the byte shapes the brief names: Unicode, CRLF, no final newline, empty, large. */
function corpus(): string[] {
  const large = Array.from({ length: 4_000 }, (_, index) => `line ${index} ${'x'.repeat(index % 60)}`).join('\n');
  return [
    '', 'single line', 'no final newline', '\n\n\n', 'trailing newline\n',
    'Unicode: ✓ naïve — 漢字 😀 \u0000-like \u{1F600}\nsecond line\n',
    'CRLF\r\nsecond\r\nthird\r\n',
    'CRLF without a final newline\r\nsecond\r',
    '# Heading\n\n- one\n- two\n\n```\ncode fence\n```\n',
    `${large}\n`,
    `${'a'.repeat(1_000_000)}`,
  ];
}

/** Arbitrary inserts and deletes anywhere, including at both ends, over the newer body. */
function editedBodies(body: string, seed: number): string[] {
  const next = random(seed);
  const lines = splitHistoryLines(body);
  const versions: string[] = [];
  let current = lines;
  for (let round = 0; round < 24; round++) {
    const copy = [...current];
    const edits = 1 + Math.floor(next() * 3);
    for (let edit = 0; edit < edits; edit++) {
      const at = Math.floor(next() * (copy.length + 1));
      const kind = next();
      if (kind < 0.45 && copy.length) copy.splice(Math.min(at, copy.length - 1), 1, `${copy[Math.min(at, copy.length - 1)]} changed ${round}\n`);
      else if (kind < 0.75) copy.splice(at, 0, `inserted ${round} ${'y'.repeat(Math.floor(next() * 80))}\n`);
      else if (copy.length) copy.splice(Math.min(at, copy.length - 1), 1);
    }
    current = copy;
    versions.push(copy.join(''));
  }
  return versions;
}

test('B1 reverse deltas rebuild every version byte-exact for Unicode, CRLF, no final newline, empty, large and arbitrarily edited bodies', () => {
  for (const body of corpus()) {
    assert.equal(splitHistoryLines(body).join(''), body, 'line splitting is byte-exact');
    const versions = editedBodies(body, body.length + 7);
    let newer = body;
    for (const older of versions) {
      const delta = encodeHistoryDelta(newer, older, { baseVersion: 2, targetVersion: 1 }, 'fixture');
      assert.equal(applyHistoryDelta(newer, delta, 'fixture'), older, `exact rebuild of ${older.length} bytes`);
      assert.equal(historyDigest(older), historyDigest(applyHistoryDelta(newer, delta, 'fixture')));
      // The stored form round-trips through JSON exactly like the database text column.
      const stored = parseHistoryDelta(JSON.stringify(delta), 'fixture');
      assert.equal(applyHistoryDelta(newer, stored, 'fixture'), older);
      newer = older;
    }
  }
  // A delta against an empty body and an empty target are both valid histories.
  for (const [newer, older] of [['', ''], ['', 'added\n'], ['removed\n', ''], ['\n', '']] as const)
    assert.equal(applyHistoryDelta(newer, encodeHistoryDelta(newer, older, { baseVersion: 1, targetVersion: 1 }, 'fixture'), 'fixture'), older);
});

/** A near-copy history, the shape audit B1 measured: one ledger appending to itself. */
function ledgerBodies(count = VERSIONS, growth = 300): string[] {
  const bodies: string[] = [];
  let body = '# Ordinary Queue reliability\n\nLedger entry 1\n';
  for (let version = 1; version <= count; version++) {
    body += `- entry ${version}: ${'L'.repeat(growth)} noted\n`;
    bodies.push(body);
  }
  return bodies;
}

function addHistory(store: Store, bodies: string[], id = 'ledger', author = 'owner'): void {
  store.transaction(() => {
    let lead = store.addLead({ id, title: 'Ledger', body: bodies[0], repositories: [alpha], lanes: [], author, state: 'open',
      version: 1, dropReason: null, targets: [], source: null, createdAt: STAMP, updatedAt: STAMP, closedAt: null }, author);
    for (let index = 1; index < bodies.length; index++) {
      lead = store.updateLead({ ...lead, body: bodies[index], version: index + 1, updatedAt: new Date(Date.parse(STAMP) + index * 1_000).toISOString() }, author);
    }
  });
}

test('B1 a 100-version history keeps bounded snapshots and every version rebuilds byte-exact through the public reads', (t) => {
  const { path } = fileStore(t);
  const store = new Store(path);
  try {
    const bodies = ledgerBodies();
    addHistory(store, bodies);
    const full = store.db.prepare('SELECT version FROM lead_versions WHERE leadId=? ORDER BY version').all('ledger').map(row => Number(row.version));
    const deltas = store.db.prepare('SELECT version FROM lead_version_deltas WHERE leadId=? ORDER BY version').all('ledger').map(row => Number(row.version));
    assert.deepEqual(full, Array.from({ length: VERSIONS }, (_, index) => index + 1).filter(version => version === VERSIONS || version % SNAPSHOT_INTERVAL === 0));
    assert.equal(full.length + deltas.length, VERSIONS, 'every version is stored exactly once');
    assert.equal(deltas.length, VERSIONS - full.length);
    // The snapshot interval bounds what a rebuild walks: never more than MAX_DELTA_CHAIN deltas.
    assert.equal(MAX_DELTA_CHAIN, SNAPSHOT_INTERVAL - 1);
    assert.deepEqual(store.leadVersions('ledger').map(version => version.body), bodies);
    for (const version of [1, 2, 31, 32, 33, 63, 64, 65, 96, VERSIONS - 1, VERSIONS]) {
      assert.equal(store.leadVersion('ledger', version).body, bodies[version - 1], `version ${version} is byte-exact`);
      assert.equal(briefDigest(store.leadVersion('ledger', version).body), historyDigest(bodies[version - 1]));
    }
    assert.equal(store.leadVersionOrNull('ledger', VERSIONS + 1), null);
    // The detail read keeps every version as metadata and only the current body.
    const history = store.leadVersionHistory('ledger', VERSIONS);
    assert.equal(history.length, VERSIONS);
    assert.equal((history.at(-1) as LeadVersion).body, bodies.at(-1));
    assert.ok(history.slice(0, -1).every(version => !('body' in version)), 'no superseded body crosses the detail read');
    // A restart reads the same bytes out of the same file.
    store.close();
    const reopened = new Store(path);
    try {
      assert.equal(reopened.leadVersion('ledger', 100).body, bodies[99]);
    } finally { reopened.close(); }
  } finally { /* closed above; a second close would throw on the closed handle. */ }
});

test('B1 a lane document history keeps the same exact-rebuild guarantee across its snapshot boundary', (t) => {
  const { path } = fileStore(t);
  const store = new Store(path);
  try {
    store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Aim', repositories: [alpha] });
    const texts = ledgerBodies(70, 200);
    let version = 0;
    for (const text of texts) version = store.editLaneDocument({ key: 'alpha', version, text, author: 'operator' }).version;
    assert.equal(version, texts.length);
    const full = store.db.prepare('SELECT version FROM lane_documents WHERE lane=?').all('alpha').map(row => Number(row.version));
    assert.deepEqual(full, [32, 64, 70]);
    for (const wanted of [1, 31, 32, 33, 63, 64, 65, 70]) {
      const read = store.laneDocument('alpha', wanted)!;
      assert.equal(read.text, texts[wanted - 1]);
      assert.equal(read.digest, briefDigest(texts[wanted - 1]));
      assert.equal(laneDocumentVersionSchema.parse(read).version, wanted);
    }
    assert.equal(store.laneDocument('alpha')!.text, texts.at(-1));
    assert.equal(store.laneDocument('alpha', 999), null);
  } finally { store.close(); }
});

test('B1 current mixed and full histories remain readable', (t) => {
  const { path } = fileStore(t);
  const store = new Store(path);
  const bodies = ledgerBodies(40, 300);
  addHistory(store, bodies);
  try {
    // Mixed: one older version stored in full beside the reverse deltas (a row an older
    // build or a repair left behind), and one snapshot reachable from a deeper delta.
    const version = 20;
    const body = store.leadVersion('ledger', version).body;
    const metadata = store.db.prepare('SELECT data FROM lead_version_deltas WHERE leadId=? AND version=?').get('ledger', version) as { data: string };
    store.db.prepare('DELETE FROM lead_version_deltas WHERE leadId=? AND version=?').run('ledger', version);
    store.db.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)')
      .run('ledger', version, JSON.stringify({ ...JSON.parse(String(metadata.data)), body }));
    assert.equal(store.leadVersion('ledger', version).body, body, 'a full legacy row beside deltas is readable');
    assert.equal(store.leadVersion('ledger', version - 1).body, bodies[version - 2]);
    assert.equal(store.leadVersion('ledger', 19).body, bodies[18]);

    // The mixed store still serves every version byte for byte with its recorded digest.
    assert.deepEqual(store.leadVersions('ledger').map(entry => entry.body), bodies);
  } finally { store.close(); }

  // A current store may retain every version in full, and must still read it.
  const legacyFile = fileStore(t, 'ns-planning-legacy-');
  const legacy = new Store(legacyFile.path);
  const legacyBodies = ledgerBodies(40, 200);
  legacy.close();
  const raw = new DatabaseSync(legacyFile.path);
  raw.exec('BEGIN');
  raw.prepare('INSERT INTO leads(id,state,content_key,data) VALUES(?,?,?,?)').run('ledger', 'open', null,
    JSON.stringify({ id: 'ledger', title: 'Ledger', body: legacyBodies.at(-1), repositories: [alpha], lanes: [], author: 'owner', state: 'open',
      version: legacyBodies.length, dropReason: null, targets: [], source: null, createdAt: STAMP, updatedAt: STAMP, closedAt: null }));
  const insert = raw.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)');
  legacyBodies.forEach((body, index) => insert.run('ledger', index + 1, JSON.stringify({ version: index + 1, title: 'Ledger', body,
    author: 'owner', createdAt: STAMP, check: null, approval: null })));
  raw.exec('COMMIT');
  raw.close();
  const migrated = new Store(legacyFile.path);
  try {
    assert.equal(migrated.getMeta('schema'), CURRENT_SCHEMA);
    assert.deepEqual(migrated.leadVersions('ledger').map(entry => entry.body), legacyBodies);
    assert.equal(Number((migrated.db.prepare('SELECT COUNT(*) AS n FROM lead_version_deltas').get() as { n: number }).n), 0);
  } finally { migrated.close(); }


});

test('B1 a corrupt, truncated, missing-base or unsupported delta refuses the read instead of serving other bytes, cache included', (t) => {
  const { path } = fileStore(t);
  const store = new Store(path);
  try {
    const bodies = ledgerBodies(40, 100);
    addHistory(store, bodies);
    const expectRefusal = (version: number, pattern: RegExp, label: string) => {
      clearCache(store);
      assert.throws(() => store.leadVersion('ledger', version), pattern, label);
    };
    // Truncated delta.
    store.db.prepare('UPDATE lead_version_deltas SET delta=? WHERE leadId=? AND version=?').run('{"format":"queue.reverse-lines"', 'ledger', 30);
    expectRefusal(30, /not readable JSON; the stored history is truncated or corrupt/, 'a truncated delta refuses');
    store.db.prepare('DELETE FROM lead_version_deltas WHERE leadId=? AND version=?').run('ledger', 30);
    store.db.prepare('INSERT INTO lead_version_deltas(leadId,version,baseVersion,bodyDigest,data,delta) VALUES(?,?,?,?,?,?)').run('ledger', 30, 31,
      historyDigest(bodies[29]), JSON.stringify({ version: 30, title: 'Ledger', author: 'owner', createdAt: STAMP, check: null, approval: null }),
      JSON.stringify(encodeHistoryDelta(bodies[30], bodies[29], { baseVersion: 31, targetVersion: 30 }, 'repair')));
    assert.equal(store.leadVersion('ledger', 30).body, bodies[29], 'the repaired row reads again');
    // Unsupported format and format version.
    const deltaRow = store.db.prepare('SELECT delta FROM lead_version_deltas WHERE leadId=? AND version=?').get('ledger', 29) as { delta: string };
    store.db.prepare('UPDATE lead_version_deltas SET delta=? WHERE leadId=? AND version=?')
      .run(String(deltaRow.delta).replace(DELTA_FORMAT, 'queue.reverse-lines-v9'), 'ledger', 29);
    expectRefusal(29, /unsupported reverse delta format/, 'an unknown format refuses by name');
    store.db.prepare('UPDATE lead_version_deltas SET delta=? WHERE leadId=? AND version=?')
      .run(String(deltaRow.delta).replace('"formatVersion":1', '"formatVersion":9'), 'ledger', 29);
    expectRefusal(29, /unsupported reverse delta format version/, 'an unknown format version refuses by name');
    store.db.prepare('UPDATE lead_version_deltas SET delta=? WHERE leadId=? AND version=?').run(deltaRow.delta, 'ledger', 29);
    assert.equal(store.leadVersion('ledger', 29).body, bodies[28], 'the restored delta reads again');
    // A corrupt target digest, then a corrupt base snapshot.
    store.db.prepare('UPDATE lead_version_deltas SET bodyDigest=? WHERE leadId=? AND version=?').run(historyDigest('different bytes'), 'ledger', 28);
    expectRefusal(28, /rebuilt bytes do not match the stored digest/, 'a digest mismatch refuses');
    store.db.prepare('UPDATE lead_version_deltas SET bodyDigest=? WHERE leadId=? AND version=?').run(historyDigest(bodies[27]), 'ledger', 28);
    store.db.prepare('UPDATE lead_versions SET data=? WHERE leadId=? AND version=?')
      .run(JSON.stringify({ version: 32, title: 'Ledger', body: `${bodies[31]} corrupted`, author: 'owner', createdAt: STAMP, check: null, approval: null }), 'ledger', 32);
    expectRefusal(31, /does not match the delta's recorded base digest/, 'a corrupt snapshot refuses');
    store.db.prepare('UPDATE lead_versions SET data=? WHERE leadId=? AND version=?')
      .run(JSON.stringify({ version: 32, title: 'Ledger', body: bodies[31], author: 'owner', createdAt: STAMP, check: null, approval: null }), 'ledger', 32);
    // A missing base version.
    store.db.prepare('DELETE FROM lead_versions WHERE leadId=? AND version=?').run('ledger', 32);
    expectRefusal(31, /missing its base version 32/, 'a missing base refuses');
    store.db.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)')
      .run('ledger', 32, JSON.stringify({ version: 32, title: 'Ledger', body: bodies[31], author: 'owner', createdAt: STAMP, check: null, approval: null }));
    assert.equal(store.leadVersion('ledger', 31).body, bodies[30], 'the restored snapshot reads again');
    // The cached path still checks the digest: warm the cache, corrupt the stored digest, read again.
    assert.equal(store.leadVersion('ledger', 20).body, bodies[19]);
    assert.equal(store.leadVersion('ledger', 20).body, bodies[19], 'the second read is served from the cache');
    store.db.prepare('UPDATE lead_version_deltas SET bodyDigest=? WHERE leadId=? AND version=?').run(historyDigest('elsewhere'), 'ledger', 20);
    assert.throws(() => store.leadVersion('ledger', 20), /rebuilt bytes do not match the stored digest/, 'a cache hit re-checks the digest');
  } finally { store.close(); }
});

test('B1 lead.version, lead.get, lead.approve, promotion and lane.document versions use the reconstructed original bytes', async (t) => {
  const { dir, path } = fileStore(t);
  const store = new Store(path);
  const bodies = ['---\ntitle: Ledger\n---\n\nfirst\n', '---\ntitle: Ledger\n---\n\nsecond\n', '---\ntitle: Ledger\n---\n\nthird ✓\n'];
  const leads = new Leads(store);
  let lead = leads.add({ repositories: [alpha], title: 'Ledger', body: bodies[0], lanes: [], author: 'planner' });
  lead = leads.edit({ id: lead.id, version: 1, body: bodies[1], author: 'planner' });
  lead = leads.edit({ id: lead.id, version: 2, body: bodies[2], author: 'planner' });
  store.upsertLane({ key: 'alpha', title: 'Alpha', aim: 'Aim', repositories: [alpha] });
  let laneVersion = 0;
  for (const text of ['lane v1', 'lane v2', 'lane v3']) laneVersion = store.editLaneDocument({ key: 'alpha', version: laneVersion, text, author: 'operator' }).version;
  store.recordLeadCheck(lead.id, lead.version, { ok: true, message: 'Ready', checkedAt: STAMP, planningCommit: HEAD, baseBranch: 'main' });
  store.close();

  const { QueueRuntime } = await import('../service/runtime-owner');
  const { callCatalogueMethod } = await import('../service/transport/dispatch');
  const runtime = new QueueRuntime({ dataDir: dir, timers: false });
  try {
    await runtime.started;
    const read = await callCatalogueMethod(runtime, 'lead.get', { id: lead.id }) as { versions: Array<{ version: number; body?: string }> };
    assert.deepEqual(read.versions.map(entry => entry.body), [undefined, undefined, bodies[2]], 'only the current body crosses the summary read');
    for (let version = 1; version <= 3; version++)
      assert.equal((await callCatalogueMethod(runtime, 'lead.version', { id: lead.id, version }) as { body: string }).body, bodies[version - 1]);
    const approved = await callCatalogueMethod(runtime, 'lead.approve', { id: lead.id, version: lead.version,
      digest: briefDigest(lead.body), approver: 'operator (board)', note: '', relayed: false }) as { approval: { digest: string } };
    assert.equal(approved.approval.digest, briefDigest(bodies.at(-1)!), 'approval compares the original bytes');
    assert.equal(runtime.store.leadVersion(lead.id, 3).approval?.digest, briefDigest(bodies[2]), 'the approval stays attached to the version it approved');
    assert.equal(runtime.store.leadVersion(lead.id, 1).body, bodies[0]);
    await assert.rejects(() => callCatalogueMethod(runtime, 'lead.version', { id: lead.id, version: 99 }), /Lead version 99 not found/);
  } finally { await runtime.stop?.(); }

  // Promotion admits the exact reconstructed bytes and keeps them on the task.
  const fresh = new Store(path);
  try {
    const stored = fresh.lead(lead.id);
    const submission = submissionSchema.parse({ submissionId: randomUUID(), title: 'Promoted', repoPath: alpha.path, planningCommit: HEAD,
      originAgentId: 'origin', baseBranch: 'main', brief: { text: bodies[2], mediaType: 'text/markdown' },
      leadProvenance: { version: 3, approval: stored.approval, earlierDigests: fresh.leadVersionDigestsBeforeLatest(lead.id) },
      planningSource: { kind: 'lead', id: lead.id } });
    const promoted = fresh.promoteSource({ kind: 'lead', id: lead.id }, alpha.origin, stored.approval!.digest,
      digest(JSON.stringify(stored)), submission, 'host', 'b'.repeat(40), alpha.origin);
    const task = fresh.task('id' in promoted ? promoted.id : promoted.taskId!);
    assert.equal(task.brief!.text, fresh.leadVersion(lead.id, 3).body, 'the promoted brief is the reconstructed version byte for byte');
    assert.equal(task.brief!.text, bodies[2]);
    assert.equal(fresh.leadVersionDigestsBeforeLatest(lead.id).length, 2, 'the digests before the latest are read from both storage forms');
    for (const [version, text] of [[1, 'lane v1'], [2, 'lane v2'], [3, 'lane v3']] as const)
      assert.equal(fresh.laneDocument('alpha', version)!.text, text, `lane document version ${version} is exact`);
  } finally { fresh.close(); }
});

test('B1 benchmark: stored bytes and bounded reconstruction, parent lane beside the new one', (t) => {
  const bodies = ledgerBodies();
  const { path } = fileStore(t, 'ns-planning-bench-');
  const readings: Record<string, unknown> = {};

  /** The pre-change storage: every version full in lead_versions. */
  const parentPath = fileStore(t, 'ns-planning-bench-parent-').path;
  const parent = new Store(parentPath);
  const parentStart = performance.now();
  parent.transaction(() => {
    parent.db.prepare('INSERT INTO leads(id,state,content_key,data) VALUES(?,?,?,?)').run('ledger', 'open', null,
      JSON.stringify({ id: 'ledger', title: 'Ledger', body: bodies.at(-1), repositories: [alpha], lanes: [], author: 'owner', state: 'open',
        version: VERSIONS, dropReason: null, targets: [], source: null, createdAt: STAMP,
        updatedAt: new Date(Date.parse(STAMP) + (VERSIONS - 1) * 1_000).toISOString(), closedAt: null }));
    const insert = parent.db.prepare('INSERT INTO lead_versions(leadId,version,data) VALUES(?,?,?)');
    bodies.forEach((body, index) => insert.run('ledger', index + 1, JSON.stringify({ version: index + 1, title: 'Ledger', body, author: 'owner',
      createdAt: new Date(Date.parse(STAMP) + index * 1_000).toISOString(), check: null, approval: null })));
  });
  readings.parentWriteMs = round(performance.now() - parentStart);
  readings.parentStoredBytes = historyBytes(parent.db);

  const child = new Store(path);
  const childStart = performance.now();
  addHistory(child, bodies);
  readings.childWriteMs = round(performance.now() - childStart);
  readings.childStoredBytes = historyBytes(child.db);
  readings.ratio = round(readings.parentStoredBytes as number / Math.max(1, readings.childStoredBytes as number));
  readings.snapshotRows = Number((child.db.prepare('SELECT COUNT(*) AS n FROM lead_versions WHERE leadId=?').get('ledger') as { n: number }).n);
  readings.deltaRows = Number((child.db.prepare('SELECT COUNT(*) AS n FROM lead_version_deltas WHERE leadId=?').get('ledger') as { n: number }).n);

  // A public read of an old version with the reconstruction cache cleared: one bounded
  // rebuild plus the store's own history read, digest checks, JSON and schema work.
  const publicReads: number[] = [];
  const probes = Array.from({ length: 25 }, (_, index) => 1 + ((index * 37) % (VERSIONS - 1)));
  for (const version of probes) {
    clearCache(child);
    const start = performance.now();
    assert.equal(child.leadVersion('ledger', version).body, bodies[version - 1]);
    publicReads.push(performance.now() - start);
  }
  readings.publicReadMs = { median: round(median(publicReads)), max: round(Math.max(...publicReads)), samples: publicReads.length };
  readings.reconstructionBound = { snapshotInterval: SNAPSHOT_INTERVAL, maxDeltasPerRebuild: MAX_DELTA_CHAIN };

  // Isolate the rebuild itself from the public read's JSON and schema work.
  const cache = new HistoryBodyCache();
  const history = new PlanningHistory(readStoredHistory(child.db, 'lead', 'ledger'), 'Lead ledger');
  const coldBody: number[] = [], warmBody: number[] = [];
  for (const version of probes) {
    cache.clear();
    const start = performance.now();
    assert.equal(history.body(version, cache), bodies[version - 1]);
    coldBody.push(performance.now() - start);
  }
  // Fill the bounded cache with every probe first, so the second loop measures hits.
  for (const version of probes) history.body(version, cache);
  for (const version of probes) {
    const start = performance.now();
    assert.equal(history.body(version, cache), bodies[version - 1]);
    warmBody.push(performance.now() - start);
  }
  readings.rebuildOnlyMs = { coldMedian: round(median(coldBody)), warmMedian: round(median(warmBody)),
    coldMax: round(Math.max(...coldBody)), warmMax: round(Math.max(...warmBody)) };
  readings.cacheStats = { entries: cache.size, storedBytes: cache.storedBytes, maxEntries: 64, maxBytes: 8 * 1024 * 1024 };

  // Both storage forms rebuild the same full versions and recorded digests.
  const parentVersions = parent.leadVersions('ledger'), childVersions = child.leadVersions('ledger');
  assert.deepEqual(childVersions.map(entry => entry.body), parentVersions.map(entry => entry.body), 'both storage forms rebuild the same full versions');
  assert.deepEqual(childVersions.map(entry => entry.digest), parentVersions.map(entry => entry.digest), 'and the same recorded digests');

  readings.population = { versions: VERSIONS, finalBodyBytes: Buffer.byteLength(bodies.at(-1)!), leads: 1 };
  readings.environment = { node: process.version, cpu: cpus()[0]?.model, cpus: cpus().length, totalMemGiB: Math.round(totalmem() / 1024 ** 3), loadavg: loadavg().map(round) };
  readings.cache = 'cold = HistoryBodyCache cleared before each read; warm = the same read again from the bounded cache, digest re-checked';
  child.close();
  parent.close();
  console.log(`BENCH ${JSON.stringify(readings)}`);
  // The falsification guard: the new storage must be materially smaller and rebuild exactly.
  assert.ok((readings.childStoredBytes as number) < (readings.parentStoredBytes as number) / 5, 'the delta store is materially smaller');
});

/** Bytes the two planning-history tables hold for the fixture, exactly as SQLite stores them. */
function historyBytes(db: DatabaseSync): number {
  const full = db.prepare('SELECT SUM(length(data)) AS bytes FROM lead_versions').get() as { bytes: number | null };
  const delta = db.prepare('SELECT SUM(length(data) + length(delta) + length(bodyDigest)) AS bytes FROM lead_version_deltas').get() as { bytes: number | null };
  return Number(full.bytes ?? 0) + Number(delta.bytes ?? 0);
}
