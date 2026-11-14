import { RuntimeRepositories, type RepositoriesContext } from "../core/runtime/repositories";
import { HostRunWatch } from "../core/host-runs/host-run-watch";
/**
 * The CPU reason is Queue-internal and rollback-safe (Tom, 2026-10-23,
 * "Honest + cheaper"; approver rulings: keep it internal, then SIDECAR). Every
 * wire shape, private record and table row keeps main's strict shape; the
 * reason travels in a private sidecar and rests in the store's internal meta.
 * Strict shapes come from frozen copies, never from Nucleus or the new code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../core/store/store';
import { HostRunScheduler } from '../core/host-runs/host-run-scheduler';
import { HostRunEndpoint, hostRunSupervisorStateSchema, writeVerifiedOwnedFile, type HostRunSupervisorState } from '../service/callbacks/host-run-endpoint';
import {
  QA_SUPERVISION_SCHEMA, QA_SUPERVISION_SCHEMA_VERSION, qaSupervisionCpuCoverage, qaSupervisionPaths, qaSupervisionStateSchema,
  readQaCpuCoverage, readQaSupervision, writeQaSupervision, type QaSupervisionState,
} from '../core/qa/project-qa-supervision-files';
import {
  projectValidationSupervisorPaths, projectValidationSupervisorResultSchema, readProjectValidationCpuCoverage, readProjectValidationResult,
  writeProjectValidationCpuCoverage, writeProjectValidationResult,
} from '../core/qa/project-validation-supervisor';
import { QueueRuntime } from '../service/runtime-owner';
import {
  HOST_RUN_CPU_COVERAGE_FILE, boundSidecarCoverage, hostRunCpuCoverageMetaKey, hostRunCpuCoverageSidecar,
} from '../core/host-runs/host-run-cpu-coverage';
import {
  hostRunList, hostRunRecordSchema, hostRunResultSchema, hostRunSettlementSchema, type HostRunCpuCoverage, type HostRunResult,
} from '../shared/contracts';
import { frozenHostRunRecordSchema, frozenHostRunResultSchema, frozenHostRunSettlementSchema } from './support/contract-010-frozen';
import {
  MAIN_META_PATTERN_SCANS, mainPrivateHostRunSupervisorStateSchema, mainPrivateProjectValidationSupervisorResultSchema,
  mainPrivateQaSupervisionStateSchema,
} from './support/main-private-records-frozen';

const capacity = () => ({ cpuCapacity: 4, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [0, 0, 0] });
const repository = { origin: 'https://github.com/example/cpu', path: '/repo/cpu' };
const AT = '2026-10-23T10:00:00.000Z';
const hasCoverage = (value: unknown) => /cpuCoverage/.test(typeof value === 'string' ? value : JSON.stringify(value));
const resultFor = (runId: string, epoch: number, at: string, cpuMs: number | null, pgid = 9): HostRunResult => hostRunResultSchema.parse({
  format: 'host.run.result', version: 1, runId, epoch, pgid, startIdentity: `${pgid}@2026-10-23T10:00:00Z`, exitCode: 0, signal: null,
  startedAt: at, endedAt: at, wallMs: 1000, cpuMs, escapedDescendants: [] });
const supervisorState = (runId: string, epoch: number, termination: 'timeout' | 'cancel' | null = null): HostRunSupervisorState => hostRunSupervisorStateSchema.parse({
  format: 'host.run.supervisor.state', version: 1, runId, epoch, supervisorPid: 1, supervisorStartIdentity: '1@x',
  termination, startedAt: AT, updatedAt: AT });

/** A store and scheduler, plus helpers that launch and settle one run. */
async function harness(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'host-run-cpu-contract-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const scheduler = new HostRunScheduler(store, { capacity });
  const launch = (runId: string) => {
    scheduler.submit({ id: runId, epoch: 1, caller: `test:${runId}`, repository, selector: 'qa', runClass: 'light', classSource: 'default',
      priority: 'validation', runTimeoutMs: 60_000 }, { launch: candidate => { scheduler.markLaunched(candidate.id); } });
    return scheduler.get(runId)!;
  };
  const settle = (runId: string, cpuMs: number | null, cpuCoverage?: HostRunCpuCoverage) => {
    const run = launch(runId);
    const result = resultFor(runId, run.epoch, run.launchedAt!, cpuMs);
    const settlement = hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId, outcome: 'passed', launched: true,
      settledAt: run.launchedAt!, result, containers: [] });
    scheduler.settle(runId, settlement, { wallMs: 1000, cpuMs, cpuCoverage });
    return store.hostRun(runId)!;
  };
  return { dir, store, scheduler, launch, settle };
}

test('wire shapes and private records are byte-for-byte main\'s strict schemas', () => {
  for (const [current, frozen] of [
    [hostRunResultSchema, frozenHostRunResultSchema], [hostRunSettlementSchema, frozenHostRunSettlementSchema], [hostRunRecordSchema, frozenHostRunRecordSchema],
    [hostRunSupervisorStateSchema, mainPrivateHostRunSupervisorStateSchema],
    [projectValidationSupervisorResultSchema, mainPrivateProjectValidationSupervisorResultSchema],
    [qaSupervisionStateSchema, mainPrivateQaSupervisionStateSchema],
  ] as const) assert.deepEqual(z.toJSONSchema(current, { io: 'input' }), z.toJSONSchema(frozen, { io: 'input' }));
  assert.equal(hostRunResultSchema.safeParse({ ...resultFor('r', 1, AT, 400), cpuCoverage: 'sampled' }).success, false);
});

test('no table row carries the reason; only internal meta does, and every outbound projection is main\'s shape', async t => {
  const h = await harness(t);
  const sampled = h.settle('sampled', 400, 'sampled');
  h.settle('unobserved', null, 'unobserved');
  h.settle('legacy', 0);
  assert.deepEqual([h.scheduler.cpuCoverage('sampled'), h.scheduler.cpuCoverage('unobserved'), h.scheduler.cpuCoverage('legacy')],
    ['sampled', 'unobserved', undefined]);

  // Every table row in the store, as main's code would read it.
  const tables = h.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name));
  for (const table of tables) {
    const rows = h.store.db.prepare(`SELECT * FROM "${table}"`).all();
    const leaking = rows.filter(row => hasCoverage(row) && !(table === 'meta' && String(row.key).startsWith('hostRunCpuCoverage:')));
    assert.deepEqual(leaking, [], `table ${table}`);
  }
  for (const row of h.store.db.prepare('SELECT data FROM host_run_records').all())
    assert.equal(frozenHostRunRecordSchema.safeParse(JSON.parse(String(row.data))).success, true, 'a stored row parses with main\'s strict schema');

  // This read uses only hostRuns and markStoreAccess from the context.
  const runtime = { repositories: new RuntimeRepositories({ markStoreAccess() {}, hostRuns: { list: () => h.scheduler.list(), releaseCapacity: (id: string) => h.store.hostRun(id)! } } as unknown as RepositoriesContext) };
  const listed = (QueueRuntime.prototype.listHostRuns as Function).call(runtime) as unknown[];
  assert.equal(hostRunList.output.safeParse(listed).success, true);
  for (const record of listed) assert.equal(frozenHostRunRecordSchema.safeParse(record).success, true);
  const view = (HostRunEndpoint.prototype as any).runView.call({}, sampled);
  assert.equal(hasCoverage(view), false);
  assert.equal(frozenHostRunSettlementSchema.safeParse(view.settlement).success, true);

  for (const runId of ['sampled', 'unobserved', 'legacy']) {
    const settled = h.store.hostRunJournal(runId).find(entry => entry.event === 'settlement')!.data as { settlement?: unknown };
    assert.equal(hasCoverage(settled), false, `${runId} journal settlement keeps the reason out`);
    assert.equal(frozenHostRunSettlementSchema.safeParse(settled.settlement).success, true);
  }
});

test('no meta pattern scan in main can match the internal key', () => {
  const db = new DatabaseSync(':memory:');
  for (const scan of MAIN_META_PATTERN_SCANS) {
    const row = db.prepare(`SELECT ? ${scan.op} ? AS hit`).get(hostRunCpuCoverageMetaKey('run-1'), scan.pattern) as { hit: number };
    assert.equal(row.hit, 0, `${scan.op} ${scan.pattern}`);
  }
  db.close();
});

test('the reason is deleted by the settled-run history retention and kept before it', async t => {
  const h = await harness(t);
  h.settle('old', 400, 'sampled');
  h.settle('recent', 300, 'sampled');
  const settledAt = Date.parse(h.store.hostRun('old')!.settledAt!);
  // Only "old" falls before the cutoff: move "recent" past it.
  const recent = h.store.hostRun('recent')!;
  h.store.putHostRun({ ...recent, settledAt: new Date(settledAt + 10_000).toISOString() });
  await h.store.pruneRetainedHistory(new Date(settledAt + 5_000).toISOString());
  assert.equal(h.store.getMeta(hostRunCpuCoverageMetaKey('old')), undefined, 'pruned with its journal');
  assert.equal(h.scheduler.cpuCoverage('old'), undefined);
  assert.equal(h.scheduler.cpuCoverage('recent'), 'sampled', 'a run inside the window keeps it');
});

test('the meta reason binds to the row\'s epoch and cpuMs; anything else, or a failed write, is absent', async t => {
  const h = await harness(t);
  const row = h.settle('bound', 400, 'sampled');
  for (const [label, value] of [
    ['another epoch', { epoch: row.epoch + 1, cpuMs: 400, cpuCoverage: 'sampled' }],
    ['another sample', { epoch: row.epoch, cpuMs: 401, cpuCoverage: 'sampled' }],
    ['inconsistent', { epoch: row.epoch, cpuMs: 400, cpuCoverage: 'unobserved' }],
    ['malformed', { cpuCoverage: 'sampled' }],
  ] as const) {
    h.store.setMeta(hostRunCpuCoverageMetaKey('bound'), value);
    assert.equal(h.scheduler.cpuCoverage('bound'), undefined, label);
  }
  h.store.db.prepare('UPDATE meta SET value=? WHERE key=?').run('{not json', hostRunCpuCoverageMetaKey('bound'));
  assert.equal(h.scheduler.cpuCoverage('bound'), undefined, 'unreadable');
  for (const [cpuMs, coverage] of [[null, 'sampled'], [0, 'sampled'], [12, 'unobserved']] as const)
    assert.equal(h.store.getMeta(hostRunCpuCoverageMetaKey(h.settle(`mismatch-${cpuMs}-${coverage}`, cpuMs, coverage).id)), undefined);
  assert.equal(h.store.getMeta(hostRunCpuCoverageMetaKey(h.settle('legacy-positive', 700).id)), undefined, 'a legacy positive is never promoted');
  const setMeta = h.store.setMeta.bind(h.store);
  h.store.setMeta = (key: string, value: unknown) => { if (key.startsWith('hostRunCpuCoverage:')) throw new Error('injected meta write failure'); setMeta(key, value); };
  t.after(() => { h.store.setMeta = setMeta; });
  const failed = h.settle('meta-write-fails', 400, 'sampled');
  assert.deepEqual([failed.state, failed.settlement?.outcome, failed.cpuMs], ['settled', 'passed', 400], 'the settlement stands');
  assert.equal(h.scheduler.cpuCoverage('meta-write-fails'), undefined);
});

test('a sidecar binds only to its own run, epoch, step and cpuMs', () => {
  const sidecar = (overrides: Record<string, unknown> = {}) => ({ ...hostRunCpuCoverageSidecar({ runId: 'r', epoch: 2, step: 'qa' }, 400, 'sampled'), ...overrides });
  const expected = { runId: 'r', epoch: 2, step: 'qa', cpuMs: 400 };
  assert.equal(boundSidecarCoverage(sidecar(), expected), 'sampled');
  for (const [label, raw] of [['another run', sidecar({ runId: 'x' })], ['another epoch', sidecar({ epoch: 1 })], ['another step', sidecar({ step: 'setup' })],
    ['no step', sidecar({ step: undefined })], ['another sample', sidecar({ cpuMs: 300 })], ['inconsistent', sidecar({ cpuMs: null })],
    ['unknown field', sidecar({ extra: 1 })], ['missing', null], ['garbage', 'x']] as const)
    assert.equal(boundSidecarCoverage(raw, expected), undefined, label);
  assert.equal(boundSidecarCoverage(sidecar({ cpuMs: null, cpuCoverage: 'unobserved' }), { ...expected, cpuMs: null }), 'unobserved');
});

test('the endpoint settles the same with or without the sidecar, keeps the termination cause, and binds only a matching sidecar', async t => {
  const h = await harness(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'host-run-cpu-sidecar-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const watch = new HostRunWatch({ scheduler: h.scheduler, stateDir, nowMs: Date.now, stopping: false, supervisorPollMs: 100 });
  const settleWith = (runId: string, sidecar: string | null, termination: 'timeout' | 'cancel' | null) => {
    const run = h.launch(runId);
    if (sidecar !== null) writeVerifiedOwnedFile(stateDir, ['runs', runId, HOST_RUN_CPU_COVERAGE_FILE], sidecar, 0o600);
    watch.settleFromResult(run, resultFor(runId, run.epoch, run.launchedAt!, 400), supervisorState(runId, run.epoch, termination));
    return { row: h.store.hostRun(runId)!, coverage: h.scheduler.cpuCoverage(runId) };
  };
  const good = (runId: string, epoch = 1) => JSON.stringify(hostRunCpuCoverageSidecar({ runId, epoch }, 400, 'sampled'));
  const cases = [
    settleWith('with', good('with'), 'timeout'),
    settleWith('without', null, 'timeout'),
    settleWith('stale-epoch', good('stale-epoch', 9), 'cancel'),
    settleWith('other-run', good('someone-else'), null),
    settleWith('unreadable', '{torn', null),
  ];
  assert.deepEqual(cases.map(item => [item.row.settlement?.outcome, item.row.cpuMs, item.coverage]), [
    ['timed_out', 400, 'sampled'], ['timed_out', 400, undefined], ['cancelled', 400, undefined], ['passed', 400, undefined], ['passed', 400, undefined]]);
  const shape = (row: typeof cases[number]['row']) => [row.state, row.settlement?.outcome, row.cpuMs, row.wallMs, row.capacityReleaseKind,
    Object.keys(row).sort(), Object.keys(row.settlement!.result!).sort()];
  assert.deepEqual(shape(cases[0].row), shape(cases[1].row), 'the sidecar never changes the settled row');
  // An old reader opens only its own fixed names: the run's state still parses strictly beside a sidecar.
  assert.equal(mainPrivateHostRunSupervisorStateSchema.safeParse(supervisorState('with', 1, 'timeout')).success, true);
});

test('validation: main\'s strict reader parses the new envelope beside its sidecar; the sidecar is separate and bound', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pv-cpu-sidecar-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = projectValidationSupervisorPaths(dataDir, 'val-1');
  await import('node:fs/promises').then(fs => fs.mkdir(paths.root, { recursive: true, mode: 0o700 }));
  const hostResult = resultFor('val-1', 3, AT, 400);
  writeProjectValidationCpuCoverage(paths.cpuCoveragePath, hostRunCpuCoverageSidecar({ runId: 'val-1', epoch: 3 }, 400, 'sampled'));
  writeProjectValidationResult(paths.resultPath, { format: 'queue.project-validation.result', version: 1, runId: 'val-1', epoch: 3,
    identityToken: 'y'.repeat(32), state: 'hold', exitCode: null, durationMs: 1000, outputTail: '', timedOut: true, signal: 'SIGTERM',
    pid: 9, processGroupId: 9, leaderStartIdentity: 'y'.repeat(32), processGroupEmpty: true, terminationError: null, hostResult,
    startedAt: AT, endedAt: AT });
  const raw = JSON.parse(readFileSync(paths.resultPath, 'utf8'));
  const old = mainPrivateProjectValidationSupervisorResultSchema.parse(raw);
  assert.deepEqual([old.timedOut, old.signal, old.hostResult?.cpuMs], [true, 'SIGTERM', 400], 'the old reader keeps the timeout cause');
  assert.equal(hasCoverage(raw), false);
  assert.equal(readProjectValidationResult(paths.resultPath, 'val-1')?.timedOut, true);
  assert.equal(boundSidecarCoverage(readProjectValidationCpuCoverage(paths.cpuCoveragePath), { runId: 'val-1', epoch: 3, cpuMs: 400 }), 'sampled');
  assert.equal(boundSidecarCoverage(readProjectValidationCpuCoverage(paths.cpuCoveragePath), { runId: 'val-1', epoch: 2, cpuMs: 400 }), undefined);
  assert.equal(readProjectValidationCpuCoverage(join(paths.root, 'missing.json')), null, 'a failed or missing write reads as absent');
});

test('milestone QA: main\'s strict reader parses the new state; the sidecar binds by run, epoch, step and cpuMs, and is removed with the run files', async t => {
  const runRoot = await mkdtemp(join(tmpdir(), 'qa-cpu-sidecar-'));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const paths = qaSupervisionPaths(runRoot, 'qa-1');
  const hostResult = resultFor('qa-1', 1, AT, 400, 4242);
  const step = (name: string, processGroupId: number) => ({ name, command: name, exitCode: 0, signal: null, timedOut: false, processGroupId,
    stdoutHead: '', stdoutTail: '', stderrHead: '', stderrTail: '' });
  const state: QaSupervisionState = qaSupervisionStateSchema.parse({ schema: QA_SUPERVISION_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: 'qa-1', key: 'repo', pid: 1, identityToken: 'x'.repeat(32), startedAt: AT, heartbeatAt: AT, inFlight: null,
    steps: [step('setup', 4100), step('qa', 4242)], failedStep: null, detail: '', cancelReason: 'operator stop',
    result: { state: 'cancelled', exitCode: null, durationMs: 1000, detail: '', finishedAt: AT, hostResult } });
  writeFileSync(paths.cpuCoveragePath, JSON.stringify(hostRunCpuCoverageSidecar({ runId: 'qa-1', epoch: 1, step: 'qa' }, 400, 'sampled')), { mode: 0o600 });
  writeQaSupervision(paths.statePath, state);
  const old = mainPrivateQaSupervisionStateSchema.parse(JSON.parse(readFileSync(paths.statePath, 'utf8')));
  assert.deepEqual([old.result?.state, old.cancelReason], ['cancelled', 'operator stop'], 'the old reader keeps the cancel cause');
  assert.equal(hasCoverage(readFileSync(paths.statePath, 'utf8')), false);
  const read = readQaSupervision(paths.statePath);
  const sidecar = readQaCpuCoverage(paths.cpuCoveragePath);
  assert.equal(qaSupervisionCpuCoverage('qa-1', read, hostResult, sidecar), 'sampled');
  assert.equal(qaSupervisionCpuCoverage('qa-2', read, hostResult, sidecar), undefined, 'another run');
  assert.equal(qaSupervisionCpuCoverage('qa-1', read, { ...hostResult, epoch: 2 }, sidecar), undefined, 'another epoch');
  assert.equal(qaSupervisionCpuCoverage('qa-1', read, { ...hostResult, cpuMs: 300 }, sidecar), undefined, 'another sample');
  assert.equal(qaSupervisionCpuCoverage('qa-1', read, { ...hostResult, pgid: 4100 }, sidecar), undefined, 'another step');
  assert.equal(qaSupervisionCpuCoverage('qa-1', null, hostResult, sidecar), undefined, 'no state: the step cannot be named');
  assert.equal(qaSupervisionCpuCoverage('qa-1', read, hostResult, readQaCpuCoverage(join(runRoot, 'missing'))), undefined);
  const { removeQaSupervisionFiles } = await import('../core/qa/project-qa-supervision-files');
  removeQaSupervisionFiles(runRoot, 'qa-1');
  assert.equal(readQaCpuCoverage(paths.cpuCoveragePath), null, 'removed with the supervision files');
});
