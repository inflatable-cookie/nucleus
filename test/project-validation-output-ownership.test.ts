import { observeIdle } from './support/fakes';
/**
 * Merge-time project validation is a second Queue producer with its own
 * supervisor: the generic `runs/<id>/stdout` and `stderr` are never written for
 * it, so a settled validation run past contract 010's retention hour looked like
 * a missing-output failure (live 2026-10-26: three Project-E `check:merge` runs).
 *
 * Positive ownership is the caller's exact `queue:validation:<task>:<head>`
 * identity plus the named task durably recording that exact host run *at that
 * exact epoch and head*, and a host run Queue positively submitted. A forged
 * caller, a task that never scheduled the run, a missing task, a later head, a
 * changed epoch, a run id alone, a client submission and an unreadable journal
 * each stay a visible failure. Every fixture is a fresh mktemp; no live database
 * or state is read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { hostRunRunDir, type HostRunEndpoint } from '../service/callbacks/host-run-endpoint';
import { projectValidationCallerIdentity, parseProjectValidationCaller, projectValidationSchedulerEvidence } from '../core/qa/project-validation-caller';
import { HOST_RUN_OUTPUT_RECLASSIFICATIONS_META, hostRunOutputReclassificationLogSchema } from '../core/host-runs/host-run-output-failures';
import { hostRunRecordSchema, hostRunSettlementSchema, submissionSchema, type HostRunInternalRecord } from '../shared/contracts';
import type { Store } from '../core/store/store';
import type { Adapter } from '../core/host';

const SOURCE = { origin: 'acme/app', path: '/fixture/app' };
const TARGET = { origin: 'acme/app-next', path: '' };

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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


const HEAD = 'c'.repeat(40);

/** A launched, settled Queue-submitted validation host run with the caller the producer minted. */
function validationRun(id: string, caller: string, at: string): HostRunInternalRecord {
  const settledAt = new Date(Date.parse(at) + 60_000).toISOString();
  return hostRunRecordSchema.parse({
    id, epoch: 1, submissionSource: 'queue', caller, repository: SOURCE, selector: 'check:merge',
    runClass: 'light', classSource: 'default', priority: 'validation', state: 'settled', submittedAt: at,
    capacityDeadlineAt: settledAt, runTimeoutMs: 600_000, budgetFallback: { cpu: 1, memoryBytes: 1_000 },
    budget: { cpu: 1, memoryBytes: 1_000, wallMs: 60_000, source: 'fallback' }, position: null, admittedAt: at,
    launchedAt: at, settledAt, capacitySample: null, pid: 8_100, processGroupId: 8_100, startIdentity: '8100@identity',
    settlement: hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: id, outcome: 'passed', launched: true,
      settledAt, containers: [], result: { format: 'host.run.result', version: 1, runId: id, epoch: 1, pgid: 8_100,
        startIdentity: '8100@identity', exitCode: 0, signal: null, startedAt: at, endedAt: settledAt,
        wallMs: 60_000, cpuMs: 1_000, escapedDescendants: [] } }),
    wallMs: 60_000, cpuMs: 1_000, containers: [], capacityReleasedAt: settledAt, capacityReleaseReason: 'settled',
    capacityReleaseKind: 'automatic',
  });
}

const absentFailure = (id: string, at: string) => ({
  runId: id, epoch: 1, firstSeen: at, lastSeen: at, attempts: 1,
  nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
  reason: 'Retained output is absent for a launched run (no stdout file, no stderr file)',
  streams: { stdout: { state: 'absent' as const, reason: 'no stdout file' }, stderr: { state: 'absent' as const, reason: 'no stderr file' } },
});

/** A row written before the pinned record carried `submissionSource`. */
function withoutSource(record: HostRunInternalRecord): HostRunInternalRecord {
  const { submissionSource: _source, ...rest } = record;
  return rest as HostRunInternalRecord;
}

/** The durable live validation pin: the run this task is validating now, at its head and epoch. */
function pinValidation(store: Store, taskId: string, runId: string, head: string, epoch: number): void {
  const current = store.task(taskId)!;
  store.update(taskId, { resolution: { ...current.resolution, projectValidation: {
    argv: ['effigy', 'check'], digest: 'd'.repeat(64), exitCode: 0, durationMs: 1_000, outputTail: '',
    base: 'b'.repeat(40), head, candidate: null, state: 'passed', queueBuild: '', settingsRevision: 0,
    hostRunId: runId, hostRunEpoch: epoch, pid: null, capacityWait: null, capacityUnavailable: false,
  } } }, 'project_validation_result', `${'d'.repeat(64)} passed`);
}

test('the caller grammar is exactly the canonical validation identity', () => {
  const caller = projectValidationCallerIdentity('task-1', HEAD);
  assert.deepEqual(parseProjectValidationCaller(caller), { taskId: 'task-1', head: HEAD });
  for (const forged of ['queue:validation:task-1', 'queue:validation::' + HEAD, `queue:validation:task-1:${HEAD}:x`, `x${caller}`, `queue:milestone:abc:${HEAD}`])
    assert.equal(parseProjectValidationCaller(forged), null, forged);
});

test('the scheduling evidence names the run, the epoch and the head, and nothing shorter', () => {
  const evidence = projectValidationSchedulerEvidence('run-1', 2, HEAD);
  assert.equal(evidence, `queue:validation-scheduled:run-1:2:${HEAD}`);
  assert.notEqual(evidence, projectValidationSchedulerEvidence('run-1', 1, HEAD), 'a changed epoch is different evidence');
  assert.notEqual(evidence, projectValidationSchedulerEvidence('run-1', 2, 'd'.repeat(40)), 'another head is different evidence');
  assert.notEqual(evidence, 'run-1', 'a run id alone never binds a head or an epoch');
});

test('a settled project-validation run is reclassified by its task record; forgeries stay visible failures', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-validation-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await service(dir);
  t.after(() => f.runtime.stop());
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const store = f.store;
  const input = submissionSchema.parse({ submissionId: 'sub-validation', title: 'Validated task', repoPath: SOURCE.path,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
  const task = store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, SOURCE.origin);

  const seed = (id: string, caller: string) => {
    writeRun(store, validationRun(id, caller, at));
    emptyRunDirectory(f.stateDir, id);
    store.putHostRunOutputFailure(absentFailure(id, at));
  };
  // The live pin still names the settling run: the strongest durable evidence.
  seed('validation-pinned', projectValidationCallerIdentity(task.id, HEAD));
  pinValidation(store, task.id, 'validation-pinned', HEAD, 1);
  // The pin moved on, but the run's own scheduling event names run, epoch and head.
  seed('validation-owned', projectValidationCallerIdentity(task.id, HEAD));
  store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence('validation-owned', 1, HEAD));
  // The task never scheduled this run: a validation-shaped caller alone proves nothing.
  seed('validation-unrecorded', projectValidationCallerIdentity(task.id, HEAD));
  // A caller naming a task that does not exist.
  seed('validation-no-task', projectValidationCallerIdentity('no-such-task', HEAD));
  // A different producer's run, even with a recorded event of the same shape.
  seed('validation-client', projectValidationCallerIdentity(task.id, HEAD));
  store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence('validation-client', 1, HEAD));
  writeRun(store, hostRunRecordSchema.parse({ ...validationRun('validation-client', projectValidationCallerIdentity(task.id, HEAD), at),
    submissionSource: 'client' }));

  f.endpoint.sweepRetainedOutput();

  for (const id of ['validation-pinned', 'validation-owned'])
    assert.equal(store.hostRunOutputFailure(id), null, `${id} is cleared`);
  for (const id of ['validation-unrecorded', 'validation-no-task', 'validation-client']) {
    const kept = store.hostRunOutputFailure(id);
    assert.ok(kept, `${id} stays a visible failure`);
    assert.match(kept!.reason, /output ownership is unknown/);
  }
  assert.match(store.hostRunOutputFailure('validation-unrecorded')!.reason, /records no project validation scheduled as host run validation-unrecorded at epoch 1/);
  assert.match(store.hostRunOutputFailure('validation-client')!.reason, /not submitted by Queue/);

  const evidence = hostRunOutputReclassificationLogSchema.parse(store.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META));
  assert.equal(evidence.total, 2);
  for (const entry of evidence.recent) {
    assert.equal(entry.owner, 'project_validation');
    if (entry.owner !== 'project_validation') continue;
    assert.equal(entry.taskId, task.id);
    assert.equal(entry.head, HEAD);
    assert.doesNotMatch(entry.detail, /passed|zero|expired /, 'ownership evidence claims no result, offset or byte count');
  }
  assert.deepEqual(evidence.recent.map(entry => entry.runId).sort(), ['validation-owned', 'validation-pinned']);

  // The evidence is stable: a second sweep changes nothing.
  f.endpoint.sweepRetainedOutput();
  assert.equal(hostRunOutputReclassificationLogSchema.parse(store.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META)).total, 2);
});

test('historical scheduling evidence binds the exact head and epoch, and a moved pin leaves it intact', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-validation-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await service(dir);
  t.after(() => f.runtime.stop());
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const store = f.store;
  const input = submissionSchema.parse({ submissionId: 'sub-binding', title: 'Bound task', repoPath: SOURCE.path,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
  const task = store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, SOURCE.origin);
  const caller = (head: string) => projectValidationCallerIdentity(task.id, head);
  const seed = (id: string, head: string) => {
    writeRun(store, validationRun(id, caller(head), at));
    emptyRunDirectory(f.stateDir, id);
    store.putHostRunOutputFailure(absentFailure(id, at));
  };

  // A later head's event cannot vouch for the caller's head.
  seed('validation-other-head', 'd'.repeat(40));
  store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence('validation-other-head', 1, HEAD));
  // A changed epoch is not re-bound to the row's epoch.
  seed('validation-changed-epoch', HEAD);
  store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence('validation-changed-epoch', 2, HEAD));
  // The superseded event detail named the run id alone: that never established a head or epoch.
  seed('validation-run-only', HEAD);
  store.event(task.id, 'project_validation_scheduler_recorded', 'validation-run-only');
  // The live pin moved on to a later validation; this run's own event still binds it.
  seed('validation-pin-moved', HEAD);
  store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence('validation-pin-moved', 1, HEAD));
  // The live shape the roll cannot prove: the pin moved on and the only event is a
  // superseded run-id-only detail, so no head or epoch survives to bind the run.
  seed('validation-pin-moved-legacy', HEAD);
  store.event(task.id, 'project_validation_scheduler_recorded', 'validation-pin-moved-legacy');
  pinValidation(store, task.id, 'later-validation-run', 'e'.repeat(40), 1);

  f.endpoint.sweepRetainedOutput();

  for (const id of ['validation-other-head', 'validation-changed-epoch', 'validation-run-only', 'validation-pin-moved-legacy']) {
    assert.ok(store.hostRunOutputFailure(id), `${id} stays a visible failure`);
    assert.match(store.hostRunOutputFailure(id)!.reason, /records no project validation scheduled as host run/);
  }
  assert.equal(store.hostRunOutputFailure('validation-pin-moved'), null, 'the run\'s own evidence survives the pin moving on');
  const evidence = hostRunOutputReclassificationLogSchema.parse(store.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META));
  assert.deepEqual(evidence.recent.map(entry => entry.runId), ['validation-pin-moved']);
});

test('an absent submission source needs the journal\'s own Queue submit, and nothing else', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-validation-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await service(dir);
  t.after(() => f.runtime.stop());
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const store = f.store;
  const input = submissionSchema.parse({ submissionId: 'sub-source', title: 'Historical task', repoPath: SOURCE.path,
    planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' });
  const task = store.insert(input, 'host', 'handoff', 'a'.repeat(40), {}, undefined, SOURCE.origin);
  const seed = (id: string, journal?: 'queue' | 'client' | 'unreadable') => {
    writeRun(store, withoutSource(validationRun(id, projectValidationCallerIdentity(task.id, HEAD), at)));
    emptyRunDirectory(f.stateDir, id);
    store.putHostRunOutputFailure(absentFailure(id, at));
    store.event(task.id, 'project_validation_scheduler_recorded', projectValidationSchedulerEvidence(id, 1, HEAD));
    if (journal === 'queue') store.appendHostRunJournal(id, 'request', { method: 'host.run.submit', runId: id }, at);
    if (journal === 'client') store.appendHostRunJournal(id, 'request', { method: 'host.run.client.submit', runId: id }, at);
    if (journal === 'unreadable')
      store.db.prepare('INSERT INTO host_run_journal(run_id,event,at,data) VALUES(?,?,?,?)').run(id, 'request', at, 'not json');
  };

  // The 2026-09-30..10-02 window wrote rows before `submissionSource` existed: the
  // journal's own submit request is the only positive proof left, and it is enough.
  seed('validation-source-queue', 'queue');
  // No journal at all (pruned, or never written) proves nothing.
  seed('validation-source-none');
  // The journal's client method refutes Queue's submission.
  seed('validation-source-client', 'client');
  // An unreadable journal is a stated reason, never an assumption.
  seed('validation-source-unreadable', 'unreadable');

  f.endpoint.sweepRetainedOutput();

  assert.equal(store.hostRunOutputFailure('validation-source-queue'), null, 'journal-proven Queue submission is accepted');
  assert.match(store.hostRunOutputFailure('validation-source-none')!.reason,
    /names no submission source and its journal records no Queue submission/);
  assert.match(store.hostRunOutputFailure('validation-source-client')!.reason,
    /names no submission source and its journal records no Queue submission/);
  assert.match(store.hostRunOutputFailure('validation-source-unreadable')!.reason,
    /submission source could not be read/);
  const evidence = hostRunOutputReclassificationLogSchema.parse(store.getMeta(HOST_RUN_OUTPUT_RECLASSIFICATIONS_META));
  assert.deepEqual(evidence.recent.map(entry => entry.runId), ['validation-source-queue']);
});
