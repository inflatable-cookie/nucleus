import { observeIdle } from './support/fakes';
/**
 * Spec 056 through the public RuntimeOwner/durable-operation envelope: the
 * preview is read-only, the apply is a durable `repository_rekey` operation, a
 * lost reply reconciles the same operation and receipt, and a refusal settles
 * as a definite failure with nothing written.
 *
 * Task 445 continues the same path across a real repository re-key of a
 * milestone Project QA run: the journal is submitted with the canonical caller
 * the producer minted from the run's key, the re-key moves the QA row's key, and
 * the live default host-run endpoint's retained-output sweep must still recognise
 * the original caller — with the exact QA run id, the applied receipt as its
 * evidence, its QA logs untouched, no invented byte count or marker, and the
 * genuine unowned run beside it still a visible failure. The proof survives a
 * restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { hostRunRunDir, type HostRunEndpoint } from '../service/callbacks/host-run-endpoint';
import { qaCallerIdentity } from '../core/qa/qa-caller';
import { HOST_RUN_OUTPUT_RECLASSIFICATIONS_META, hostRunOutputReclassificationLogSchema } from '../core/host-runs/host-run-output-failures';
import {
  hostRunRecordSchema, hostRunSettlementSchema, projectQaRunSchema, submissionSchema,
  type HostRunInternalRecord, type ProjectQaRun,
} from '../shared/contracts';
import { suggestedRepositoryRekeyKey } from '../shared/repository-rekey';
import type { Store } from '../core/store/store';
import type { Adapter } from '../core/host';

const SOURCE = { origin: 'acme/app', path: '/fixture/app' };
const TARGET = { origin: 'acme/app-next', path: '' };

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A launched, settled milestone QA host run whose caller the producer minted
 * from its key, with an empty generic run directory: milestone QA writes its own
 * step logs, so the generic supervisor never wrote `stdout` or `stderr`.
 */
function qaSettledRun(id: string, key: string, at: string): HostRunInternalRecord {
  const settledAt = new Date(Date.parse(at) + 60_000).toISOString();
  return hostRunRecordSchema.parse({
    id, epoch: 1, caller: qaCallerIdentity(key, id), repository: SOURCE, selector: 'qa',
    runClass: 'heavy', classSource: 'default', priority: 'milestone', state: 'settled', submittedAt: at,
    capacityDeadlineAt: settledAt, runTimeoutMs: 600_000, budgetFallback: { cpu: 1, memoryBytes: 1_000 },
    budget: { cpu: 1, memoryBytes: 1_000, wallMs: 60_000, source: 'history' }, position: null, admittedAt: at,
    launchedAt: at, settledAt, capacitySample: null, pid: 8_100, processGroupId: 8_100, startIdentity: '8100@identity',
    settlement: hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: id, outcome: 'passed', launched: true,
      settledAt, containers: [], result: { format: 'host.run.result', version: 1, runId: id, epoch: 1, pgid: 8_100,
        startIdentity: '8100@identity', exitCode: 0, signal: null, startedAt: at, endedAt: settledAt,
        wallMs: 60_000, cpuMs: 1_000, escapedDescendants: [] } }),
    wallMs: 60_000, cpuMs: 1_000, containers: [], capacityReleasedAt: settledAt, capacityReleaseReason: 'settled',
    capacityReleaseKind: 'automatic',
  });
}

/** The durable Project QA row that names one host run: same id, key, repository and epoch. */
/** The QA supervision root the pipeline writes its own step logs under. */
const qaLogRootFor = (id: string): string => join(tmpdir(), 'queue-qa-logs', id);

function qaRecord(id: string, key: string, at: string): ProjectQaRun {
  const startedAt = at, finishedAt = new Date(Date.parse(at) + 60_000).toISOString();
  return projectQaRunSchema.parse({
    id, key, repository: SOURCE, state: 'passed', baseBranch: 'main', base: 'a'.repeat(40),
    argv: ['effigy', 'qa'], digest: 'b'.repeat(64), exitCode: 0, durationMs: 60_000, outputTail: 'ok\n',
    startedAt, finishedAt, pid: null, capacityWait: null, capacityUnavailable: false, hostRunEpoch: 1,
    submittedAt: startedAt,
    steps: [{
      name: 'qa', command: 'effigy qa', exitCode: 0, signal: null, timedOut: false,
      stdoutHead: 'ok\n', stdoutTail: 'ok\n', stderrHead: '', stderrTail: '',
      stdoutLogPath: join(qaLogRootFor(id), 'qa.stdout.log'), stderrLogPath: join(qaLogRootFor(id), 'qa.stderr.log'),
      stdoutBytes: 3, stderrBytes: 0,
    }],
  });
}

function writeRun(store: Store, record: HostRunInternalRecord): void {
  store.db.prepare('INSERT OR REPLACE INTO host_run_records(id,repository,state,data) VALUES(?,?,?,?)')
    .run(record.id, record.repository.origin ?? record.repository.path, record.state, JSON.stringify(record));
}

/** The QA-owned run directory shape: present, owned, and holding no generic stream. */
function emptyRunDirectory(stateDir: string, runId: string): string {
  mkdirSync(join(stateDir, 'runs'), { recursive: true, mode: 0o700 });
  chmodSync(join(stateDir, 'runs'), 0o700);
  const root = hostRunRunDir(stateDir, runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

const fakeAdapter = (dir: string): Adapter => ({
  client: { isConnected: true }, hostId: 'fixture-host',
  socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'worker-helper.mjs'),
  connect: async () => {}, close: async () => {}, profiles: async () => [],
  observe: observeIdle('ws', 'worker'),
} as unknown as Adapter);

interface ServiceFixture {
  dir: string; dataDir: string; stateDir: string; runtime: QueueRuntime;
  store: Store; endpoint: HostRunEndpoint;
}

async function service(dir: string): Promise<ServiceFixture> {
  const dataDir = join(dir, 'data');
  const stateDir = join(dir, 'host-run');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runtime = new QueueRuntime({
    dataDir, hostRunEndpoint: true, hostRunStateDir: stateDir, adapterFactory: () => fakeAdapter(dataDir), timers: false,
  });
  await runtime.hostRunReady;
  await pause(0);
  const store = (runtime as unknown as { store: Store }).store;
  const endpoint = (runtime as unknown as { hostRunEndpoint: HostRunEndpoint | null }).hostRunEndpoint;
  assert.ok(endpoint, 'the default endpoint is served by the runtime');
  return { dir, dataDir, stateDir, runtime, store, endpoint: endpoint! };
}

test('Spec 056/445 a re-keyed milestone QA run keeps its submitted caller through the default endpoint sweep', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-rekey-qa-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let f = await service(dir);
  // Two hours old, so contract 010's one-hour output retention has expired.
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const qaLogRoot = join(f.stateDir, 'qa-logs', 'milestone-rekey');
  mkdirSync(qaLogRoot, { recursive: true, mode: 0o700 });
  const qaLogs = [join(qaLogRoot, 'qa.stdout.log'), join(qaLogRoot, 'qa.stderr.log')];
  writeFileSync(qaLogs[0]!, 'qa output for milestone-rekey\n', { mode: 0o600 });
  writeFileSync(qaLogs[1]!, '', { mode: 0o600 });

  await f.runtime.setRepository({ repository: SOURCE.origin, closeout: 'agent', note: 'app settings' });
  const store = f.store;
  const input = submissionSchema.parse({ submissionId: 'sub-qa-rekey', title: 'QA re-key task', repoPath: SOURCE.path,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
  const task = store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, SOURCE.origin);
  store.update(task.id, { phase: 'done' }, 'done');

  // The authentic producer pair: the journal row and its QA record, plus a
  // genuine generic-supervised run beside it that has no QA record at all.
  // Two QA-owned runs: one keeps the per-run submitted key this change records,
  // the other is the pre-receipt shape (its key moved before that field existed),
  // plus a genuine generic-supervised run with no QA record at all.
  for (const id of ['milestone-rekey', 'milestone-legacy']) {
    writeRun(store, qaSettledRun(id, SOURCE.origin, at));
    store.putQaRun(qaRecord(id, SOURCE.origin, at));
    emptyRunDirectory(f.stateDir, id);
    // The live false positive 444 clears: a recorded failure against the QA run.
    store.putHostRunOutputFailure({
      runId: id, epoch: 1, firstSeen: at, lastSeen: at, attempts: 1,
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
      reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)',
      streams: { stdout: { state: 'absent', reason: 'no stdout file' }, stderr: { state: 'absent', reason: 'no stderr file' } },
    });
  }
  writeRun(store, hostRunRecordSchema.parse({ ...qaSettledRun('generic-unknown', SOURCE.origin, at),
    caller: 'test:generic-unknown' }));
  emptyRunDirectory(f.stateDir, 'generic-unknown');
  const hostRunBytes = store.db.prepare('SELECT id,repository,data FROM host_run_records WHERE id=?').get('milestone-rekey')!;
  assert.equal(JSON.stringify(hostRunBytes).includes(qaCallerIdentity(SOURCE.origin, 'milestone-rekey')), true);

  // One durable, public re-key step of the whole namespace.
  const stepInput = {
    source: SOURCE.origin, target: TARGET, expectedSourceRevision: store.repositoryFor(SOURCE.origin)!.revision,
    reason: 'GitHub rename acme/app to acme/app-next', author: 'operator',
    idempotencyKey: suggestedRepositoryRekeyKey({ source: SOURCE.origin, target: TARGET }),
  };
  const result = await f.runtime.rekeyRepository(stepInput);
  assert.ok('receipt' in result, `expected a settled receipt, got ${JSON.stringify(result)}`);
  if (!('receipt' in result)) return;
  assert.equal(result.receipt.counts.projectQaRuns, 2);
  const operations = store.operations({ states: ['succeeded'] }).filter(operation => operation.kind === 'repository_rekey');
  assert.equal(operations.length, 1, 'the re-key committed as one durable operation');
  const moved = store.qaRun('milestone-rekey')!;
  assert.equal(moved.key, TARGET.origin);
  assert.equal(moved.repository.origin, TARGET.origin);
  assert.equal(moved.submittedKey, SOURCE.origin, 'the submitted key travels with the run in the same transaction');
  // The pre-receipt shape: the key moved long before this field existed.
  const storedLegacy = store.qaRun('milestone-legacy')! as unknown as Record<string, unknown>;
  delete storedLegacy.submittedKey;
  store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(storedLegacy), 'milestone-legacy');
  assert.equal(store.qaRun('milestone-legacy')?.submittedKey, undefined);
  // The contract-010 journal row is history: the caller stays exactly as minted.
  assert.deepEqual(store.db.prepare('SELECT id,repository,data FROM host_run_records WHERE id=?').get('milestone-rekey'),
    hostRunBytes, 'the host-run record and its caller are byte-identical after the re-key');

  // Restart on the same store and state root, as a service roll does.
  await f.runtime.stop();
  f = await service(dir);
  const restarted = f.store;
  assert.equal(restarted.qaRun('milestone-rekey')?.submittedKey, SOURCE.origin, 'the provenance survives the restart');
  assert.equal(restarted.hostRunOutputFailure('milestone-rekey')?.attempts, 1, 'the recorded failure survived the restart too');

  f.endpoint.sweepRetainedOutput();
  // Both re-keyed runs are positively owned: each failure is cleared with durable
  // evidence, and neither is ever recorded as a generic host-run failure again.
  for (const id of ['milestone-rekey', 'milestone-legacy']) assert.equal(restarted.hostRunOutputFailure(id), null, `${id} cleared`);
  const evidence = hostRunOutputReclassificationLogSchema.parse(restarted.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META));
  assert.equal(evidence.total, 2);
  const byRun = new Map(evidence.recent.flatMap(entry => entry.owner === 'project_qa' ? [[entry.runId, entry] as const] : []));
  const recorded = byRun.get('milestone-rekey')!;
  assert.equal(recorded.qaRunId, 'milestone-rekey', 'the evidence binds the exact QA run id');
  assert.equal(recorded.key, SOURCE.origin, 'the evidence binds the submitted key the caller names');
  assert.equal(recorded.repository, TARGET.origin);
  assert.match(recorded.detail, /recorded as this run's submitted key and now acme\/app-next/);
  assert.doesNotMatch(recorded.detail, /expired|zero|passed/, 'ownership evidence claims no offset, byte count or QA success');
  // The pre-receipt row is accepted only through the applied receipt, and says so.
  const legacyEvidence = byRun.get('milestone-legacy')!;
  assert.equal(legacyEvidence.qaRunId, 'milestone-legacy');
  assert.equal(legacyEvidence.key, SOURCE.origin);
  assert.match(legacyEvidence.detail, /verified through repository re-key acme\/app → acme\/app-next at /);
  assert.match(legacyEvidence.detail, new RegExp(`receipt ${result.receipt.id}`));

  // No invented custody: no retention marker, no byte count, and the QA producer's
  // own step logs are exactly as written.
  for (const id of ['milestone-rekey', 'milestone-legacy'])
    assert.equal(existsSync(join(hostRunRunDir(f.stateDir, id), 'output.retention.json')), false, `${id} gets no invented marker`);
  assert.deepEqual(qaLogs.map(path => existsSync(path)), [true, true]);
  assert.equal(readFileSync(qaLogs[0]!, 'utf8'), 'qa output for milestone-rekey\n');
  assert.equal(readFileSync(qaLogs[1]!, 'utf8'), '');

  // The genuine unowned absence beside it is still a durable, visible failure.
  const unknown = restarted.hostRunOutputFailure('generic-unknown');
  assert.ok(unknown, 'a generic-supervised absence stays a retained-output failure');
  assert.match(unknown.reason, /no Project QA record names host run generic-unknown/);
  assert.equal(f.runtime.health().hostRunEndpoint?.retentionFailures?.count, 1, 'health publishes the exact remaining total');
  assert.match(f.runtime.health().hostRunEndpoint?.retentionError ?? '', /generic-unknown/);

  // Idempotent across a second pass and a repeated (lost-reply) re-key step.
  f.endpoint.sweepRetainedOutput();
  assert.equal(hostRunOutputReclassificationLogSchema.parse(restarted.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META)).total, 2);
  const replay = await f.runtime.rekeyRepository(stepInput);
  assert.ok('receipt' in replay);
  if (!('receipt' in replay)) return;
  assert.equal(replay.replayed, true);
  assert.equal(restarted.qaRun('milestone-rekey')?.submittedKey, SOURCE.origin, 'a replayed step never rewrites the provenance');
  await f.runtime.stop();
});

test('Spec 056/445 a path-changing re-key still accepts the run’s recorded submitted caller', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-rekey-qa-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let f = await service(dir);
  // Two hours old, so contract 010's one-hour output retention has expired.
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await f.runtime.setRepository({ repository: SOURCE.origin, closeout: 'agent', note: 'app settings' });
  const qaLogs: string[] = [];
  for (const id of ['milestone-path', 'milestone-path-legacy']) {
    const qaLogRoot = join(f.stateDir, 'qa-logs', id);
    mkdirSync(qaLogRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(qaLogRoot, 'qa.stdout.log'), `qa output for ${id}\n`, { mode: 0o600 });
    writeFileSync(join(qaLogRoot, 'qa.stderr.log'), '', { mode: 0o600 });
    qaLogs.push(join(qaLogRoot, 'qa.stdout.log'), join(qaLogRoot, 'qa.stderr.log'));
    // Authentic pair: the journal row at the pre-move checkout and its QA record.
    writeRun(f.store, qaSettledRun(id, SOURCE.origin, at));
    f.store.putQaRun(qaRecord(id, SOURCE.origin, at));
    emptyRunDirectory(f.stateDir, id);
    f.store.putHostRunOutputFailure({
      runId: id, epoch: 1, firstSeen: at, lastSeen: at, attempts: 1,
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
      reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)',
      streams: { stdout: { state: 'absent', reason: 'no stdout file' }, stderr: { state: 'absent', reason: 'no stderr file' } },
    });
  }
  const hostRunBytes = f.store.db.prepare('SELECT id,repository,data FROM host_run_records WHERE id=?').get('milestone-path')!;

  // One durable public step that moves the origin *and* the checkout.
  const movedPath = '/fixture/app-next';
  const stepInput = {
    source: SOURCE.origin, target: { origin: TARGET.origin, path: movedPath },
    expectedSourceRevision: f.store.repositoryFor(SOURCE.origin)!.revision,
    reason: 'GitHub rename acme/app to acme/app-next with a new checkout', author: 'operator',
    idempotencyKey: suggestedRepositoryRekeyKey({ source: SOURCE.origin, target: TARGET }),
  };
  const result = await f.runtime.rekeyRepository(stepInput);
  assert.ok('receipt' in result, `expected a settled receipt, got ${JSON.stringify(result)}`);
  if (!('receipt' in result)) return;
  assert.equal(result.receipt.pathChanged, true, 'the step moved the checkout as well as the identity');
  assert.equal(result.receipt.counts.projectQaRuns, 2);
  const movedRow = f.store.qaRun('milestone-path')!;
  assert.equal(movedRow.repository.path, movedPath, 'the QA row follows the checkout');
  assert.equal(movedRow.submittedKey, SOURCE.origin, 'the production write records the submitted key');
  // The pre-receipt shape: this row was re-keyed before that field existed.
  const legacy = f.store.qaRun('milestone-path-legacy')! as unknown as Record<string, unknown>;
  delete legacy.submittedKey;
  f.store.db.prepare('UPDATE project_qa_runs SET data=? WHERE id=?').run(JSON.stringify(legacy), 'milestone-path-legacy');
  // The contract-010 row is history, so it still names the pre-move checkout.
  assert.deepEqual(f.store.db.prepare('SELECT id,repository,data FROM host_run_records WHERE id=?').get('milestone-path'), hostRunBytes);

  await f.runtime.stop();
  f = await service(dir);
  assert.equal(f.store.qaRun('milestone-path')?.submittedKey, SOURCE.origin, 'the provenance survives the restart');
  assert.equal(f.store.qaRun('milestone-path')?.repository.path, movedPath);

  f.endpoint.sweepRetainedOutput();
  // The reviewer's shape: the production write keeps the submitted key, so the
  // pre-move checkout the run records must not refuse authentic ownership.
  for (const id of ['milestone-path', 'milestone-path-legacy'])
    assert.equal(f.store.hostRunOutputFailure(id), null, `${id} is positively owned`);
  const evidence = hostRunOutputReclassificationLogSchema.parse(f.store.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META));
  assert.equal(evidence.total, 2);
  const byRun = new Map(evidence.recent.flatMap(entry => entry.owner === 'project_qa' ? [[entry.runId, entry] as const] : []));
  const recorded = byRun.get('milestone-path')!;
  assert.equal(recorded.qaRunId, 'milestone-path');
  assert.equal(recorded.key, SOURCE.origin);
  assert.equal(recorded.repository, TARGET.origin);
  assert.match(recorded.detail, /recorded as this run's submitted key and now acme\/app-next/);
  assert.match(byRun.get('milestone-path-legacy')!.detail, /verified through repository re-key acme\/app → acme\/app-next at /);
  for (const id of ['milestone-path', 'milestone-path-legacy'])
    assert.equal(existsSync(join(hostRunRunDir(f.stateDir, id), 'output.retention.json')), false, `${id} gets no invented marker`);
  assert.equal(readFileSync(qaLogs[0]!, 'utf8'), 'qa output for milestone-path\n', 'the QA step logs are untouched');
  assert.equal(f.runtime.health().hostRunEndpoint?.retentionFailures, null, 'health reports nothing unresolved');
  await f.runtime.stop();
});
