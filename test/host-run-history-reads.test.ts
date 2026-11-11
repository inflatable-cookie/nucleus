/**
 * Audit A7/A8 (2026-10-25 performance audit, main at d5e20937): `store.hostRuns(10_000)`
 * parsed every one of 1,393 host-run rows on every pump, every 30 s maintenance pass,
 * every `ProjectQa.list` and every submit's history samples, and the board called it
 * twice per refresh (once for the pinned list, once for the retirement join).
 *
 * This fixture builds the audit's population in an isolated in-memory store and compares
 * the parent shapes — implemented here beside the new reads, so the comparison never
 * depends on another commit — against the SQL candidates this task uses:
 *
 * - served fairness, selector history, escaped-descendant re-attachment and the retention
 *   sweep all read what they need instead of parsing every row;
 * - the empty pump reads no history at all;
 * - the retention sweep walks bounded pages behind a restart-safe cursor, and a row that
 *   settles after the cursor passed its rowid is still reached when the cursor wraps;
 * - the combined board read returns exactly the pinned list and the same id+epoch
 *   retirement join from one list call, including the conservative unreadable answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableParallelism, cpus, loadavg, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../core/store/store';
import { HostRunScheduler } from '../core/host-runs/host-run-scheduler';
import { hostRunAccountingDispositionMetaKey } from '../core/host-runs/host-run-meta-keys';
import { hostRunAccountingAuthority, hostRunAccountingDispositionRecord } from '../core/host-runs/host-run-accounting';
import { hostRunPublicDigest } from '../core/host-runs/host-run-accounting';
import { OPERATOR_BOARD_CALLER, hostRunRecordSchema, hostRunSettlementSchema, type HostRunInternalRecord } from '../shared/contracts';

const HEAD = 'a'.repeat(40);
const STAMP = '2026-10-25T00:00:00.000Z';
const ROWS = 1_393;

const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
const timed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
const repoKey = (repository: { origin: string | null; path: string }) => repository.origin ?? repository.path;

const repositoryA = { origin: 'owner/a', path: '/repos/a' };
const repositoryB = { origin: 'owner/b', path: '/repos/b' };

function settledRow(index: number, overrides: Partial<HostRunInternalRecord> = {}): HostRunInternalRecord {
  const repository = index % 11 === 0 ? repositoryB : repositoryA;
  const selector = index % 7 === 0 ? 'qa:other' : 'qa';
  const launchedAt = new Date(Date.parse(STAMP) + index * 1_000).toISOString();
  const settledAt = new Date(Date.parse(launchedAt) + 60_000).toISOString();
  const id = `settled-${index}`;
  return hostRunRecordSchema.parse({
    id, epoch: 1, caller: `test:${id}`, repository, selector, runClass: 'heavy', classSource: 'default',
    priority: 'milestone', state: 'settled', submittedAt: launchedAt, capacityDeadlineAt: settledAt, runTimeoutMs: 600_000,
    budgetFallback: { cpu: 1, memoryBytes: 1_000 }, budget: { cpu: 1, memoryBytes: 1_000, wallMs: 60_000, source: 'history' },
    position: null, admittedAt: launchedAt, launchedAt, settledAt, capacitySample: null, pid: 8_000 + index,
    processGroupId: 8_000 + index, startIdentity: `${8_000 + index}@identity`,
    settlement: hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: id, outcome: 'passed',
      launched: true, settledAt, containers: [], result: { format: 'host.run.result', version: 1, runId: id, epoch: 1,
        pgid: 8_000 + index, startIdentity: `${8_000 + index}@identity`, exitCode: 0, signal: null, startedAt: launchedAt,
        endedAt: settledAt, wallMs: 60_000, cpuMs: 1_000 + index, escapedDescendants: [] } }),
    wallMs: 60_000, cpuMs: 1_000 + index, containers: [], capacityReleasedAt: settledAt, capacityReleaseReason: 'settled',
    capacityReleaseKind: 'automatic', ...overrides,
  });
}

function chargedRow(index: number, overrides: Partial<HostRunInternalRecord> = {}): HostRunInternalRecord {
  const id = `charged-${index}`;
  const at = new Date(Date.parse(STAMP) + index * 1_000).toISOString();
  return hostRunRecordSchema.parse({
    ...settledRow(index), id, caller: `test:${id}`, state: 'running', submittedAt: at, capacityDeadlineAt: at,
    launchedAt: at, settledAt: null, settlement: null, wallMs: null, cpuMs: null, capacityReleasedAt: null,
    capacityReleaseReason: null, capacityReleaseKind: null, ...overrides,
  });
}

/** One escaped-descendant row still holding capacity, which the QA list must re-attach. */
function escapedHeldRow(): HostRunInternalRecord {
  const base = settledRow(0, { state: 'settled', capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null });
  const settlement = hostRunSettlementSchema.parse({ ...base.settlement!, result: { ...base.settlement!.result!,
    escapedDescendants: [{ pid: 9_001, startIdentity: '9001@identity' }] } });
  return hostRunRecordSchema.parse({ ...base, id: 'escaped-held', caller: 'test:escaped-held', settlement });
}

function auditShapedStore() {
  const store = new Store(':memory:');
  const insert = store.db.prepare('INSERT OR REPLACE INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)');
  const write = (record: HostRunInternalRecord) => insert.run(record.id, record.repository.origin ?? record.repository.path, record.state, JSON.stringify(record));
  store.transaction(() => {
    for (let index = 0; index < ROWS; index++) write(settledRow(index));
    write(escapedHeldRow());
    write(chargedRow(1));
    write(chargedRow(2));
    write(chargedRow(3, { state: 'queued', admittedAt: null, launchedAt: null, settledAt: null, settlement: null, wallMs: null,
      cpuMs: null, pid: null, processGroupId: null, startIdentity: null, capacityDeadlineAt: '2027-01-01T00:00:00.000Z' }));
    write(settledRow(9_000, { id: 'held-container', capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null }));
    // One readable retirement, one unreadable record and one bound to another epoch.
    const disposition = (record: HostRunInternalRecord) => hostRunAccountingDispositionRecord(record, {
      runId: record.id, operationId: `op-${record.id}`, expectedEpoch: record.epoch,
      expectedRunDigest: hostRunPublicDigest(record), authority: { caller: OPERATOR_BOARD_CALLER }, 
      acceptance: { scope: 'exact_run', runId: record.id, epoch: record.epoch, unknownOutcomeRetained: true,
        reason: 'Operator accepted the unknown outcome' },
      reason: 'Operator retired the accounting; outcome and custody stay unknown',
    }, hostRunAccountingAuthority({ caller: OPERATOR_BOARD_CALLER }), STAMP);
    store.setMeta(hostRunAccountingDispositionMetaKey('charged-1'), disposition(store.hostRun('charged-1')!));
    store.setMeta(hostRunAccountingDispositionMetaKey('charged-2'), { format: 'queue.host-run.accounting-disposition', runId: 'charged-2' });
    store.setMeta(hostRunAccountingDispositionMetaKey('charged-3'), disposition({ ...store.hostRun('charged-3')!, epoch: 2 }));
  });
  return store;
}

/** The parent served-fairness shape: parse every row for one maximum per repository. */
function parentServed(store: Store): Map<string, number> {
  const served = new Map<string, number>();
  for (const run of store.hostRuns(10_000)) if (run.launchedAt) served.set(repoKey(run.repository), Math.max(served.get(repoKey(run.repository)) ?? 0, Date.parse(run.launchedAt)));
  return served;
}
function newServed(store: Store): Map<string, number> {
  const served = new Map<string, number>();
  for (const row of store.hostRunServedLaunches()) {
    const key = row.origin ?? row.path;
    if (!key) continue;
    const at = Date.parse(row.launchedAt);
    if (!Number.isFinite(at)) continue;
    served.set(key, Math.max(served.get(key) ?? 0, at));
  }
  return served;
}
/** The parent history shape: every row parsed, then filtered by repository and selector. */
function parentSamples(store: Store, keys: string[], selector: string): string[] {
  const wanted = new Set(keys.map(key => key.toLowerCase()));
  return store.hostRuns(10_000).filter(run => [run.repository.origin, run.repository.path].some(value => value && wanted.has(value.toLowerCase()))
    && run.selector === selector).map(run => run.id).sort();
}
/** The parent QA re-attachment shape: filter the full board list. */
function parentEscaped(store: Store): string[] {
  return new HostRunScheduler(store).list(10_000)
    .filter(run => run.state === 'settled' && !run.capacityReleasedAt && run.settlement?.result?.escapedDescendants.length && !run.escapedDescendantsProvenDeadAt)
    .map(run => run.id);
}

test('audit-shaped history: served fairness, selector samples and QA candidates match the parent shapes', t => {
  const store = auditShapedStore();
  t.after(() => store.close());
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM host_run_records').get()!.count, ROWS + 5);

  assert.deepEqual([...newServed(store).entries()].sort(), [...parentServed(store).entries()].sort(),
    'the grouped served launches are the parent maximum per repository');
  assert.deepEqual(store.hostRunSelectorSamples([...['owner/a', '/repos/a']], 'qa').map(run => run.id).sort(),
    parentSamples(store, ['owner/a', '/repos/a'], 'qa'), 'the SQL selector sample is the parent filter');
  assert.deepEqual(store.hostRunSelectorSamples(['OWNER/B'], 'qa').map(run => run.id).sort(),
    parentSamples(store, ['OWNER/B'], 'qa'), 'repository matching stays case-insensitive');
  assert.deepEqual(store.hostRunSelectorSamples(['owner/a'], 'qa:missing'), [], 'a selector with no history reads none');
  assert.deepEqual(store.hostRunsAwaitingEscapedDescendants().map(run => run.id), parentEscaped(store),
    'the SQL candidates are exactly the rows the parent QA pass re-attached');
  assert.deepEqual(store.hostRunsAwaitingEscapedDescendants().map(run => run.id), ['escaped-held']);
  t.diagnostic(`population: ${ROWS} settled rows, 5 charged/held rows, 2 repositories, 2 selectors`);
});

test('the retention sweep advances in bounded pages behind a restart-safe cursor and reaches late settlements', t => {
  const store = auditShapedStore();
  t.after(() => store.close());
  const settledIds = new Set((store.db.prepare(`SELECT id FROM host_run_records WHERE json_extract(data,'$.settledAt') IS NOT NULL`).all() as Array<{ id: string }>).map(row => row.id));
  const seen = new Map<string, number>();
  let cursor = 0, pages = 0;
  for (;;) {
    const page = store.hostRunSettledSweepPage(cursor, 100);
    pages++;
    assert.ok(page.rows.length <= 100, 'a page never exceeds its bound');
    for (const run of page.rows) seen.set(run.id, (seen.get(run.id) ?? 0) + 1);
    cursor = page.complete ? 0 : page.lastRowid;
    if (page.complete) break;
  }
  assert.ok(pages > 1, 'the table is walked in more than one page');
  assert.deepEqual([...seen.keys()].sort(), [...settledIds].sort(), 'every settled row is visited exactly once per cycle');
  assert.equal([...seen.values()].every(count => count === 1), true, 'no row is visited twice');

  // A row that settles after the cursor passed its rowid is reached when the cursor wraps.
  const late = settledRow(0, { id: 'late-settled', state: 'running', settledAt: null, settlement: null,
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null });
  store.db.prepare('INSERT OR REPLACE INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
    .run(late.id, late.repository.origin!, late.state, JSON.stringify(late));
  const early = store.hostRunSettledSweepPage(0, 3);
  assert.equal(early.rows.some(run => run.id === 'late-settled'), false, 'an unsettled row is not swept');
  store.db.prepare('UPDATE host_run_records SET data=?, state=? WHERE id=?')
    .run(JSON.stringify(settledRow(0, { id: 'late-settled' })), 'settled', 'late-settled');
  let reached = false;
  cursor = 0;
  for (;;) {
    const page = store.hostRunSettledSweepPage(cursor, 100);
    if (page.rows.some(run => run.id === 'late-settled')) reached = true;
    cursor = page.complete ? 0 : page.lastRowid;
    if (page.complete) break;
  }
  assert.equal(reached, true, 'the wrapped sweep reaches a row that settled behind the cursor');
  // The cursor is a plain number the endpoint stores; a lost or unreadable value starts a full cycle.
  assert.equal(store.hostRunSettledSweepPage(0, 100).rows.length, 100);
});

test('the empty pump reads no history, and the combined board read is one list call', t => {
  const store = auditShapedStore();
  t.after(() => store.close());
  const scheduler = new HostRunScheduler(store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 1e10, freeMemoryBytes: 1e10, loadAverage: [0, 0, 0] }) });
  const calls: number[] = [];
  const read = store.hostRuns.bind(store);
  (store as unknown as { hostRuns: (limit?: number) => unknown }).hostRuns = (limit?: number) => { calls.push(limit ?? 250); return read(limit); };

  scheduler.tick();
  assert.deepEqual(calls, [], 'an empty pump parses no host-run row at all');

  // A queued run is ordered from the SQL served launches, still without the full-table read.
  scheduler.submit({ id: 'queued-1', epoch: scheduler.authority().epoch, caller: 'test:queued-1', repository: repositoryA,
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 600_000,
    budgetFallback: { cpu: 4, memoryBytes: 1e10 } }, { launch: run => { scheduler.markLaunched(run.id); } });
  assert.deepEqual(calls, [], 'a busy pump reads the grouped launches, not every row');

  // The parent shape is what this removes: one full parse for the same answer.
  const parentBefore = timed(() => parentServed(store));
  assert.ok(parentBefore >= 0);

  calls.length = 0;
  const board = scheduler.boardState();
  assert.equal(calls.length, 1, 'the combined board read runs the list once');
  const list = scheduler.list();
  assert.deepEqual(board.runs.map(run => run.id), list.map(run => run.id), 'the combined read returns exactly the pinned list rows');
  const accounting = scheduler.accountingList();
  assert.deepEqual(board.accounting.entries, accounting.entries, 'the same id+epoch join and the same complete flag');
  assert.equal(board.accounting.complete, accounting.complete);
  assert.deepEqual(board.accounting.entries.map(entry => [entry.runId, entry.accounting]).sort(), [
    ['charged-1', 'retired'], ['charged-2', 'unreadable'], ['charged-3', 'unreadable'],
  ], 'a readable retirement retires, an unreadable or other-epoch record stays charged');
  assert.ok(board.runs.some(run => run.id === 'charged-3' && run.state === 'queued'), 'a charged queued reservation stays listed');
  calls.length = 0;
  scheduler.list(); scheduler.accountingList();
  assert.equal(calls.length, 2, 'the parent pair parses the list twice per board refresh');
  t.diagnostic(`empty pump hostRuns reads: 0; combined board list calls: 1; parent pair list calls: 2`);
});

test('audit A7/A8 medians: targeted history reads against the full-table parent shape', t => {
  const store = auditShapedStore();
  t.after(() => store.close());
  const scheduler = new HostRunScheduler(store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 1e10, freeMemoryBytes: 1e10, loadAverage: [0, 0, 0] }) });
  const keys = ['owner/a', '/repos/a'];
  const parentServedTimes: number[] = [], servedTimes: number[] = [];
  const parentSampleTimes: number[] = [], sampleTimes: number[] = [];
  const parentQaTimes: number[] = [], qaTimes: number[] = [];
  const parentBoardTimes: number[] = [], boardTimes: number[] = [];
  const parentSweepTimes: number[] = [], sweepTimes: number[] = [];
  for (let warm = 0; warm < 2; warm++) {
    parentServed(store); newServed(store); parentSamples(store, keys, 'qa'); store.hostRunSelectorSamples(keys, 'qa');
    parentEscaped(store); store.hostRunsAwaitingEscapedDescendants(); scheduler.list(); scheduler.accountingList(); scheduler.boardState();
    store.hostRunSettledSweepPage(0, 250);
  }
  const runs = 9;
  for (let index = 0; index < runs; index++) {
    parentServedTimes.push(timed(() => parentServed(store)));
    servedTimes.push(timed(() => newServed(store)));
    parentSampleTimes.push(timed(() => parentSamples(store, keys, 'qa')));
    sampleTimes.push(timed(() => store.hostRunSelectorSamples(keys, 'qa')));
    parentQaTimes.push(timed(() => parentEscaped(store)));
    qaTimes.push(timed(() => store.hostRunsAwaitingEscapedDescendants()));
    parentBoardTimes.push(timed(() => { scheduler.list(); scheduler.accountingList(); }));
    boardTimes.push(timed(() => scheduler.boardState()));
    parentSweepTimes.push(timed(() => scheduler.list(10_000)));
    sweepTimes.push(timed(() => store.hostRunSettledSweepPage(0, 250)));
  }
  const summary = { rows: ROWS + 5, runs, served: [median(parentServedTimes), median(servedTimes)],
    samples: [median(parentSampleTimes), median(sampleTimes)], qa: [median(parentQaTimes), median(qaTimes)],
    board: [median(parentBoardTimes), median(boardTimes)], sweepPage: [median(parentSweepTimes), median(sweepTimes)],
    node: process.version, cpu: cpus()[0]?.model ?? 'unknown', cpus: availableParallelism(), totalMemGiB: Math.round(totalmem() / 2 ** 30),
    loadavg: loadavg() };
  t.diagnostic(JSON.stringify(summary));
  // The comparison is the point: each new read is the parent answer by a bounded query.
  for (const [pair, label] of [[summary.served, 'served'], [summary.samples, 'samples'], [summary.qa, 'qa candidates'],
    [summary.board, 'board'], [summary.sweepPage, 'sweep page']] as Array<[number[], string]>)
    assert.ok(pair[1]! >= 0 && pair[0]! >= 0, `${label}: both shapes measured`);
  assert.deepEqual(newServed(store), parentServed(store));
  assert.deepEqual(store.hostRunSelectorSamples(keys, 'qa').map(run => run.id).sort(), parentSamples(store, keys, 'qa'));
  assert.deepEqual(store.hostRunsAwaitingEscapedDescendants().map(run => run.id), parentEscaped(store));
});

test('an undecodable host-run row is stored, skipped by the selector read, and never stops the store opening', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ns-host-run-selector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'queue.sqlite');
  const insertSql = 'INSERT INTO host_run_records(id, repository, state, data) VALUES (?, ?, ?, ?)';
  const indexCount = (store: Store, name: string) =>
    store.db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?').get(name)!.count;
  const selectorPlan = (store: Store) => JSON.stringify(store.db.prepare(`EXPLAIN QUERY PLAN SELECT data FROM host_run_records
    WHERE json_extract(CASE WHEN json_valid(data) THEN data END,'$.selector') = ?`).all('qa'));

  const first = new Store(path);
  const good = settledRow(1);
  first.db.prepare(insertSql).run(good.id, good.repository.origin!, good.state, JSON.stringify(good));
  // Parent shape: the bare json_extract index on a well-formed table.
  first.db.exec(`DROP INDEX IF EXISTS host_run_records_valid_selector;
    CREATE INDEX host_run_records_selector ON host_run_records(json_extract(data,'$.selector'))`);
  assert.equal(indexCount(first, 'host_run_records_selector'), 1);
  assert.equal(indexCount(first, 'host_run_records_valid_selector'), 0);
  assert.throws(() => first.db.prepare(insertSql).run('bad-host', 'owner/a', 'settled', '{'), /malformed JSON/,
    'the parent index aborts an undecodable write');
  assert.equal(first.db.prepare('SELECT COUNT(*) AS count FROM host_run_records').get()!.count, 1);
  first.close();

  // Reopen drops the old index and creates the guarded one. The insert below
  // would still abort if the DROP were removed.
  const upgraded = new Store(path);
  assert.equal(indexCount(upgraded, 'host_run_records_selector'), 0, 'the bare index an older build created is dropped');
  assert.equal(indexCount(upgraded, 'host_run_records_valid_selector'), 1);
  upgraded.db.prepare(insertSql).run('bad-host', 'owner/a', 'settled', '{');
  assert.deepEqual(upgraded.hostRunSelectorSamples(['owner/a'], 'qa').map(run => run.id), [good.id],
    'an undecodable row is no sample');
  assert.match(selectorPlan(upgraded), /host_run_records_valid_selector/, 'the selector read still uses its index');
  assert.equal(upgraded.db.prepare('SELECT data FROM host_run_records WHERE id=?').get('bad-host')!.data, '{');

  // Parent CREATE over the existing undecodable row throws. Drop the guarded
  // index so the next open actually builds it over that row.
  upgraded.db.exec('DROP INDEX host_run_records_valid_selector');
  assert.throws(() => upgraded.db.exec(
    "CREATE INDEX host_run_records_selector ON host_run_records(json_extract(data,'$.selector'))"),
    /malformed JSON/, 'the parent index cannot be built over an undecodable row');
  assert.equal(indexCount(upgraded, 'host_run_records_valid_selector'), 0);
  assert.equal(indexCount(upgraded, 'host_run_records_selector'), 0);
  upgraded.close();

  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(indexCount(reopened, 'host_run_records_valid_selector'), 1,
    'the guarded index is created over an existing undecodable row');
  assert.equal(indexCount(reopened, 'host_run_records_selector'), 0);
  assert.deepEqual(reopened.hostRunSelectorSamples(['owner/a'], 'qa').map(run => run.id), [good.id],
    'the row stays unreadable after reopen');
  assert.equal(reopened.db.prepare('SELECT data FROM host_run_records WHERE id=?').get('bad-host')!.data, '{',
    'the undecodable row is preserved');
  assert.match(selectorPlan(reopened), /host_run_records_valid_selector/, 'the selector read still uses its index after reopen');
  reopened.db.prepare(insertSql).run('bad-host-2', 'owner/a', 'settled', '{still-bad');
  assert.deepEqual(reopened.hostRunSelectorSamples(['owner/a'], 'qa').map(run => run.id), [good.id],
    'further undecodable writes still succeed and stay unreadable');
});
