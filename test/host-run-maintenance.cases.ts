import { observeIdle } from './support/fakes';
/**
 * Audit A7 (2026-10-25 performance audit, main at d5e20937): the endpoint's 30 s
 * maintenance pass read the whole, unbounded host-run table to find output past
 * its retention hour. It walks settled rows in bounded pages behind a durable
 * rowid cursor instead.
 *
 * Task 443 corrects what #435 did with a page that could not retire a row: one
 * expired run whose retained output is absent or unreadable (`d230b0ff`'s empty
 * run directory was the live shape) pinned the whole page forever, so every
 * later eligible run waited behind it. A page now advances past attempted rows,
 * every refusal is recorded durably against its own run with first/last sighting
 * and a bounded retry, later good rows and pages cannot clear it, and only that
 * run's own later success removes it. Absent output is classified honestly: a
 * never-launched run was never written, present-day absence of a launched run's
 * bytes is unknown, and neither invents a byte count or a marker.
 *
 * Task 444 fixes 443's own cap: the failure set lived in one meta value holding
 * at most 100 identities, so the live service reported `100 retained-output
 * failures (+30 more not listed)` and advanced the cursor. Every failure now has
 * its own durable row (epoch, reason, first/last sighting, attempts, next retry),
 * durable before the cursor moves; a health summary is bounded but the stored set
 * is not, and its count is exact. The same task answers the amendment: a launched
 * milestone Project QA run is not a generic host-run stream at all — QA writes
 * its own step logs — so verified ownership from the durable QA record clears
 * the false positive with evidence, while forged, missing, mismatched or
 * unreadable ownership and genuine generic-supervised absence stay failures.
 *
 * This fixture is an isolated state directory and socket in a fresh mktemp; no
 * live database, live state directory or process is read or written.
 */
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA, Store } from '../core/store/store';
import { HostRunScheduler } from '../core/host-runs/host-run-scheduler';
import { QueueRuntime } from '../service/runtime-owner';
import {
  HostRunEndpoint,
  hostRunRunDir,
} from '../service/callbacks/host-run-endpoint';
import {
  HOST_RUN_OUTPUT_RECLASSIFICATIONS_META,
  hostRunOutputReclassificationLogSchema,
  type HostRunOutputFailure,
} from '../core/host-runs/host-run-output-failures';
import { classifyRetainedOutputOwnership } from '../core/host-runs/host-run-output-ownership';
import { qaCallerIdentity } from '../core/qa/qa-caller';
import { hostRunRecordSchema, hostRunSettlementSchema, projectQaRunSchema, type HostRunInternalRecord, type ProjectQaRun } from '../shared/contracts';
import type { Adapter } from '../core/host';

const STAMP = '2026-10-25T00:00:00.000Z';
const CURSOR_META = 'hostRunOutputSweepCursor';
const ERROR_META = 'hostRunOutputSweepError';
const RETIRED = 3_600_000;
/** The sweep's own retry base: a failed row is not due again before this. */
const RETRY_BASE = 60_000;

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/**
 * Remove one fixture's state directory. A stopping endpoint can still be
 * finishing a socket/authority write, so the recursive remove retries instead of
 * turning a fixture race into a failed test.
 */
const removeTree = (path: string): void => {
  // This fixture's scratch volume is shared with the Finder, which can drop a
  // `.DS_Store` into a directory while the recursive walk is running; `rmSync`'s
  // own retry covers a busy call, not a directory that a file appeared in again,
  // so the whole disposable removal is retried. Once the retries are spent the
  // fixture is left behind: this directory is Effigy's own scratch and a passing
  // product assertion must not fail on Finder metadata.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
    }
  }
};
async function waitUntil(probe: () => boolean, ms: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) { if (probe()) return; await pause(10); }
  throw new Error(`timed out waiting for ${label}`);
}

function settledRun(id: string, submittedAt = STAMP): HostRunInternalRecord {
  const launchedAt = submittedAt, settledAt = new Date(Date.parse(submittedAt) + 60_000).toISOString();
  return hostRunRecordSchema.parse({
    id, epoch: 1, caller: `test:${id}`, repository: { origin: 'owner/audit', path: '/audit' }, selector: 'qa',
    runClass: 'heavy', classSource: 'default', priority: 'milestone', state: 'settled', submittedAt: launchedAt,
    capacityDeadlineAt: settledAt, runTimeoutMs: 600_000, budgetFallback: { cpu: 1, memoryBytes: 1_000 },
    budget: { cpu: 1, memoryBytes: 1_000, wallMs: 60_000, source: 'history' }, position: null, admittedAt: launchedAt,
    launchedAt, settledAt, capacitySample: null, pid: 8_100, processGroupId: 8_100, startIdentity: '8100@identity',
    settlement: hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: id, outcome: 'passed', launched: true,
      settledAt, containers: [], result: { format: 'host.run.result', version: 1, runId: id, epoch: 1, pgid: 8_100,
        startIdentity: '8100@identity', exitCode: 0, signal: null, startedAt: launchedAt, endedAt: settledAt,
        wallMs: 60_000, cpuMs: 1_000, escapedDescendants: [] } }),
    wallMs: 60_000, cpuMs: 1_000, containers: [], capacityReleasedAt: settledAt, capacityReleaseReason: 'settled',
    capacityReleaseKind: 'automatic',
  });
}

/** A settled run that never launched: no launch record, so no supervisor wrote output. */
function neverLaunchedSettledRun(id: string): HostRunInternalRecord {
  const record = settledRun(id);
  return hostRunRecordSchema.parse({
    ...record, launchedAt: null, pid: null, processGroupId: null, startIdentity: null,
    settlement: hostRunSettlementSchema.parse({
      format: 'host.run.settlement', version: 1, runId: id, outcome: 'cancelled', launched: false,
      settledAt: record.settledAt, result: null, containers: [],
    }),
  });
}

/** A launched run that settled lost, optionally with a process Queue recorded before the loss. */
function lostRun(id: string, options: { process?: boolean } = {}): HostRunInternalRecord {
  const record = settledRun(id);
  return hostRunRecordSchema.parse({
    ...record, wallMs: null, cpuMs: null,
    ...(options.process ? {} : { pid: null, processGroupId: null, startIdentity: null }),
    settlement: hostRunSettlementSchema.parse({
      format: 'host.run.settlement', version: 1, runId: id, outcome: 'lost', launched: true,
      settledAt: record.settledAt, result: null, containers: [],
    }),
  });
}

/** A settled milestone QA host run: the canonical caller and the run's own repository. */
function qaSettledRun(id: string, options: { key?: string; origin?: string; path?: string; epoch?: number; caller?: string } = {}): HostRunInternalRecord {
  const record = settledRun(id);
  const key = options.key ?? 'owner/audit';
  return hostRunRecordSchema.parse({
    ...record, epoch: options.epoch ?? record.epoch,
    caller: options.caller ?? qaCallerIdentity(key, id),
    repository: { origin: options.origin ?? record.repository.origin, path: options.path ?? record.repository.path },
  });
}

/** The durable Project QA row that names one host run: same id, key, repository and epoch. */
function qaRecord(id: string, options: { key?: string; origin?: string; path?: string; epoch?: number | null } = {}): ProjectQaRun {
  const key = options.key ?? 'owner/audit';
  const logRoot = `/qa-logs/${id}`;
  return projectQaRunSchema.parse({
    id, key, repository: { origin: options.origin ?? 'owner/audit', path: options.path ?? '/audit' },
    state: 'passed', baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'], digest: 'b'.repeat(64),
    exitCode: 0, durationMs: 1_000, outputTail: '', startedAt: STAMP,
    finishedAt: new Date(Date.parse(STAMP) + 1_000).toISOString(), pid: null,
    capacityWait: null, capacityUnavailable: false,
    ...(options.epoch === null ? {} : { hostRunEpoch: options.epoch ?? 1 }),
    steps: [{
      name: 'qa', command: 'effigy qa', exitCode: 0, signal: null, timedOut: false,
      stdoutHead: 'ok\n', stdoutTail: 'ok\n', stderrHead: '', stderrTail: '',
      stdoutLogPath: `${logRoot}/qa.stdout.log`, stderrLogPath: `${logRoot}/qa.stderr.log`,
      stdoutBytes: 3, stderrBytes: 0,
    }],
  });
}

function writeRun(store: Store, record: HostRunInternalRecord): void {
  store.db.prepare('INSERT OR REPLACE INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
    .run(record.id, record.repository.origin ?? record.repository.path, record.state, JSON.stringify(record));
}

/** Retained output the endpoint could have written: run directories owned by this uid. */
function writeOutput(stateDir: string, runId: string, stdout: string, stderr: string): string[] {
  const root = hostRunRunDir(stateDir, runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, 'runs'), 0o700);
  chmodSync(root, 0o700);
  writeFileSync(join(root, 'stdout'), stdout, { mode: 0o600 });
  writeFileSync(join(root, 'stderr'), stderr, { mode: 0o600 });
  return [join(root, 'stdout'), join(root, 'stderr')];
}

/** The d230b0ff shape: a launched, settled run whose run directory holds no stream. */
function emptyRunDirectory(stateDir: string, runId: string): string {
  const root = hostRunRunDir(stateDir, runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, 'runs'), 0o700);
  chmodSync(root, 0o700);
  return root;
}

function retentionMarker(stateDir: string, runId: string): { runId: string; sizes: { stdout: number; stderr: number } } | null {
  const path = join(hostRunRunDir(stateDir, runId), 'output.retention.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The durable failure rows, read exactly as the endpoint wrote them. */
function failures(store: Store, limit = 1_000): HostRunOutputFailure[] {
  return store.hostRunOutputFailures(limit);
}

function failureOf(store: Store, runId: string): HostRunOutputFailure | undefined {
  return store.hostRunOutputFailure(runId) ?? undefined;
}

/** Every recorded reclassification, read as the durable log the service writes. */
function reclassifications(store: Store): ReturnType<typeof hostRunOutputReclassificationLogSchema.parse> | null {
  const stored = store.getMeta<unknown>(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META);
  return stored === undefined ? null : hostRunOutputReclassificationLogSchema.parse(stored);
}

/**
 * #435's rule, kept here as the falsification beside the new one: any failed row
 * on the page pinned the cursor on that page, so the first absent row blocked
 * every later one. The sweep under test no longer uses this.
 */
function legacyPinnedCursor(previous: number, page: { lastRowid: number; complete: boolean }, pageFailed: boolean): number {
  return pageFailed ? previous : page.complete ? 0 : page.lastRowid;
}

/**
 * The parent's own 443 rule, kept verbatim as the falsification of the overflow
 * loss: sort the failures, keep the first 100, drop the rest, and report success
 * with the dropped count only as summary wording.
 */
function legacyStoredFailureSet(set: readonly HostRunOutputFailure[]): { kept: HostRunOutputFailure[]; omitted: number; ok: true } {
  const ordered = [...set].sort((left, right) => left.firstSeen.localeCompare(right.firstSeen) || left.runId.localeCompare(right.runId));
  const kept = ordered.slice(0, 100);
  return { kept, omitted: ordered.length - kept.length, ok: true };
}

interface Fixture { stateDir: string; store: Store; endpoint: HostRunEndpoint; clock: { now: number } }

async function harness(t: { after(fn: () => void | Promise<void>): void }, options: { intervalMs?: number } = {}): Promise<Fixture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'hrm-'));
  const store = new Store(':memory:');
  const scheduler = new HostRunScheduler(store, { capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8e9, freeMemoryBytes: 8e9, loadAverage: [0, 0, 0] }) });
  const clock = { now: Date.parse(STAMP) + RETIRED };
  const endpoint = new HostRunEndpoint(scheduler, { stateDir, env: process.env, outputRetentionMs: 0,
    now: () => clock.now, ...(options.intervalMs === undefined ? {} : { maintenanceIntervalMs: options.intervalMs }) });
  t.after(async () => { await endpoint.stop(); store.close(); removeTree(stateDir); });
  await endpoint.start();
  return { stateDir, store, endpoint, clock };
}

/** A file-backed fixture that can be stopped and reopened on the same database. */
async function fileHarness(t: { after(fn: () => void | Promise<void>): void }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'hrm-file-'));
  const dbPath = join(stateDir, 'queue.db');
  const clock = { now: Date.parse(STAMP) + RETIRED };
  let store: Store | null = null;
  let endpoint: HostRunEndpoint | null = null;
  const open = async () => {
    store = new Store(dbPath);
    const scheduler = new HostRunScheduler(store, { capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 8e9, freeMemoryBytes: 8e9, loadAverage: [0, 0, 0] }) });
    endpoint = new HostRunEndpoint(scheduler, { stateDir, env: process.env, outputRetentionMs: 0, now: () => clock.now });
    await endpoint.start();
    return { store, endpoint };
  };
  const close = async () => { await endpoint?.stop(); endpoint = null; store?.close(); store = null; };
  t.after(async () => { await close(); removeTree(stateDir); });
  return {
    stateDir, dbPath, clock, open, close,
    get store() { return store!; },
    get endpoint() { return endpoint!; },
  };
}

test('the maintenance timer retires expired output and a refused run stays visible on its own', async t => {
  const f = await harness(t, { intervalMs: 10 });
  writeRun(f.store, settledRun('expired-1'));
  const files = writeOutput(f.stateDir, 'expired-1', 'one\n', 'two\n');
  await waitUntil(() => retentionMarker(f.stateDir, 'expired-1') !== null, 5_000, 'the maintenance pass to retire expired output');
  assert.deepEqual(files.map(file => existsSync(file)), [false, false], 'the retained bytes are removed');
  assert.deepEqual(retentionMarker(f.stateDir, 'expired-1')!.sizes, { stdout: 4, stderr: 4 },
    'the marker keeps the byte offsets the contract needs');
  await waitUntil(() => (f.store.getMeta<number>(CURSOR_META) ?? 0) === 0, 5_000, 'the cursor to wrap at the end of the table');
  assert.equal(f.endpoint.retentionError(), '', 'a clean page records no failure');
  assert.equal(f.store.getMeta<string>(ERROR_META) ?? '', '');
  assert.deepEqual(f.endpoint.retentionFailureSummary(), { count: 0, firstSeen: null, lastSeen: null, examples: [], examplesOmitted: 0 });

  // A run whose retained output cannot be established names itself instead of failing silently.
  writeRun(f.store, settledRun('unreadable-1'));
  const root = hostRunRunDir(f.stateDir, 'unreadable-1');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  writeFileSync(join(root, 'stderr'), 'kept\n', { mode: 0o600 });
  symlinkSync(join(root, 'stderr'), join(root, 'stdout'));
  await waitUntil(() => f.endpoint.retentionError().includes('unreadable-1'), 5_000, 'the failed expiry to be reported');
  assert.match(f.endpoint.retentionError(), /^1 retained-output failure: unreadable-1: Retained output unavailable: stdout is a symlink/);
  const recorded = failureOf(f.store, 'unreadable-1');
  assert.ok(recorded, 'the failure is durable, not only in memory');
  assert.equal(recorded.epoch, 1, 'the entry keeps the run binding');
  assert.equal(recorded.attempts, 1);
  assert.equal(recorded.streams!.stdout.state, 'unreadable');
  assert.equal(recorded.streams!.stderr.state, 'present');
  assert.equal(recorded.streams!.stderr.size, 5, 'a readable stream keeps its true byte count');
  assert.ok(Date.parse(recorded.nextRetryAt) > f.clock.now, 'the next retry is scheduled ahead of this pass');
  assert.equal(f.store.getMeta<string>(ERROR_META), f.endpoint.retentionError(), 'the summary is durable too');
  assert.equal(f.endpoint.retentionFailureSummary().count, 1);
  assert.equal(f.endpoint.retentionFailureSummary().firstSeen, recorded.firstSeen);
  assert.equal(readFileSync(join(root, 'stderr'), 'utf8'), 'kept\n', 'the failed row keeps its readable bytes');
  assert.equal(retentionMarker(f.stateDir, 'unreadable-1'), null, 'an unknown stream never invents a marker');

  // A pass that is not due attempts nothing: the recorded cadence owns the retry.
  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'unreadable-1')!.attempts, 1, 'a wrap does not hammer a recorded failure');

  // Repairing the retained output clears only that run's entry, once its retry is due.
  unlinkSync(join(root, 'stdout'));
  writeFileSync(join(root, 'stdout'), 'fixed\n', { mode: 0o600 });
  f.clock.now += RETRY_BASE;
  await waitUntil(() => f.endpoint.retentionError() === '', 5_000, 'the failure to clear after the run is readable');
  assert.equal(f.store.getMeta<string>(ERROR_META), '');
  assert.deepEqual(f.endpoint.retentionFailureSummary(), { count: 0, firstSeen: null, lastSeen: null, examples: [], examplesOmitted: 0 });
  assert.deepEqual(retentionMarker(f.stateDir, 'unreadable-1')!.sizes, { stdout: 6, stderr: 5 },
    'the repaired row is retired with its true sizes');
});

test('a page advances past a run whose output is gone and a later page still expires', async t => {
  const f = await harness(t);
  // 600 settled runs: the audit's table is already this shape and only grows.
  for (let index = 0; index < 600; index++) {
    writeRun(f.store, settledRun(`row-${index}`, new Date(Date.parse(STAMP) + index * 1_000).toISOString()));
    writeOutput(f.stateDir, `row-${index}`, 'x', '');
  }
  // The live shape: a launched, settled run whose run directory holds no stream.
  const gone = hostRunRunDir(f.stateDir, 'row-260');
  unlinkSync(join(gone, 'stdout'));
  unlinkSync(join(gone, 'stderr'));
  f.store.setMeta(CURSOR_META, 100);

  f.endpoint.sweepRetainedOutput();
  // Falsification of the parent shape: the row-260 failure is on this page, and
  // #435's rule pins the cursor on it instead of continuing the cycle.
  const page = f.store.hostRunSettledSweepPage(100, 250);
  assert.ok(page.rows.some(row => row.id === 'row-260'), 'the failing run is on the page the parent rule would pin');
  assert.equal(legacyPinnedCursor(100, page, true), 100, 'the parent shape pins the first page on one absent run');
  assert.equal(f.store.getMeta<number>(CURSOR_META), 350, 'the sweep advances past the run it could not retire');
  assert.ok(retentionMarker(f.stateDir, 'row-100'), 'a good row before the failing one still expires');
  assert.ok(retentionMarker(f.stateDir, 'row-349'), 'a good row after it still expires');
  assert.equal(retentionMarker(f.stateDir, 'row-260'), null, 'the absent run gets no invented marker');
  assert.equal(existsSync(join(gone, 'stdout')), false);
  assert.equal(failures(f.store).length, 1, 'only the run whose output is gone is recorded');

  const recorded = failureOf(f.store, 'row-260');
  assert.ok(recorded, 'the run is recorded durably instead of being skipped');
  assert.equal(recorded.streams!.stdout.state, 'absent');
  assert.equal(recorded.streams!.stderr.state, 'absent');
  assert.equal(recorded.streams!.stdout.size, undefined, 'an absent stream carries no invented byte count');
  assert.match(recorded.reason, /Retained output is absent for a launched run/);
  assert.match(recorded.reason, /no stdout file/);
  assert.match(recorded.reason, /output ownership is unknown: no Project QA record names host run row-260/);
  assert.match(f.endpoint.retentionError(), /^1 retained-output failure/);
  assert.match(f.endpoint.retentionError(), /row-260: /);
  assert.doesNotMatch(f.endpoint.retentionError(), /more recorded durably/, 'a 250-row set is fully named by the summary');
  const firstSeen = recorded.firstSeen;

  // A later page in the same cycle retires more output and cannot clear the failure.
  f.endpoint.sweepRetainedOutput();
  assert.equal(f.store.getMeta<number>(CURSOR_META), 600, 'the next page continues the cycle');
  assert.ok(retentionMarker(f.stateDir, 'row-599'), 'the later page expires its own rows');
  assert.equal(failureOf(f.store, 'row-260')!.firstSeen, firstSeen, 'the failure survives a good page unchanged');
  assert.equal(failureOf(f.store, 'row-260')!.attempts, 1, 'the page that did not reach it did not retry it');
  assert.match(f.endpoint.retentionError(), /row-260/);

  // Behind the cursor, the durable set retries it on its own cadence.
  f.clock.now += RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'row-260')!.attempts, 2, 'a failure behind the cursor is retried independently');
  assert.equal(failureOf(f.store, 'row-260')!.firstSeen, firstSeen, 'the first sighting is preserved across retries');
  assert.ok(Date.parse(failureOf(f.store, 'row-260')!.nextRetryAt) === f.clock.now + 2 * RETRY_BASE,
    'the retry cadence is bounded and backs off');
});

test('failed runs are retried on bounded independent cadence and only their own success clears them', async t => {
  const f = await harness(t);
  writeRun(f.store, settledRun('good-1'));
  writeOutput(f.stateDir, 'good-1', 'x', '');
  // Three distinct refusal shapes, all past their retention hour.
  writeRun(f.store, settledRun('absent-1'));
  emptyRunDirectory(f.stateDir, 'absent-1');
  writeRun(f.store, settledRun('symlink-1'));
  const symlinked = emptyRunDirectory(f.stateDir, 'symlink-1');
  writeFileSync(join(symlinked, 'stderr'), 'kept\n', { mode: 0o600 });
  symlinkSync(join(symlinked, 'missing-target'), join(symlinked, 'stdout'));
  writeRun(f.store, settledRun('partial-1'));
  const partial = emptyRunDirectory(f.stateDir, 'partial-1');
  writeFileSync(join(partial, 'stdout'), 'known\n', { mode: 0o600 });

  f.endpoint.sweepRetainedOutput();
  assert.ok(retentionMarker(f.stateDir, 'good-1'), 'the good row is retired');
  assert.deepEqual(failures(f.store).map(entry => entry.runId), ['absent-1', 'partial-1', 'symlink-1']);
  assert.deepEqual(failures(f.store).map(entry => entry.attempts), [1, 1, 1]);
  assert.match(f.endpoint.retentionError(), /^3 retained-output failures/);
  assert.match(failureOf(f.store, 'partial-1')!.reason, /partial \(stdout is 6 bytes, stderr is absent \(no stderr file\)\)/);
  assert.match(failureOf(f.store, 'symlink-1')!.reason, /stdout is a symlink/);
  assert.equal(readFileSync(join(partial, 'stdout'), 'utf8'), 'known\n', 'a partial run keeps the offset it does know');
  assert.equal(retentionMarker(f.stateDir, 'partial-1'), null);
  assert.equal(retentionMarker(f.stateDir, 'absent-1'), null);

  // The page wraps and revisits every row, but nothing is due yet.
  f.endpoint.sweepRetainedOutput();
  assert.equal(f.store.getMeta<number>(CURSOR_META) ?? 0, 0);
  assert.deepEqual(failures(f.store).map(entry => entry.attempts), [1, 1, 1], 'a pass before the due time attempts nothing');

  f.clock.now += RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(failures(f.store).map(entry => entry.attempts), [2, 2, 2], 'each due failure is attempted once');
  assert.ok(failures(f.store).every(entry => Date.parse(entry.nextRetryAt) === f.clock.now + 2 * RETRY_BASE),
    'the attempts back off together and stay bounded');

  // Repairing one run removes only its own entry.
  unlinkSync(join(symlinked, 'stdout'));
  writeFileSync(join(symlinked, 'stdout'), 'fixed\n', { mode: 0o600 });
  f.clock.now += 2 * RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(failures(f.store).map(entry => entry.runId), ['absent-1', 'partial-1'], 'only the repaired run resolves');
  assert.deepEqual(retentionMarker(f.stateDir, 'symlink-1')!.sizes, { stdout: 6, stderr: 5 });
  assert.match(f.endpoint.retentionError(), /^2 retained-output failures: absent-1: /);
  assert.doesNotMatch(f.endpoint.retentionError(), /symlink-1/);
});

test('absent and never-written output are classified apart and neither invents a count', async t => {
  const f = await harness(t);
  // Provenance: no launch record, so the supervisor never wrote a stream.
  writeRun(f.store, neverLaunchedSettledRun('never-launched'));
  emptyRunDirectory(f.stateDir, 'never-launched');
  // An existing empty stream is a real zero and expires with its true count.
  writeRun(f.store, settledRun('empty-streams'));
  writeOutput(f.stateDir, 'empty-streams', '', '');
  // A launched run whose directory is gone entirely.
  writeRun(f.store, settledRun('vanished-directory'));
  // A launched run whose streams are simply absent in a present directory.
  writeRun(f.store, settledRun('absent-streams'));
  emptyRunDirectory(f.stateDir, 'absent-streams');
  // A corrupt marker: the expired counts are lost, so nothing is re-derived.
  writeRun(f.store, settledRun('corrupt-marker'));
  const corrupt = writeOutput(f.stateDir, 'corrupt-marker', 'kept\n', 'kept\n');
  writeFileSync(join(hostRunRunDir(f.stateDir, 'corrupt-marker'), 'output.retention.json'), '{"sizes":', { mode: 0o600 });
  // A marker that names another run is not this run's evidence.
  writeRun(f.store, settledRun('foreign-marker'));
  writeOutput(f.stateDir, 'foreign-marker', 'kept\n', 'kept\n');
  writeFileSync(join(hostRunRunDir(f.stateDir, 'foreign-marker'), 'output.retention.json'), JSON.stringify({
    format: 'host.run.output.retention', version: 1, runId: 'another-run', expiredAt: STAMP, sizes: { stdout: 0, stderr: 0 },
  }), { mode: 0o600 });

  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(retentionMarker(f.stateDir, 'empty-streams')!.sizes, { stdout: 0, stderr: 0 },
    'an existing empty stream is a true zero, not a missing stream');
  assert.equal(retentionMarker(f.stateDir, 'never-launched'), null, 'a never-written run gets no marker at all');
  assert.equal(failureOf(f.store, 'never-launched'), undefined,
    'proven never-written output is not a failure: there was nothing to expire');
  assert.match(failureOf(f.store, 'absent-streams')!.reason, /absent for a launched run \(no stdout file, no stderr file\)/);
  assert.match(failureOf(f.store, 'vanished-directory')!.reason, /the run directory is gone/);
  assert.match(failureOf(f.store, 'corrupt-marker')!.reason, /the retention marker is corrupt/);
  assert.match(failureOf(f.store, 'foreign-marker')!.reason, /the retention marker names run another-run/);
  assert.deepEqual(corrupt.map(file => existsSync(file)), [true, true], 'a corrupt marker leaves its bytes alone');
  assert.deepEqual(failures(f.store).map(entry => entry.runId),
    ['absent-streams', 'corrupt-marker', 'foreign-marker', 'vanished-directory'],
    'the distinct shapes are all recorded, and only the never-written run is not');
  assert.equal(f.endpoint.retentionFailureSummary().count, 4);
});

test('a lost run with no recorded process is not a retention failure; a lost run that had one still is', async t => {
  const f = await harness(t);
  // Tom, 2026-10-27: "It doesn't feel like that should constitute a failure?"
  // The live shape: a hand-launched run that settled lost, with no result and no
  // process identity, and no output files.
  writeRun(f.store, lostRun('lost-no-process'));
  emptyRunDirectory(f.stateDir, 'lost-no-process');
  f.store.putHostRunOutputFailure({
    runId: 'lost-no-process', epoch: 1, firstSeen: STAMP, lastSeen: STAMP, attempts: 5, nextRetryAt: STAMP,
    reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)',
  });
  // A process was recorded before the loss: output may have existed, so absence stays visible.
  writeRun(f.store, lostRun('lost-with-process', { process: true }));
  emptyRunDirectory(f.stateDir, 'lost-with-process');
  // A lost run's present streams still expire normally.
  writeRun(f.store, lostRun('lost-with-output'));
  writeOutput(f.stateDir, 'lost-with-output', 'kept\n', '');

  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'lost-no-process'), undefined, 'the recorded failure clears: there was no observed output to expire');
  assert.equal(retentionMarker(f.stateDir, 'lost-no-process'), null, 'no marker or byte count is invented');
  assert.match(failureOf(f.store, 'lost-with-process')!.reason, /absent for a launched run/);
  assert.deepEqual(retentionMarker(f.stateDir, 'lost-with-output')!.sizes, { stdout: 5, stderr: 0 });
  assert.deepEqual(failures(f.store).map(entry => entry.runId), ['lost-with-process']);
});

test('a restart keeps the durable cursor and the durable failure set', async t => {
  const f = await fileHarness(t);
  await f.open();
  for (let index = 0; index < 60; index++) {
    writeRun(f.store, settledRun(`before-${index}`, new Date(Date.parse(STAMP) + index * 1_000).toISOString()));
    writeOutput(f.stateDir, `before-${index}`, 'x', '');
  }
  writeRun(f.store, settledRun('broken-1'));
  emptyRunDirectory(f.stateDir, 'broken-1');
  f.store.setMeta(CURSOR_META, 60);
  assert.equal(f.store.getMeta<number>(CURSOR_META), 60, 'startup leaves the stored cursor for the sweep');
  f.endpoint.sweepRetainedOutput();
  assert.equal(retentionMarker(f.stateDir, 'before-0'), null, 'rows the stored cursor already passed wait for the wrap');
  assert.ok(failureOf(f.store, 'broken-1'), 'the refusal is recorded on the page that reached it');
  const recordedFirstSeen = failureOf(f.store, 'broken-1')!.firstSeen;
  f.endpoint.sweepRetainedOutput();
  assert.ok(retentionMarker(f.stateDir, 'before-0'), 'the wrapped page expires the oldest rows');
  await f.close();

  // A new store handle and a new endpoint: nothing is remembered in memory only.
  await f.open();
  assert.equal(f.store.getMeta<number>(CURSOR_META) ?? 0, 0, 'the wrapped cursor is still on disk');
  assert.match(f.endpoint.retentionError(), /broken-1/, 'the failure survives the restart');
  assert.equal(f.endpoint.retentionFailureSummary().count, 1);
  assert.equal(failureOf(f.store, 'broken-1')!.firstSeen, recordedFirstSeen, 'the first sighting survives the restart');
  writeRun(f.store, settledRun('after-restart'));
  writeOutput(f.stateDir, 'after-restart', 'kept\n', '');
  f.endpoint.sweepRetainedOutput();
  assert.ok(retentionMarker(f.stateDir, 'after-restart'), 'a later run is still retired after the restart');
  assert.match(f.endpoint.retentionError(), /broken-1/);
});

test('a failure write that fails never moves the cursor past an unrecorded failure', async t => {
  const f = await harness(t);
  writeRun(f.store, settledRun('broken-1'));
  emptyRunDirectory(f.stateDir, 'broken-1');
  for (let index = 0; index < 260; index++) {
    writeRun(f.store, settledRun(`row-${index}`, new Date(Date.parse(STAMP) + index * 1_000).toISOString()));
    writeOutput(f.stateDir, `row-${index}`, 'x', '');
  }
  f.store.setMeta(CURSOR_META, 0);
  const patched = f.store as unknown as { putHostRunOutputFailure: (failure: HostRunOutputFailure) => void };
  const original = patched.putHostRunOutputFailure.bind(f.store);
  let refuse = true;
  patched.putHostRunOutputFailure = (failure: HostRunOutputFailure) => {
    if (refuse) throw new Error('disk full');
    original(failure);
  };
  f.endpoint.sweepRetainedOutput();
  assert.equal(f.store.getMeta<number>(CURSOR_META), 0, 'the cursor stays on the page whose failure is unrecorded');
  assert.match(f.endpoint.retentionError(), /the retained-output failure for broken-1 could not be stored: disk full/);
  assert.match(f.endpoint.retentionError(), /broken-1/, 'the unrecorded failure is still named this pass');
  assert.equal(f.store.hostRunOutputFailure('broken-1'), null, 'nothing was written');
  assert.ok(retentionMarker(f.stateDir, 'row-0'), 'the good rows on that page were still retired');

  // The next pass can still write: the row it could not record is stored once,
  // not re-attempted early, and only then does the page advance.
  refuse = false;
  f.endpoint.sweepRetainedOutput();
  const recovered = failureOf(f.store, 'broken-1');
  assert.ok(recovered, 'the recovered pass stores the failure it could not write');
  assert.equal(recovered.attempts, 1, 'an attempt already made is not counted twice');
  assert.match(f.endpoint.retentionError(), /broken-1/);
  assert.equal(f.store.getMeta<number>(CURSOR_META), 250, 'the page advances once the failure is durable');
});

test('every failure identity survives past 100, and the parent rule drops the overflow', async t => {
  const f = await fileHarness(t);
  await f.open();
  const overflow = 130;
  for (let index = 0; index < overflow; index++) {
    writeRun(f.store, settledRun(`fail-${index}`, new Date(Date.parse(STAMP) + index * 1_000).toISOString()));
    emptyRunDirectory(f.stateDir, `fail-${index}`);
  }
  for (let index = 0; index < 120; index++) {
    writeRun(f.store, settledRun(`good-${index}`, new Date(Date.parse(STAMP) + (1_000 + index) * 1_000).toISOString()));
    writeOutput(f.stateDir, `good-${index}`, 'x', '');
  }
  // 250 settled rows: one full page. Every attempt is a genuine, unowned absence.
  f.endpoint.sweepRetainedOutput();
  const stored = failures(f.store);
  assert.equal(stored.length, overflow, 'every attempted failure has its own durable row');
  assert.equal(f.store.hostRunOutputFailureTotals().count, overflow);

  // The parent shape, verbatim: keep the first 100, drop the overflow identity,
  // and still report success — so the falsification fails on the dropped
  // identity, not on the summary wording.
  const parent = legacyStoredFailureSet(stored);
  assert.equal(parent.ok, true, 'the parent reported a successful store');
  assert.equal(parent.omitted, 30, 'the parent knew 30 identities were dropped');
  assert.equal(parent.kept.length, 100);
  const dropped = stored.filter(entry => !parent.kept.some(kept => kept.runId === entry.runId)).map(entry => entry.runId);
  assert.equal(dropped.length, 30, 'the parent drops exactly the overflow identities');
  for (const runId of dropped) assert.ok(failureOf(f.store, runId), `the durable set keeps ${runId}, which the parent dropped`);

  // Summary truncation is not storage truncation: the total is exact, the
  // named sample is bounded, and the text says which one it is.
  const summary = f.endpoint.retentionFailureSummary();
  assert.equal(summary.count, overflow, 'health reports the exact stored total');
  assert.equal(summary.examples.length, 5, 'the named sample stays bounded');
  assert.equal(summary.examplesOmitted, overflow - 5);
  assert.equal(summary.firstSeen, stored[0]!.firstSeen);
  assert.equal(summary.lastSeen, stored.map(entry => entry.lastSeen).sort().at(-1));
  assert.match(f.endpoint.retentionError(), /^130 retained-output failures \(125 more recorded durably, not named in this 5-run summary\)/,
    'the summary distinguishes its own bound from the durable set');
  assert.doesNotMatch(f.endpoint.retentionError(), new RegExp(dropped[0]!), 'the summary cannot name every row, and says so');

  // A later good page clears nothing; the cursor wraps and the set survives.
  f.endpoint.sweepRetainedOutput();
  assert.equal(f.store.getMeta<number>(CURSOR_META) ?? 0, 0, 'the page wraps after its good rows');
  assert.equal(failures(f.store).length, overflow, 'good pages never clear another run');
  assert.ok(retentionMarker(f.stateDir, 'good-119'), 'the later good rows are retired');

  // Restart: the exact identities, epochs, reasons and retry history are on disk.
  const before = failures(f.store);
  await f.close();
  await f.open();
  const after = failures(f.store);
  assert.deepEqual(after.map(entry => entry.runId), before.map(entry => entry.runId), 'every identity survives the restart');
  assert.deepEqual(after.map(entry => entry.firstSeen), before.map(entry => entry.firstSeen), 'their first sightings survive too');
  assert.equal(f.endpoint.retentionFailureSummary().count, overflow, 'health is still exact after the restart');
  assert.ok(failureOf(f.store, dropped[0]!), 'an overflow identity survives the restart');

  // Bounded due retry: with the page not reaching the failures, one pass retries
  // exactly the due page (25), and repeated passes reach every one of them.
  const pageReader = f.store as unknown as { hostRunSettledSweepPage: (after: number, limit: number) => { rows: HostRunInternalRecord[]; lastRowid: number; complete: boolean } };
  const originalPage = f.store.hostRunSettledSweepPage.bind(f.store);
  pageReader.hostRunSettledSweepPage = (after: number) => ({ rows: [], lastRowid: after, complete: false });
  const attemptsOf = () => failures(f.store).reduce((total, entry) => total + entry.attempts, 0);
  const firstSeenOf = new Map(failures(f.store).map(entry => [entry.runId, entry.firstSeen]));
  const passes = Math.ceil(overflow / 25);
  for (let pass = 0; pass < passes; pass++) {
    f.clock.now += 3 * RETRY_BASE;
    const beforePass = attemptsOf();
    f.endpoint.sweepRetainedOutput();
    assert.equal(f.endpoint.retentionFailureSummary().count, overflow, 'a bounded pass never drops a row');
    const attemptedNow = attemptsOf() - beforePass;
    assert.ok(attemptedNow <= 25, 'one pass retries at most one due page');
    if (overflow - pass * 25 >= 25) assert.equal(attemptedNow, 25, 'a full due page is exactly 25, oldest retry first');
    else assert.ok(attemptedNow >= overflow - pass * 25, 'the last pass reaches every remaining failure');
  }
  assert.ok(failures(f.store).every(entry => entry.attempts >= 2), 'every failure received its due retry');
  for (const entry of failures(f.store)) assert.equal(entry.firstSeen, firstSeenOf.get(entry.runId), 'retries preserve the first sighting');
  assert.equal(f.store.hostRunOutputFailuresDue(new Date(f.clock.now + 10 * RETRY_BASE).toISOString(), 25).length, 25,
    'the due read itself is a bounded page');

  // The due read and the named sample are index reads, not table scans.
  const plan = (sql: string) => (f.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: unknown }>)
    .map(row => String(row.detail)).join(' | ');
  assert.match(plan('SELECT runId FROM host_run_output_failures WHERE nextRetryAt <= ? ORDER BY nextRetryAt, runId LIMIT ?'),
    /host_run_output_failures_due/, 'the due read uses its index');
  assert.match(plan('SELECT runId FROM host_run_output_failures ORDER BY firstSeen, runId LIMIT ?'),
    /host_run_output_failures_first/, 'the named sample uses its index');
  pageReader.hostRunSettledSweepPage = originalPage;

  // Exact per-run clearing: one run's own success removes one identity.
  const target = failures(f.store)[0]!.runId;
  writeOutput(f.stateDir, target, 'kept\n', '');
  f.clock.now += 10 * RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.ok(retentionMarker(f.stateDir, target), 'the repaired run is retired with its true sizes');
  assert.equal(f.store.hostRunOutputFailureTotals().count, overflow - 1, 'only that run cleared');
  assert.equal(failureOf(f.store, target), undefined);
});

test('stale, missing and changed-epoch failures stay visible instead of resolving', async t => {
  const f = await harness(t);
  writeRun(f.store, settledRun('changed-epoch'));
  emptyRunDirectory(f.stateDir, 'changed-epoch');
  writeRun(f.store, settledRun('missing-row'));
  emptyRunDirectory(f.stateDir, 'missing-row');
  f.endpoint.sweepRetainedOutput();
  assert.equal(failures(f.store).length, 2);
  const firstSeen = failureOf(f.store, 'changed-epoch')!.firstSeen;

  // The row's identity moves to a new epoch; the recorded failure names the old one.
  writeRun(f.store, hostRunRecordSchema.parse({ ...settledRun('changed-epoch'), epoch: 2 }));
  f.store.db.prepare('DELETE FROM host_run_records WHERE id=?').run('missing-row');
  f.clock.now += RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.match(failureOf(f.store, 'changed-epoch')!.reason, /the host run is now epoch 2/);
  assert.match(failureOf(f.store, 'missing-row')!.reason, /the host run is gone/);
  assert.equal(failureOf(f.store, 'changed-epoch')!.firstSeen, firstSeen, 'a stale observation keeps its first sighting');
  assert.equal(failures(f.store).length, 2, 'neither stale identity is resolved');
  assert.equal(f.endpoint.retentionFailureSummary().count, 2, 'health still reports both');
  assert.match(f.endpoint.retentionError(), /changed-epoch/);
});

test('verified Project QA ownership clears the milestone false positive and nothing else', async t => {
  const f = await harness(t);
  const qaLogRoot = join(f.stateDir, 'qa-logs');
  /** A QA step's own retained log, which this sweep must never read, move or remove. */
  const writeQaLogs = (id: string) => {
    const dir = join(qaLogRoot, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'qa.stdout.log'), `qa output ${id}\n`, { mode: 0o600 });
    writeFileSync(join(dir, 'qa.stderr.log'), '', { mode: 0o600 });
    return [join(dir, 'qa.stdout.log'), join(dir, 'qa.stderr.log')];
  };

  // The live shape: an authentic launched milestone run, its QA record, and an
  // empty generic run directory (QA writes its own step logs instead).
  writeRun(f.store, qaSettledRun('milestone-1'));
  f.store.putQaRun(qaRecord('milestone-1'));
  emptyRunDirectory(f.stateDir, 'milestone-1');
  const logs = writeQaLogs('milestone-1');

  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'milestone-1'), undefined, 'a positively QA-owned run is not a host-run failure');
  assert.equal(f.endpoint.retentionFailureSummary().count, 0, 'health reports no unresolved failure');
  assert.equal(f.endpoint.retentionError(), '');
  assert.equal(retentionMarker(f.stateDir, 'milestone-1'), null, 'no retention marker and no invented byte count');
  assert.deepEqual(logs.map(path => existsSync(path)), [true, true], 'the QA step logs are untouched');
  assert.equal(readFileSync(logs[0]!, 'utf8'), 'qa output milestone-1\n');
  assert.equal(reclassifications(f.store), null, 'a run that never became a failure needs no reclassification evidence');
});

test('a recorded milestone false positive is cleared only by exact verified ownership', async t => {
  const f = await harness(t);
  // Plant the false positive exactly as the parent recorded it (task 443's shape).
  const absent = { stdout: { state: 'absent' as const, reason: 'no stdout file' }, stderr: { state: 'absent' as const, reason: 'no stderr file' } };
  const plant = (runId: string, epoch = 1) => f.store.putHostRunOutputFailure({
    runId, epoch, firstSeen: STAMP, lastSeen: STAMP, attempts: 1,
    nextRetryAt: new Date(f.clock.now - 1).toISOString(),
    reason: 'Retained output is absent for a launched run (no stdout file, no stderr file); the expired byte counts are unknown',
    streams: absent,
  });
  writeRun(f.store, qaSettledRun('milestone-clear'));
  f.store.putQaRun(qaRecord('milestone-clear'));
  emptyRunDirectory(f.stateDir, 'milestone-clear');
  plant('milestone-clear');

  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'milestone-clear'), undefined, 'the verified false positive is cleared');
  const evidence = reclassifications(f.store);
  assert.ok(evidence, 'the reclassification is durable evidence');
  assert.equal(evidence.total, 1);
  assert.equal(evidence.recent.length, 1);
  assert.equal(evidence.recent[0]!.owner, 'project_qa');
  assert.equal(evidence.recent[0]!.qaRunId, 'milestone-clear');
  assert.equal(evidence.recent[0]!.key, 'owner/audit');
  assert.equal(evidence.recent[0]!.epoch, 1);
  assert.match(evidence.recent[0]!.detail, /^retained output owned by Project QA run milestone-clear/);
  assert.doesNotMatch(evidence.recent[0]!.detail, /expired|zero|passed/, 'the evidence claims ownership, not QA success or zero offsets');
  assert.equal(f.endpoint.retentionFailureSummary().count, 0);

  // Idempotent across a restart: the cleared row stays cleared, the evidence stays
  // one entry, and a re-run of the pass adds nothing.
  f.clock.now += RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.equal(failureOf(f.store, 'milestone-clear'), undefined);
  assert.equal(reclassifications(f.store)!.total, 1, 'the evidence is written once, not once per pass');
});

test('forged, missing, foreign and unreadable ownership keeps the failure visible', async t => {
  const f = await harness(t);
  const absent = { stdout: { state: 'absent' as const, reason: 'no stdout file' }, stderr: { state: 'absent' as const, reason: 'no stderr file' } };
  const plant = (runId: string) => f.store.putHostRunOutputFailure({
    runId, epoch: 1, firstSeen: STAMP, lastSeen: STAMP, attempts: 1, nextRetryAt: new Date(f.clock.now - 1).toISOString(),
    reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)', streams: absent,
  });
  const cases = [
    // A forged prefix with no QA record at all.
    { id: 'forged-prefix', run: qaSettledRun('forged-prefix'), qa: null, expect: /no Project QA record names host run forged-prefix/ },
    // A caller that only starts with the milestone prefix.
    { id: 'forged-caller', run: qaSettledRun('forged-caller', { caller: `queue:milestone:${'0'.repeat(24)}:forged-caller` }),
      qa: qaRecord('forged-caller'), expect: /is not the canonical milestone identity/ },
    // A caller naming another run.
    { id: 'foreign-caller', run: qaSettledRun('foreign-caller', { caller: qaCallerIdentity('owner/audit', 'another-run') }),
      qa: qaRecord('foreign-caller'), expect: /is not the canonical milestone identity/ },
    // The QA record names a different repository.
    { id: 'foreign-repo', run: qaSettledRun('foreign-repo'), qa: qaRecord('foreign-repo', { origin: 'other/repo', path: '/other' }),
      expect: /name different repositories/ },
    // The recorded failure names another epoch, so the stale rule keeps it visible
    // and never re-binds it to the row that replaced it.
    { id: 'changed-epoch', run: qaSettledRun('changed-epoch', { epoch: 2 }), qa: qaRecord('changed-epoch', { epoch: 1 }),
      expect: /the host run is now epoch 2/ },
    // A legacy QA row without the pinned epoch cannot prove which run it owns.
    { id: 'legacy-qa', run: qaSettledRun('legacy-qa'), qa: qaRecord('legacy-qa', { epoch: null }),
      expect: /does not pin the host-run epoch/ },
    // A genuine generic-supervised absence has no QA record and stays a failure.
    { id: 'generic-absent', run: settledRun('generic-absent'), qa: null,
      expect: /no Project QA record names host run generic-absent/ },
  ] as const;
  for (const entry of cases) {
    writeRun(f.store, entry.run);
    emptyRunDirectory(f.stateDir, entry.id);
    if (entry.qa) f.store.putQaRun(entry.qa);
    plant(entry.id);
  }
  // A QA-owned run that nonetheless has a generic stream is contradictory evidence.
  writeRun(f.store, qaSettledRun('contradictory-stream'));
  f.store.putQaRun(qaRecord('contradictory-stream'));
  const contradictory = emptyRunDirectory(f.stateDir, 'contradictory-stream');
  writeFileSync(join(contradictory, 'stdout'), 'generic output\n', { mode: 0o600 });
  plant('contradictory-stream');
  // A QA record whose stored row is unreadable cannot prove ownership.
  writeRun(f.store, qaSettledRun('unreadable-qa'));
  f.store.db.prepare('INSERT INTO project_qa_runs(id,repository,data) VALUES(?,?,?)').run('unreadable-qa', 'owner/audit', '{}');
  emptyRunDirectory(f.stateDir, 'unreadable-qa');
  plant('unreadable-qa');

  f.endpoint.sweepRetainedOutput();
  for (const entry of cases) {
    const recorded = failureOf(f.store, entry.id);
    assert.ok(recorded, `${entry.id} stays a durable failure`);
    assert.match(recorded.reason, entry.expect, `${entry.id} says why ownership is unknown`);
    assert.doesNotMatch(recorded.reason, /owned by Project QA/);
  }
  assert.match(failureOf(f.store, 'contradictory-stream')!.reason, /Retained output is partial \(stdout is 15 bytes, stderr is absent \(no stderr file\)\)/,
    'actual generic output evidence contradicts QA ownership');
  assert.match(failureOf(f.store, 'unreadable-qa')!.reason, /output ownership is unknown: the Project QA record could not be read/);
  assert.equal(reclassifications(f.store), null, 'no rejection is recorded as a reclassification');
  assert.equal(f.endpoint.retentionFailureSummary().count, cases.length + 2,
    'every unverified absence stays visible and counted');
  assert.match(f.endpoint.retentionError(), /^9 retained-output failures/);
});

test('the parent treats a milestone absence as a failure, the corrected sweep does not', async t => {
  // Falsification of the parent's classification, not of our wording: the parent
  // test is the 443 rule "launched + both streams absent => unavailable", applied
  // to an authentic QA-owned run.
  const parentClassifiesAbsentLaunched = (streams: { stdout: { state: string }; stderr: { state: string } }) =>
    streams.stdout.state === 'absent' && streams.stderr.state === 'absent' ? 'unavailable' : 'other';
  const streams = { stdout: { state: 'absent' as const, reason: 'no stdout file' }, stderr: { state: 'absent' as const, reason: 'no stderr file' } };
  const run = qaSettledRun('milestone-parent');
  assert.equal(parentClassifiesAbsentLaunched(streams), 'unavailable',
    'the parent shape records an authentic QA-owned milestone run as a retained-output failure');
  const ownership = classifyRetainedOutputOwnership({ run, qaRun: qaRecord('milestone-parent'), streams });
  assert.equal(ownership.owner, 'project_qa', 'the amendment classifies the same shape as QA-owned, not missing output');
  assert.equal(ownership.owner === 'project_qa' && ownership.qaRunId, 'milestone-parent');
  // And the parent's overflow rule loses the identity that classification keeps.
  const planted = Array.from({ length: 130 }, (_, index) => ({
    runId: `p-${index}`, epoch: 1, firstSeen: new Date(Date.parse(STAMP) + index).toISOString(), lastSeen: STAMP,
    attempts: 1, nextRetryAt: STAMP, reason: 'absent', streams,
  }));
  assert.equal(legacyStoredFailureSet(planted).kept.some(entry => entry.runId === 'p-129'), false,
    'the parent drops the 130th genuine failure');
});

test('service health publishes the exact durable total with a bounded named sample', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hrm-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const hostRunStateDir = join(root, 'host-run');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fakeAdapter = (dir: string): Adapter => ({
    client: { isConnected: true }, hostId: 'fixture-host',
    socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'worker-helper.mjs'),
    connect: async () => {}, close: async () => {}, profiles: async () => [],
    observe: observeIdle('ws', 'worker'),
  } as unknown as Adapter);
  const runtime = new QueueRuntime({
    dataDir, hostRunEndpoint: true, hostRunStateDir, adapterFactory: () => fakeAdapter(dataDir), timers: false,
  });
  t.after(() => runtime.drain());
  await runtime.hostRunReady;

  assert.equal(runtime.health().hostRunEndpoint?.retentionFailures, null, 'a clean endpoint publishes null, not a zero-shaped summary');
  assert.equal(runtime.health().hostRunEndpoint?.retentionError, '');
  for (let index = 0; index < 104; index++) runtime.store.putHostRunOutputFailure({
    runId: `health-${index}`, epoch: 1,
    firstSeen: new Date(Date.parse(STAMP) + index * 1_000).toISOString(), lastSeen: STAMP,
    attempts: 1, nextRetryAt: new Date(Date.parse(STAMP) + RETRY_BASE).toISOString(),
    reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)',
  });
  const health = runtime.health().hostRunEndpoint;
  assert.equal(health?.retentionFailures?.count, 104, 'health reports the exact total past the summary cap');
  assert.equal(health?.retentionFailures?.examples.length, 5, 'the named sample is bounded');
  assert.equal(health?.retentionFailures?.examplesOmitted, 99);
  assert.equal(health?.retentionFailures?.firstSeen, new Date(Date.parse(STAMP)).toISOString());
  assert.equal(health?.retentionFailures?.lastSeen, STAMP);
  assert.match(health?.retentionError ?? '', /^104 retained-output failures \(99 more recorded durably/,
    'the health text cannot read as an all-clear');
  assert.equal(runtime.store.hostRunOutputFailureTotals().count, 104, 'the store holds every identity');

  // Clearing is per run: the count falls by one and never reads as resolved while
  // another unresolved row exists.
  runtime.store.deleteHostRunOutputFailure('health-103');
  assert.equal(runtime.health().hostRunEndpoint?.retentionFailures?.count, 103);
  assert.notEqual(runtime.health().hostRunEndpoint?.retentionError, '');
  for (let index = 0; index < 103; index++) runtime.store.deleteHostRunOutputFailure(`health-${index}`);
  assert.equal(runtime.health().hostRunEndpoint?.retentionFailures, null, 'the last resolution clears the evidence');
  assert.equal(runtime.health().hostRunEndpoint?.retentionError, '');

  // A set that cannot be read is not an all-clear: the structured field carries
  // the reason instead of publishing null (review papercut on this change).
  runtime.store.putHostRunOutputFailure({
    runId: 'health-unreadable', epoch: 1, firstSeen: STAMP, lastSeen: STAMP, attempts: 1,
    nextRetryAt: new Date(Date.parse(STAMP) + RETRY_BASE).toISOString(), reason: 'Retained output is absent for a launched run',
  });
  const patched = runtime.store as unknown as { hostRunOutputFailureTotals: () => unknown };
  const originalTotals = patched.hostRunOutputFailureTotals.bind(runtime.store);
  patched.hostRunOutputFailureTotals = () => { throw new Error('store gone'); };
  const unreadable = runtime.health().hostRunEndpoint;
  assert.ok(unreadable?.retentionFailures, 'an unreadable set is published, never null');
  assert.equal(unreadable?.retentionFailures?.unreadable !== undefined, true);
  assert.match(unreadable?.retentionFailures?.unreadable ?? '', /could not be read \(store gone\)/);
  assert.match(unreadable?.retentionError ?? '', /could not be read \(store gone\)/, 'the text names the fault too');
  patched.hostRunOutputFailureTotals = originalTotals;
  assert.equal(runtime.health().hostRunEndpoint?.retentionFailures?.count, 1, 'a readable set is reported again');
});

// Lean store 2 (task 987): output that is still absent after the history retention settles its failure
// (a run settled past four days has no output left to establish), instead of retrying every 10 minutes.
test('a failure whose run settled past the history retention settles and is not recorded again', async t => {
  const f = await harness(t);
  writeRun(f.store, settledRun('old-absent'));
  emptyRunDirectory(f.stateDir, 'old-absent');
  f.clock.now = Date.parse(STAMP) + 2 * RETIRED;
  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(failures(f.store).map(entry => entry.runId), ['old-absent'], 'inside the history window the absent output is a failure');

  f.clock.now += 5 * 24 * RETIRED;
  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(failures(f.store), [], 'past the four-day history retention the failure settles');
  f.clock.now += 10 * RETRY_BASE;
  f.endpoint.sweepRetainedOutput();
  assert.deepEqual(failures(f.store), [], 'and a later pass does not record it again');
});
