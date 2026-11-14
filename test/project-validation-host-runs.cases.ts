import { createTaskAgent } from './support/fakes';
/** Contract 010 project-validation scheduling and worker liveness. */
import { buildConfiguredClone, materializeSeed, type GitSeed } from './support/git-seed';
import { test, weighted, weightedTiming } from './support/sharded-test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { command, git } from '../core/git/index';
import { Store, digest } from '../core/store/store';
import { Engine } from '../core/engine';
import { requestDisposition, type DispositionDeps } from '../core/verbs/disposition';
import { RepositoryHooks } from '../core/hooks/hooks';
import { HostRunScheduler, NO_HISTORY_CPU_SHARE, selectorForArgv } from '../core/host-runs/host-run-scheduler';
import { projectValidationSupervisorPaths, readProjectValidationPlan, readProjectValidationResult, readProjectValidationSupervisorState, writeProjectValidationPlan, writeProjectValidationResult, writeProjectValidationSupervisorState } from '../core/qa/project-validation-supervisor';
import { readHostRunTokenKeys } from '../service/callbacks/host-run-endpoint';
import { verifyRunToken } from "./host-run-token-fixture";
import { hostRunSettlementSchema, projectValidationResultSchema, submissionSchema, type Profile, type Task } from '../shared/contracts';
import { frozenHostRunRecordSchema } from './support/contract-010-frozen';
import { processGroupEmpty, processGroupHasStartIdentity, processStartIdentityLiveness, processesForStartIdentity } from '../core/machine/process-group';
import { telemetrySnapshotSchema } from '../shared/telemetry';
import type { Adapter } from '../core/host';
import { timingTest } from './support/timing';
import { HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, HOOK_TEST_TIMEOUT_MS, waitFor } from './support/budgets';
import { telemetrySnapshot } from '../core/telemetry/telemetry';

const timing = weightedTiming(timingTest);

const validationCommand = (script: string) => ({ argv: [process.execPath, '-e', script], timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096, terminationGraceMs: 30_000 });

const cancellationDeps = (hooks: RepositoryHooks): DispositionDeps => ({
  hooks: { emit: async () => ({ hold: false, attention: false, records: [] }),
    cancelProjectValidation: (task, reason) => hooks.cancelProjectValidation(task, reason) },
  observeAgent: async () => ({ stopped: true }), archiveAgent: async () => {}, archiveSiblings: async () => {},
  proveWorkspaceEmpty: async () => ({ empty: true, detail: 'test workspace is empty' }),
  proveRetainedByReplacement: async () => ({ retained: true, detail: 'replacement retains task work' }),
  archiveWorkspace: async () => true, observeWorkspaceArchived: async () => true,
  settleCancelledPr: async () => 'PR cancellation recorded by test',
});

const projectValidationSeed: GitSeed = { name: 'project-validation', build: async root => {
  await buildConfiguredClone(root);
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs/plan.json'), '{}\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');
  await git(repo, 'push', 'origin', 'main');
} };

/** A repository with a reviewed worker head: the plain project-validation shape. */
async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-project-validation-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await materializeSeed(projectValidationSeed, root);
  const repo = join(root, 'repo');
  const base = await git(repo, 'rev-parse', 'HEAD');
  const directory = join(root, 'task-worktree');
  await git(repo, 'worktree', 'add', '-b', 'ns-task', directory, base);
  await writeFile(join(directory, 'lane.txt'), 'lane change\n');
  await git(directory, 'add', '-A');
  await git(directory, 'commit', '-m', 'lane change');
  await git(directory, 'push', 'origin', 'ns-task');
  const head = await git(directory, 'rev-parse', 'HEAD');
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-project-validation-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new Store(join(storeDir, 'queue.sqlite'));
  const submitted = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Project validation scheduler', repoPath: repo, baseBranch: 'main',
    planningCommit: base, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', base);
  const task = store.update(submitted.id, {
    directory, branch: 'ns-task', workspaceId: 'task-ws', agentId: 'worker', runId: 'initial',
    prUrl: 'https://github.com/example/repo/pull/11', prHead: head, resumePrNumber: 11,
  });
  const hostRunStateDir = join(storeDir, 'host-run');
  await mkdir(hostRunStateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(hostRunStateDir, 'token.key'), JSON.stringify({ format: 'host.run.keys', version: 1,
    current: { epoch: 1, keyB64: Buffer.alloc(32, 0x52).toString('base64') } }), { mode: 0o600 });
  return { root, repo, directory, base, head, store, task, hostRunStateDir };
}

const grantIntegrationTurn = (store: Store, taskId: string) => {
  const task = store.task(taskId);
  return store.update(taskId, { phase: 'verifying', resolution: {
    ...task.resolution, integrationTurn: { sequence: 1, acceptedAt: new Date().toISOString() },
  } });
};

test('Queue validation records its host-run settlement and writes no legacy admission block', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const outcome = await hooks.projectValidationGate(task, f.head, validationCommand("process.stdout.write('caller='+process.env.EFFIGY_CALLER);process.exit(0)"));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(recorded.state, 'passed');
  assert.equal(recorded.outputTail, 'caller=undefined');
  assert.ok(recorded.processGroupId && recorded.processGroupId > 0);
  assert.match(recorded.leaderStartIdentity ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(recorded.terminationSignal, null);
  assert.equal(recorded.processGroupEmpty, true);
  assert.equal('admission' in recorded, false);
  assert.ok(recorded.hostRunId);
  const scheduled = scheduler.get(recorded.hostRunId!)!;
  assert.deepEqual(recorded.hostRunTelemetry, {
    queueWaitMs: Math.max(0, Date.parse(scheduled.admittedAt!) - Date.parse(scheduled.submittedAt)),
    wallMs: scheduled.wallMs, cpuMs: scheduled.cpuMs, outcome: scheduled.settlement?.outcome,
  });
  assert.equal(recorded.hostRunEpoch, 1);
  assert.equal(recorded.capacityUnavailable, false);
  assert.equal(recorded.capacityWait, null);
});

test('a half-removed owned candidate is rebuilt and project validation proceeds', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const candidatePath = await (hooks as any).prospectiveCandidatePath(task, { integrationBase: f.base, reviewedHead: f.head });
  const initial = await (hooks as any).buildProspectiveCandidate(task, candidatePath, f.base, f.head);
  assert.equal(initial.kind, 'built', JSON.stringify(initial));
  await writeFile(join(candidatePath, 'unrecognised-work'), 'keep this on a non-forced removal');
  await assert.rejects((hooks as any).removeIsolatedCheckout(task, candidatePath, false), /Queue-owned isolated repository is dirty/);
  await rm(join(candidatePath, 'unrecognised-work'));
  await rm(join(candidatePath, '.git'), { recursive: true, force: true });
  await mkdir(join(candidatePath, 'src'), { recursive: true });
  await writeFile(join(candidatePath, 'src', 'foreign.ts'), 'unrecognised candidate');
  await assert.rejects((hooks as any).removeIsolatedCheckout(task, candidatePath, false), /no recognized Git identity/);
  assert.equal(existsSync(join(candidatePath, 'src', 'foreign.ts')), true, 'non-forced removal preserves an unrecognised checkout');
  await rm(join(candidatePath, 'src'), { recursive: true, force: true });
  await mkdir(join(candidatePath, '.git', 'logs'), { recursive: true });
  await mkdir(join(candidatePath, 'src'), { recursive: true });
  await writeFile(join(candidatePath, 'src', 'partial.ts'), 'partial');
  await mkdir(join(candidatePath, 'node_modules', 'leftover'), { recursive: true });
  await writeFile(join(candidatePath, 'node_modules', 'leftover', 'package.json'), '{}');

  const rebuilt = await (hooks as any).buildProspectiveCandidate(task, candidatePath, f.base, f.head);
  assert.equal(rebuilt.kind, 'built', JSON.stringify(rebuilt));
  assert.equal(existsSync(join(candidatePath, 'src', 'partial.ts')), false);
  const outcome = await hooks.projectValidationGate(task, f.head, validationCommand("process.stdout.write('validation ran')"));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
});

weighted(2)('a service roll during candidate cleanup keeps the verdict and finishes removal on reattach', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const capacity = () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] });
  const before = new HostRunScheduler(f.store, { capacity });
  t.after(() => before.stop());
  const hooksBefore = new RepositoryHooks(f.store, { hostRuns: before });
  const launches = join(f.root, 'validation-launches');
  const validation = validationCommand(`require('node:fs').appendFileSync(${JSON.stringify(launches)}, 'run\\n')`);
  const remove = (hooksBefore as any).removeIsolatedCheckout.bind(hooksBefore);
  let interrupted = false;
  let candidatePath = '';
  (hooksBefore as any).removeIsolatedCheckout = async (owner: Task, path: string, force: boolean) => {
    const durable = f.store.task(task.id).resolution.projectValidation;
    if (!interrupted && durable?.state === 'passed' && durable.candidateCleanupPending === true) {
      interrupted = true;
      candidatePath = path;
      assert.equal(durable.state, 'passed', 'the verdict is durable before disposable candidate cleanup starts');
      assert.equal(durable.candidateCleanupPending, true, 'the cleanup intent survives a service roll');
      await rm(join(path, '.git'), { recursive: true, force: true });
      await mkdir(join(path, '.git', 'logs'), { recursive: true });
      await mkdir(join(path, 'src'), { recursive: true });
      await writeFile(join(path, 'src', 'partial.ts'), 'partial source');
      await mkdir(join(path, 'node_modules', 'leftover'), { recursive: true });
      await writeFile(join(path, 'node_modules', 'leftover', 'package.json'), '{}');
      throw new Error('simulated service roll interrupted candidate removal');
    }
    return remove(owner, path, force);
  };

  const first = await hooksBefore.projectValidationGate(task, f.head, validation);
  assert.equal(first.kind, 'ok', JSON.stringify(first));
  assert.equal(interrupted, true);
  assert.equal(existsSync(join(candidatePath, 'src', 'partial.ts')), true, 'the interrupted cleanup leaves the evidence-shaped half tree');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.candidateCleanupPending, true);

  before.stop();
  const after = new HostRunScheduler(f.store, { capacity });
  t.after(() => after.stop());
  const hooksAfter = new RepositoryHooks(f.store, { hostRuns: after });
  const durable = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(durable.state, 'passed');
  assert.equal(durable.candidateCleanupPending, true);
  const resumed = await hooksAfter.projectValidationGate(f.store.task(task.id), f.head, validation);
  assert.equal(resumed.kind, 'ok', JSON.stringify(resumed));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.candidateCleanupPending, false);
  assert.equal(existsSync(candidatePath), false, 'the restarted service finishes the forced removal');
  assert.equal((await readFile(launches, 'utf8')).trim().split('\n').length, 1, 'the durable verdict avoids a second validation run');
});

test('a settled validation for the prior PR head is recorded superseded before current-head validation', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  f.store.update(task.id, { resolution: { ...task.resolution, projectValidation: {
    argv: ['effigy', 'check'], digest: 'd'.repeat(64), exitCode: 1, durationMs: 12, outputTail: 'old-head failure',
    base: f.base, head: 'c'.repeat(40), state: 'refused', queueBuild: '', settingsRevision: 0, pid: null,
    capacityWait: null, capacityUnavailable: false,
  } } });
  const hooks = new RepositoryHooks(f.store, { hostRuns: new HostRunScheduler(f.store,
    { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) }) });
  const outcome = await hooks.projectValidationGate(f.store.task(task.id), f.head, validationCommand('process.stdout.write("new head")'));
  assert.equal(outcome.kind, 'ok');
  const superseded = f.store.events(task.id).findLast(event => event.kind === 'project_validation_superseded');
  assert.ok(superseded);
  const history = JSON.parse(superseded.detail) as { result: { head: string; state: string; outputTail: string }; supersededBy: string };
  assert.equal(history.result.head, 'c'.repeat(40));
  assert.equal(history.result.state, 'refused');
  assert.equal(history.result.outputTail, 'old-head failure');
  assert.equal(history.supersededBy, f.head);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.head, f.head);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
});

test('Queue project validation persists and redacts the contract token', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const marker = join(f.root, 'validation-environment.json');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({id:process.env.HOST_RUN_ID,token:process.env.HOST_RUN_TOKEN,cwd:fs.realpathSync(process.cwd())}));process.stdout.write(process.env.HOST_RUN_TOKEN);setTimeout(()=>{},1000)`;
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, hostRunStateDir: f.hostRunStateDir });
  const pending = hooks.projectValidationGate(task, f.head, validationCommand(script));
  await waitFor(() => existsSync(marker), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the validation command to expose its launch environment');
  const running = f.store.task(task.id).resolution.projectValidation!;
  const launched = scheduler.get(running.hostRunId!)!;
  const paths = projectValidationSupervisorPaths(dirname(f.store.path), launched.id);
  const plan = readProjectValidationPlan(paths.planPath)!;
  const environment = JSON.parse(await readFile(marker, 'utf8')) as { id: string; token: string; cwd: string };
  assert.equal(environment.id, launched.id);
  assert.equal(plan.hostRunToken, environment.token, 'the private launch plan retains the credential');
  assert.equal((await stat(paths.planPath)).mode & 0o777, 0o600);
  const keys = readHostRunTokenKeys(f.hostRunStateDir)!;
  const inside = verifyRunToken(environment.token, { keys, epoch: launched.epoch, cwd: environment.cwd });
  assert.equal(inside.valid, true);
  if (inside.valid) {
    assert.equal(inside.claims.runId, launched.id);
    assert.equal(inside.claims.class, launched.runClass);
    assert.equal(inside.claims.root, environment.cwd);
    assert.equal(inside.claims.exp, Date.parse(launched.launchedAt!) + launched.runTimeoutMs + 30_000);
  }
  assert.deepEqual(verifyRunToken(environment.token, { keys, epoch: launched.epoch, cwd: f.root }), { valid: false, reason: 'wrong_root' });
  const outcome = await pending;
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const record = f.store.task(task.id).resolution.projectValidation!;
  assert.doesNotMatch(record.outputTail, new RegExp(environment.token));
  assert.match(record.outputTail, /\[REDACTED\]/);
});

test('a capped validation failure keeps its beginning and its end in the durable finding', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  // Far more than the 4,096-byte cap, with a distinctive first and last line.
  const script = "process.stdout.write('VALIDATION-BEGIN\\n' + 'compile noise line\\n'.repeat(1200) + 'VALIDATION-END\\n');process.exit(4)";
  const outcome = await hooks.projectValidationGate(task, f.head, validationCommand(script));
  assert.equal(outcome.kind, 'refused', JSON.stringify(outcome));
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(recorded.state, 'refused');
  assert.ok(recorded.outputTail.length <= 2000, `the finding keeps its 2000-character bound, got ${recorded.outputTail.length}`);
  assert.match(recorded.outputTail, /^VALIDATION-BEGIN/, 'the beginning of a capped failure reaches the only durable finding');
  assert.match(recorded.outputTail, /VALIDATION-END\s*$/, 'the end of the failure is kept too');
  assert.match(recorded.outputTail, /\[queue: output truncated: observed=\d+ retained=\d+ omitted=\d+; beginning and end kept\]/,
    'the finding names the byte cap and never reads as complete output');
  assert.match(outcome.kind === 'refused' ? outcome.detail : '', /^VALIDATION-BEGIN/, 'the revision finding carries the beginning as well');
});

test('validation records measured process-tree CPU and that run feeds selector history', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const script = "const until=Date.now()+700;let n=0;while(Date.now()<until)n=(n+Math.random())%100000;process.stdout.write(String(Math.floor(n)))";
  const outcome = await hooks.projectValidationGate(task, f.head, validationCommand(script));
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  const run = scheduler.get(recorded.hostRunId!)!;
  assert.equal(run.state, 'settled');
  assert.ok(run.wallMs && run.wallMs > 0);
  // Tom, 2026-10-23, "Honest + cheaper": measured CPU, or explicitly unknown. Never 0.
  // The reason is Queue-internal (the scheduler's internal read); the row stays main's strict shape.
  const cpuCoverage = scheduler.cpuCoverage(run.id);
  const measured = typeof run.cpuMs === 'number' && run.cpuMs > 0 && cpuCoverage === 'sampled';
  const unknown = run.cpuMs === null && (cpuCoverage === 'unobserved' || cpuCoverage === 'unavailable');
  assert.ok(measured || unknown, `expected sampled CPU or an explicit unknown, got cpuMs=${run.cpuMs} cpuCoverage=${cpuCoverage}`);
  assert.equal(run.settlement?.result?.cpuMs, run.cpuMs);
  assert.equal(frozenHostRunRecordSchema.safeParse(run).success, true, 'the stored row parses as frozen Contract 010');
  assert.doesNotMatch(JSON.stringify(run), /cpuCoverage/);

  const historical = scheduler.submit({ id: 'validation-history-reader', epoch: 1, caller: 'test:history-reader',
    repository: run.repository, selector: recorded.selector!, runClass: 'light', classSource: 'default',
    priority: 'validation', runTimeoutMs: 60_000, budgetFallback: { cpu: 99, memoryBytes: 7_000_000_000 } }, {
    launch: candidate => { scheduler.markLaunched(candidate.id); },
  });
  if (measured) {
    assert.equal(historical.budget.source, 'history');
    assert.notEqual(historical.budget.cpu, historical.budgetFallback.cpu);
  } else {
    // No CPU sample, so the CPU budget is the no-history fallback (half the
    // CPU capacity, never above the declared envelope). `source` names the CPU
    // basis; the settled run's wall time still budgets the wall.
    t.diagnostic(`CPU was not measured (${cpuCoverage}); asserting the CPU fallback`);
    assert.equal(historical.budget.source, 'fallback');
    assert.equal(historical.budget.cpu, Math.min(99, Math.max(1, 8 * NO_HISTORY_CPU_SHARE)));
    assert.equal(historical.budget.wallMs, run.wallMs, 'the wall budget still comes from the settled run');
  }
});

test('a live validation stays reserved when Queue cannot persist observed process identity', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const validation = validationCommand("setTimeout(() => process.exit(0), 2500)");
  const realUpdate = f.store.update.bind(f.store);
  let injected = false;
  let processGroupId: number | null = null;
  (f.store as any).update = (...args: unknown[]) => {
    if (!injected && args[2] === 'project_validation_spawned') {
      injected = true;
      throw new Error('injected validation progress write failure');
    }
    return (realUpdate as (...values: unknown[]) => unknown)(...args);
  };
  t.after(() => {
    (f.store as any).update = realUpdate;
    if (processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* the run already exited */ } }
  });

  const outcome = await hooks.projectValidationGate(task, f.head, validation);
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  const hostRun = scheduler.get(recorded.hostRunId!)!;
  processGroupId = hostRun.processGroupId;
  const paths = projectValidationSupervisorPaths((hooks as any).isolationDataDir(), hostRun.id);
  assert.equal(injected, true, 'the observation progress write fault was injected');
  assert.equal(outcome.kind, 'hold', 'an observation fault holds this gate without settling the launched run');
  assert.equal(recorded.state, 'running');
  assert.equal(hostRun.state, 'running');
  assert.equal(hostRun.settlement, null);
  assert.ok(processGroupId && !processGroupEmpty(processGroupId), 'the validation process is still live');
  assert.ok(readProjectValidationResult(paths.resultPath, hostRun.id) === null, 'no result exists yet');

  (f.store as any).update = realUpdate;
  await waitFor(() => readProjectValidationResult(paths.resultPath, hostRun.id) !== null, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the supervisor result to be retained');
  const reconciled = await hooks.projectValidationGate(f.store.task(task.id), f.head, validation);
  assert.equal(reconciled.kind, 'ok', JSON.stringify(reconciled));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
  assert.equal(scheduler.get(hostRun.id)?.settlement?.outcome, 'passed');
});

weighted(2)('task cancellation stops a launched validation and settles it cancelled', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  let processGroupId: number | null = null;
  t.after(() => {
    if (processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* the task-owned validation group already exited */ } }
    scheduler.stop();
  });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const marker = join(f.root, 'validation-cancellation-heartbeat');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)}, 'started');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)}, '.'),25)`;
  const gate = hooks.projectValidationGate(task, f.head, validationCommand(script));
  await waitFor(() => {
    const record = f.store.task(task.id).resolution.projectValidation;
    const run = record?.hostRunId ? scheduler.get(record.hostRunId) : null;
    if (record?.state === 'running' && run?.state === 'running' && run.processGroupId && !processGroupEmpty(run.processGroupId))
      processGroupId = run.processGroupId;
    return Boolean(processGroupId);
  }, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the validation command to launch');
  await waitFor(() => existsSync(marker), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the validation command to write its startup marker');
  const cancelled = await requestDisposition(f.store, cancellationDeps(hooks), {
    taskId: task.id, version: f.store.task(task.id).version, action: 'cancel', reason: 'Stop launched validation',
  });
  await gate;

  const validation = f.store.task(task.id).resolution.projectValidation!;
  const run = scheduler.get(validation.hostRunId!)!;
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(validation.state, 'hold', 'cancelled validation cannot pass the task gate');
  assert.equal(run.state, 'settled');
  assert.equal(run.settlement?.outcome, 'cancelled');
  assert.equal(run.settlement?.launched, true);
  assert.equal(run.settlement?.result?.signal, 'SIGTERM');
  assert.equal(processGroupEmpty(run.processGroupId!), true, 'capacity settles only after the command group exits');
  const journal = f.store.hostRunJournal(run.id);
  const cancellationRequest = journal.findIndex(row => row.event === 'request' && (row.data as { method?: string }).method === 'host.run.cancel');
  const settlement = journal.findIndex(row => row.event === 'settlement');
  assert.ok(cancellationRequest >= 0, 'launched validation cancellation is durably journaled');
  assert.ok(cancellationRequest < settlement, 'the cancellation request precedes settlement');
  const afterCancellation = await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8')), afterCancellation,
    'the command stopped and could not write another progress marker');
});

weighted(2)('task cancellation after service reattachment reaches the detached validation supervisor', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const capacity = () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] });
  const originalScheduler = new HostRunScheduler(f.store, { capacity });
  let reattachedScheduler: HostRunScheduler | null = null;
  let processGroupId: number | null = null;
  t.after(() => {
    if (processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* the task-owned validation group already exited */ } }
    originalScheduler.stop();
    reattachedScheduler?.stop();
  });
  const originalHooks = new RepositoryHooks(f.store, { hostRuns: originalScheduler, validationPollMs: 25 });
  const marker = join(f.root, 'reattached-validation-heartbeat');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)}, 'started');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)}, '.'),25)`;
  const gate = originalHooks.projectValidationGate(task, f.head, validationCommand(script));
  await waitFor(() => {
    const record = f.store.task(task.id).resolution.projectValidation;
    const run = record?.hostRunId ? originalScheduler.get(record.hostRunId) : null;
    if (record?.state === 'running' && run?.state === 'running' && run.processGroupId && !processGroupEmpty(run.processGroupId))
      processGroupId = run.processGroupId;
    return Boolean(processGroupId);
  }, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the validation command to launch before service reattachment');
  await waitFor(() => existsSync(marker), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the reattached validation command to write its startup marker');

  originalScheduler.stop();
  reattachedScheduler = new HostRunScheduler(f.store, { capacity });
  const reattachedHooks = new RepositoryHooks(f.store, { hostRuns: reattachedScheduler, validationPollMs: 25 });
  const cancelled = await requestDisposition(f.store, cancellationDeps(reattachedHooks), {
    taskId: task.id, version: f.store.task(task.id).version, action: 'cancel', reason: 'Stop validation after Queue reattached',
  });
  await gate;

  const validation = f.store.task(task.id).resolution.projectValidation!;
  const run = reattachedScheduler.get(validation.hostRunId!)!;
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(validation.state, 'hold');
  assert.equal(run.settlement?.outcome, 'cancelled');
  assert.equal(run.settlement?.launched, true);
  assert.equal(processGroupEmpty(run.processGroupId!), true);
  const afterCancellation = await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8')), afterCancellation,
    'the reattached service stopped the original supervisor-owned process');
});

test('a proven-lost validation is held and never launched again automatically', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const marker = join(f.root, 'must-not-launch');
  const validation = validationCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`);
  const runId = randomUUID(), token = randomUUID(), pid = 2_147_483_647;
  const startedAt = new Date().toISOString();
  const selector = selectorForArgv(validation.argv, 'validation');
  const scheduled = scheduler.adoptRunning({ id: runId, epoch: 1, caller: `queue:validation:${task.id}:${f.head}`,
    repository: { origin: null, path: f.repo }, selector, runClass: 'light', classSource: 'default', priority: 'validation',
    runTimeoutMs: 60_000, launchedAt: startedAt, submittedAt: startedAt, pid });
  scheduler.updateProcess(runId, { pid, processGroupId: pid, startIdentity: `${pid}@missing` });
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution, projectValidation: {
    argv: validation.argv, digest: digest(JSON.stringify(validation.argv)), exitCode: null, durationMs: 0, outputTail: '', base: f.base, head: f.head,
    state: 'running', queueBuild: '', settingsRevision: 0, pid, hostRunId: runId, hostRunEpoch: 1, submittedAt: startedAt,
    selector, runTimeoutMs: 60_000, capacityDeadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    processGroupId: pid, leaderStartIdentity: token, capacityWait: null, capacityUnavailable: false,
  } } });
  assert.equal(scheduled.state, 'running');

  const outcome = await hooks.projectValidationGate(f.store.task(task.id), f.head, validation);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'hold');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.resubmissionRequired, true);
  assert.equal(scheduler.get(runId)?.settlement?.outcome, 'lost');
  assert.equal(await import('node:fs/promises').then(fs => fs.access(marker).then(() => true, () => false)), false);
  const changedValidation = validationCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'changed argv launched')`);
  const changedArgvOutcome = await hooks.projectValidationGate(f.store.task(task.id), f.head, changedValidation);
  assert.equal(changedArgvOutcome.kind, 'hold', JSON.stringify(changedArgvOutcome));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.hostRunId, runId,
    'changing argv does not authorize a new run for the same task, base and head');
  assert.equal(scheduler.list(100).filter(run => run.caller === `queue:validation:${task.id}:${f.head}`).length, 1,
    'the lost validation is not resubmitted with a new run ID');
  assert.equal(await import('node:fs/promises').then(fs => fs.access(marker).then(() => true, () => false)), false);
  const held = f.store.task(task.id).resolution.projectValidation!;
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution,
    projectValidation: { ...held, queueBuild: 'a-later-build', settingsRevision: held.settingsRevision + 1 } } });
  const repeated = await hooks.projectValidationGate(f.store.task(task.id), f.head, validation);
  assert.equal(repeated.kind, 'hold', JSON.stringify(repeated));
  assert.equal(await import('node:fs/promises').then(fs => fs.access(marker).then(() => true, () => false)), false);
});

weighted(2)('a durable validation result reconciles after Queue restarts without relaunching', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const marker = join(f.root, 'result-already-recorded');
  const validation = validationCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`);
  assert.equal((await hooks.projectValidationGate(task, f.head, validation)).kind, 'ok');
  const prior = f.store.task(task.id).resolution.projectValidation!;
  const originalRun = scheduler.get(prior.hostRunId!)!;
  assert.equal(originalRun.state, 'settled');
  const savedResult = originalRun.settlement!.result!;
  scheduler.stop();
  await rm(marker, { force: true });

  const candidatePath = await (hooks as any).prospectiveCandidatePath(task, prior.candidate);
  const rebuilt = await (hooks as any).buildProspectiveCandidate(task, candidatePath, f.base, f.head);
  assert.equal(rebuilt.kind, 'built', JSON.stringify(rebuilt));
  const identityToken = randomUUID();
  const paths = projectValidationSupervisorPaths((hooks as any).isolationDataDir(), prior.hostRunId!);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  writeProjectValidationPlan(paths.planPath, { format: 'queue.project-validation.plan', version: 1,
    runId: prior.hostRunId!, epoch: prior.hostRunEpoch!, runClass: 'heavy', identityToken, root: candidatePath, argv: validation.argv,
    timeoutMs: prior.runTimeoutMs!, maxOutputBytes: 4096, terminationGraceMs: 30_000,
    launchedAt: originalRun.launchedAt, statePath: paths.statePath, resultPath: paths.resultPath });
  writeProjectValidationResult(paths.resultPath, { format: 'queue.project-validation.result', version: 1,
    runId: prior.hostRunId!, epoch: prior.hostRunEpoch!, identityToken, state: 'passed', exitCode: 0,
    durationMs: savedResult.wallMs, outputTail: '', timedOut: false, signal: null, pid: originalRun.pid,
    processGroupId: savedResult.pgid, leaderStartIdentity: identityToken, processGroupEmpty: true,
    terminationError: null, hostResult: savedResult, startedAt: savedResult.startedAt, endedAt: savedResult.endedAt });
  f.store.putHostRun({ ...originalRun, state: 'running', settlement: null, settledAt: null,
    capacityReleasedAt: null, capacityReleaseReason: null, capacityReleaseKind: null, wallMs: null, cpuMs: null });
  f.store.update(task.id, { resolution: { ...f.store.task(task.id).resolution,
    projectValidation: { ...prior, state: 'running', exitCode: null, durationMs: 0, outputTail: '', pid: originalRun.pid,
      processGroupId: null, leaderStartIdentity: identityToken, capacityWait: null, capacityUnavailable: false } } });

  assert.equal(existsSync(candidatePath), true, 'the service roll leaves the candidate intact before result reconciliation');

  const restartedScheduler = new HostRunScheduler(f.store,
    { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => restartedScheduler.stop());
  const restartedHooks = new RepositoryHooks(f.store, { hostRuns: restartedScheduler });
  const reconciled = await restartedHooks.projectValidationGate(f.store.task(task.id), f.head, validation);
  assert.equal(reconciled.kind, 'ok', JSON.stringify(reconciled));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
  assert.equal(restartedScheduler.get(prior.hostRunId!)?.settlement?.outcome, 'passed');
  assert.equal(await import('node:fs/promises').then(fs => fs.access(marker).then(() => true, () => false)), false);
});

/**
 * Arm one project-validation run whose authentic result is held back until the
 * observation interval republishes it.
 *
 * The real detached supervisor executes the command once and publishes its own
 * result envelope; the test then removes that envelope and adopts the same run,
 * so an observation opens with an absent-result read and a later publication can
 * land after that read but before the supervisor exit is proven.
 */
async function armPublicationInterval(f: Awaited<ReturnType<typeof fixture>>, hooks: RepositoryHooks,
  scheduler: HostRunScheduler, options: { exitCode: number; state: 'passed' | 'refused' }) {
  const task = f.store.task(f.task.id);
  const marker = join(f.root, `validation-launches-${options.state}`);
  const argv = [process.execPath, '-e',
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'launch\\n');process.exit(${options.exitCode})`];
  const launches = async () => existsSync(marker) ? (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length : 0;
  const candidatePath = await (hooks as any).prospectiveCandidatePath(task, { integrationBase: f.base, reviewedHead: f.head });
  const built = await (hooks as any).buildProspectiveCandidate(task, candidatePath, f.base, f.head);
  assert.equal(built.kind, 'built', JSON.stringify(built));
  const runId = randomUUID(), epoch = 1, identityToken = randomUUID();
  const paths = projectValidationSupervisorPaths((hooks as any).isolationDataDir(), runId);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const launchedAt = new Date().toISOString();
  writeProjectValidationPlan(paths.planPath, { format: 'queue.project-validation.plan', version: 1, runId, epoch,
    runClass: 'heavy', hostRunStateDir: f.hostRunStateDir, identityToken, root: candidatePath, argv,
    timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096, terminationGraceMs: 30_000, launchedAt,
    statePath: paths.statePath, resultPath: paths.resultPath });
  const supervisor = spawn(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../bin/queue-validation-supervisor.mjs', import.meta.url)), paths.planPath, identityToken],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });
  const supervisorExit = await new Promise<number | null>((resolve, reject) => {
    supervisor.on('error', reject);
    supervisor.on('exit', code => resolve(code));
  });
  assert.equal(supervisorExit, 0, 'the detached supervisor published its result and exited');
  const authentic = readProjectValidationResult(paths.resultPath, runId);
  assert.ok(authentic, 'the real supervisor published its result envelope');
  assert.equal(authentic.runId, runId);
  assert.equal(authentic.epoch, epoch);
  assert.equal(authentic.identityToken, identityToken);
  assert.equal(authentic.state, options.state, 'the published result names the real command outcome');
  assert.equal(authentic.exitCode, options.exitCode);
  assert.ok(authentic.hostResult, 'the published result carries the real host result');
  const supervisorState = readProjectValidationSupervisorState(paths.statePath);
  assert.ok(supervisorState?.activeProcess, 'the supervisor recorded its command process identity');
  assert.throws(() => process.kill(supervisorState.supervisorPid, 0), { code: 'ESRCH' },
    'the producer is proven exited before the observation runs');
  assert.equal(processesForStartIdentity(identityToken).state, 'absent', 'no command process carries the identity');
  assert.equal(processGroupEmpty(supervisorState.activeProcess.processGroupId), true, 'the command group is proven empty');
  assert.equal(await launches(), 1, 'the command ran exactly once');

  await rm(paths.resultPath);
  assert.equal(readProjectValidationResult(paths.resultPath, runId), null, 'the interval opens with an absent result read');
  scheduler.adoptRunning({ id: runId, epoch, caller: `queue:validation:${f.task.id}:${f.head}`,
    repository: { origin: null, path: f.repo }, selector: selectorForArgv(argv, 'validation'), runClass: 'heavy',
    classSource: 'default', priority: 'validation', runTimeoutMs: HOOK_TEST_TIMEOUT_MS, launchedAt, submittedAt: launchedAt,
    pid: authentic.pid });
  scheduler.updateProcess(runId, { pid: authentic.pid!, processGroupId: authentic.processGroupId,
    startIdentity: authentic.hostResult!.startIdentity });
  f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, projectValidation: {
    argv, digest: digest(JSON.stringify(argv)), exitCode: null, durationMs: 0, outputTail: '', base: f.base, head: f.head,
    candidate: built.candidate, state: 'running', queueBuild: (hooks as any).queueBuild(), settingsRevision: 0,
    pid: null, hostRunId: runId, hostRunEpoch: epoch, submittedAt: launchedAt,
    selector: selectorForArgv(argv, 'validation'), runTimeoutMs: HOOK_TEST_TIMEOUT_MS,
    capacityDeadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(), terminationGraceMs: 30_000,
    capacityWait: null, capacityUnavailable: false, resubmissionRequired: false } } },
  'project_validation_intent', digest(JSON.stringify(argv)));
  // The helper draws no cleanup duty for the authentic command's numeric group: it
  // already proved that group exited, and a later signal would only reach whatever
  // process now holds that group id.
  return { paths, authentic, supervisorState, launches, identityToken, epoch, runId,
    validation: { argv, timeoutMs: HOOK_TEST_TIMEOUT_MS, maxOutputBytes: 4096, terminationGraceMs: 30_000 } };
}

/**
 * Reconcile, publishing inside the observation's own process-identity step: after the
 * absent-result read, before the supervisor liveness and process-group exit proofs.
 */
async function reconcileWithIntervalPublication(t: any, f: Awaited<ReturnType<typeof fixture>>,
  publish: () => void, run: () => Promise<{ kind: string; detail?: string }>) {
  const realUpdate = f.store.update.bind(f.store);
  let published = false;
  (f.store as any).update = (...args: unknown[]) => {
    if (!published && args[2] === 'project_validation_spawned') { published = true; publish(); }
    return (realUpdate as (...values: unknown[]) => unknown)(...args);
  };
  t.after(() => { (f.store as any).update = realUpdate; });
  let outcome: { kind: string; detail?: string };
  try { outcome = await run(); }
  finally { (f.store as any).update = realUpdate; }
  return { outcome, published };
}

weighted(2)('a result published between the absent-result read and the proven exit settles once from its durable result',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  for (const scenario of [{ exitCode: 0, state: 'passed' as const, outcome: 'ok', settlement: 'passed' },
    { exitCode: 1, state: 'refused' as const, outcome: 'refused', settlement: 'failed' }]) {
    const f = await fixture(t);
    t.after(() => f.store.close());
    const task = grantIntegrationTurn(f.store, f.task.id);
    const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
    t.after(() => scheduler.stop());
    const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
    const armed = await armPublicationInterval(f, hooks, scheduler, scenario);

    const { outcome, published } = await reconcileWithIntervalPublication(t, f,
      () => writeProjectValidationResult(armed.paths.resultPath, armed.authentic),
      () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
    assert.equal(published, true, 'publication landed after the absent-result read and before the exit proof');
    assert.equal(outcome.kind, scenario.outcome, JSON.stringify(outcome));
    const record = f.store.task(task.id).resolution.projectValidation!;
    assert.equal(record.state, scenario.state, 'the actual result, not a lost run, is recorded');
    assert.equal(record.exitCode, scenario.exitCode);
    assert.equal(record.resubmissionRequired, false);
    assert.equal(record.processGroupEmpty, true);
    const run = scheduler.get(record.hostRunId!)!;
    assert.equal(run.state, 'settled');
    assert.equal(run.settlement?.outcome, scenario.settlement, 'one host settlement from the real result');
    assert.equal(run.settlement?.result?.runId, run.id);
    assert.equal(run.settlement?.result?.exitCode, scenario.exitCode);
    assert.equal(await armed.launches(), 1, 'the authenticated command is never launched again');
    const journal = f.store.hostRunJournal(run.id);
    assert.equal(journal.filter(row => row.event === 'launch').length, 1);
    assert.equal(journal.filter(row => row.event === 'settlement').length, 1, 'no duplicate host accounting');
    assert.equal(existsSync(armed.paths.root), false, 'the durable task record replaced the private run files');

    const repeated = await hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation);
    assert.equal(repeated.kind, scenario.outcome, 'a repeated reconciliation converges on the same result');
    assert.equal(await armed.launches(), 1, 'the repeated reconciliation executes no workload');
    assert.equal(f.store.hostRunJournal(run.id).filter(row => row.event === 'settlement').length, 1,
      'the repeated reconciliation duplicates no accounting');
  }
});

weighted(2)('a result published inside the exit interval cannot settle while the command group is live',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });
  const ready = join(f.root, 'live-validation-group');
  const holder = spawn(process.execPath, ['-e',
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(() => {}, 1000)`],
  { detached: true, stdio: 'ignore' });
  holder.unref();
  t.after(() => { try { process.kill(-holder.pid!, 'SIGKILL'); } catch { /* the group already exited */ } });
  await waitFor(() => existsSync(ready), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the live command group to start');
  writeProjectValidationSupervisorState(armed.paths.statePath, { ...armed.supervisorState!,
    activeProcess: { ...armed.supervisorState!.activeProcess!, pid: holder.pid!, processGroupId: holder.pid! } });

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, armed.authentic),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /process group was proven empty/, 'live custody is preserved');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running');
  const run = scheduler.get(f.store.task(task.id).resolution.projectValidation!.hostRunId!)!;
  assert.equal(run.state, 'running');
  assert.equal(run.settlement, null, 'no settlement is fabricated from a result');
  assert.ok(readProjectValidationResult(armed.paths.resultPath), 'the result stays retained as evidence');
  assert.equal(await armed.launches(), 1);
});

weighted(2)('a mismatched result published inside the exit interval is refused without settlement',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, { ...armed.authentic, epoch: armed.authentic.epoch + 1 }),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /identity does not match its durable plan/);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running');
  const run = scheduler.get(f.store.task(task.id).resolution.projectValidation!.hostRunId!)!;
  assert.equal(run.state, 'running');
  assert.equal(run.settlement, null, 'mismatched identity authorises no settlement');
  assert.equal(await armed.launches(), 1);
});

weighted(2)('an unreadable result published inside the exit interval keeps the lost disposition',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeFileSync(armed.paths.resultPath, '{"format":"queue.project-validation.result",', { mode: 0o600 }),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  const record = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(record.state, 'hold');
  assert.equal(record.resubmissionRequired, true, 'an unreadable result is a genuinely lost run, never a pass');
  const run = scheduler.get(record.hostRunId!)!;
  assert.equal(run.state, 'settled');
  assert.equal(run.settlement?.outcome, 'lost', 'no outcome is invented from an unreadable result');
  assert.equal(run.settlement?.result, null);
  const repeated = await hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation);
  assert.equal(repeated.kind, 'hold');
  assert.equal(await armed.launches(), 1, 'a lost run is never replayed automatically');
  assert.equal(f.store.hostRunJournal(run.id).filter(row => row.event === 'settlement').length, 1);
});

weighted(2)('a result published inside the exit interval waits for its live supervisor and then settles once',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });
  // A live producer identity: the run's token is in a live process's own argv.
  const producer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', armed.identityToken], { stdio: 'ignore' });
  t.after(() => { try { producer.kill('SIGKILL'); } catch { /* it already exited */ } });
  const producerExit = new Promise(resolve => producer.on('exit', resolve));
  writeProjectValidationSupervisorState(armed.paths.statePath, { ...armed.supervisorState!, supervisorPid: producer.pid! });

  const gate = reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, armed.authentic),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  await waitFor(() => existsSync(armed.paths.resultPath), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the result to be published inside the interval');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running', 'a live producer is not a settled run');
  assert.equal(scheduler.get(armed.runId)?.settlement, null, 'the published result settles nothing while its producer is live');

  producer.kill('SIGKILL');
  await producerExit;
  const { outcome, published } = await gate;
  assert.equal(published, true);
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'passed');
  assert.equal(scheduler.get(armed.runId)?.settlement?.outcome, 'passed');
  assert.equal(await armed.launches(), 1, 'the command is never launched again');
});

weighted(2)('a result published inside the exit interval holds while the producer identity is unreadable',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });
  const producer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', armed.identityToken], { stdio: 'ignore' });
  t.after(() => { try { producer.kill('SIGKILL'); } catch { /* it already exited */ } });
  writeProjectValidationSupervisorState(armed.paths.statePath, { ...armed.supervisorState!, supervisorPid: producer.pid! });
  // A host whose process table cannot be read: the identity is unknown, never dead.
  const noHostTools = join(f.root, 'no-host-tools');
  await mkdir(noHostTools, { recursive: true });
  const priorPath = process.env.PATH;
  t.after(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; });

  let publication = 0;
  let outcome: { kind: string; detail?: string };
  try {
    const settled = await reconcileWithIntervalPublication(t, f,
      () => { writeProjectValidationResult(armed.paths.resultPath, armed.authentic); publication += 1; process.env.PATH = noHostTools; },
      () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
    outcome = settled.outcome;
    assert.equal(settled.published, true);
  } finally { process.env.PATH = priorPath; }
  assert.equal(publication, 1, 'the result was published inside the interval');
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /supervisor identity could not be read/);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running');
  assert.equal(scheduler.get(armed.runId)?.settlement, null, 'an unreadable producer identity is not death');
  assert.ok(readProjectValidationResult(armed.paths.resultPath), 'the result stays retained as evidence');
  assert.equal(await armed.launches(), 1);
});

weighted(2)('a result published inside the exit interval holds while an identity-bearing process remains live',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });
  // One process carrying the run's inherited identity outlives the recorded group.
  const ready = join(f.root, 'escaped-identity-process');
  const escaped = spawn(process.execPath, ['-e',
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setInterval(() => {}, 1000)`],
  { detached: true, stdio: 'ignore', env: { ...process.env, NORTHSTAR_QUEUE_PROCESS_START_IDENTITY: armed.identityToken } });
  escaped.unref();
  t.after(() => { try { process.kill(-escaped.pid!, 'SIGKILL'); } catch { /* the owned group already exited */ } });
  await waitFor(() => existsSync(ready), HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the identity-bearing process to start');
  // The supervisor itself is proven dead; only the remaining tree is still live.
  writeProjectValidationSupervisorState(armed.paths.statePath, { ...armed.supervisorState!, supervisorPid: 2_147_483_647 });

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, armed.authentic),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /process tree remains live/);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running');
  assert.equal(scheduler.get(armed.runId)?.settlement, null, 'a live remaining tree is never released by a result');
  assert.ok(readProjectValidationResult(armed.paths.resultPath), 'the result stays retained as evidence');
  assert.equal(await armed.launches(), 1);
});

weighted(2)('a result whose identity token alone mismatches holds without settlement',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, { ...armed.authentic, identityToken: randomUUID() }),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true);
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /identity does not match its durable plan/);
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running');
  assert.equal(scheduler.get(armed.runId)?.settlement, null, 'a token-only mismatch authorises no settlement');
  assert.equal(await armed.launches(), 1);
});

// A row naming another run is not this run's result. The reader refuses it, so the
// observation sees no result at all and keeps the pre-existing lost disposition;
// the brief names this case beside an epoch or token mismatch, whose disposition is
// the identity refusal above, so the two are asserted apart rather than merged.
weighted(2)('a result from another run published inside the exit interval settles lost for explicit resubmission',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  t.after(() => scheduler.stop());
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooks, scheduler, { exitCode: 0, state: 'passed' });
  const otherRunId = randomUUID();
  assert.notEqual(otherRunId, armed.runId, 'the published row names a different run');

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, { ...armed.authentic, runId: otherRunId }),
    () => hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true, 'the other run\'s result was published inside the interval');
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  assert.match(outcome.detail ?? '', /ended without a durable result/, 'another run\'s row never becomes this run\'s outcome');
  const record = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(record.state, 'hold');
  assert.equal(record.resubmissionRequired, true, 'a refused row leaves the run lost and explicitly resubmittable');
  assert.equal(record.exitCode, null);
  const run = scheduler.get(record.hostRunId!)!;
  assert.equal(run.state, 'settled');
  assert.equal(run.settlement?.outcome, 'lost', 'no outcome is credited from another run\'s result');
  assert.equal(run.settlement?.result, null);
  assert.equal(await armed.launches(), 1, 'the command is never launched again');
  const repeated = await hooks.projectValidationGate(f.store.task(task.id), f.head, armed.validation);
  assert.equal(repeated.kind, 'hold');
  assert.equal(await armed.launches(), 1, 'a lost run is never replayed automatically');
  assert.equal(f.store.hostRunJournal(run.id).filter(row => row.event === 'settlement').length, 1);
});

weighted(3)('a live validation supervisor with a stale heartbeat is terminated and settles lost', { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] }) });
  let activeProcessGroupId: number | null = null;
  let supervisorPid: number | null = null;
  let supervisorStartIdentity: string | null = null;
  let identityToken: string | null = null;
  t.after(() => {
    if (activeProcessGroupId && identityToken && processGroupHasStartIdentity(activeProcessGroupId, identityToken)) {
      try { process.kill(-activeProcessGroupId, 'SIGKILL'); } catch { /* the validation group is already gone */ }
    }
    if (supervisorPid && supervisorStartIdentity
        && processStartIdentityLiveness(supervisorPid, supervisorStartIdentity) === 'alive') {
      try { process.kill(supervisorPid, 'SIGCONT'); } catch { /* the supervisor is already gone */ }
      try { process.kill(supervisorPid, 'SIGKILL'); } catch { /* the supervisor is already gone */ }
    }
    scheduler.stop();
  });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler, validationPollMs: 25 });
  const gate = hooks.projectValidationGate(task, f.head, validationCommand('setInterval(() => {}, 1000)'));
  await waitFor(() => {
    const record = f.store.task(task.id).resolution.projectValidation;
    const run = record?.hostRunId ? scheduler.get(record.hostRunId) : null;
    if (record?.state === 'running' && run?.state === 'running' && run.processGroupId && !processGroupEmpty(run.processGroupId))
      activeProcessGroupId = run.processGroupId;
    return Boolean(record?.hostRunId && activeProcessGroupId);
  }, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the validation command to launch');
  const hostRunId = f.store.task(task.id).resolution.projectValidation!.hostRunId!;
  const paths = projectValidationSupervisorPaths((hooks as any).isolationDataDir(), hostRunId);
  await waitFor(() => {
    const state = readProjectValidationSupervisorState(paths.statePath);
    if (state?.activeProcess && state.supervisorStartIdentity) {
      activeProcessGroupId = state.activeProcess.processGroupId;
      supervisorPid = state.supervisorPid;
      return true;
    }
    return false;
  }, HOST_RUN_FIXTURE_EVENT_TIMEOUT_MS, 'the supervisor to publish its process identities');
  const state = readProjectValidationSupervisorState(paths.statePath)!;
  assert.ok(state.supervisorStartIdentity, 'the supervisor records its OS start identity');
  assert.ok(state.activeProcess, 'the supervisor records the validation process group');
  supervisorStartIdentity = state.supervisorStartIdentity;
  identityToken = state.identityToken;
  process.kill(state.supervisorPid, 'SIGSTOP');
  writeProjectValidationSupervisorState(paths.statePath, { ...state, heartbeatAt: new Date(Date.now() - 240_000).toISOString() });

  const outcome = await gate;
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  const record = f.store.task(task.id).resolution.projectValidation!;
  const run = scheduler.get(hostRunId)!;
  assert.equal(record.state, 'hold');
  assert.equal(record.resubmissionRequired, true);
  assert.match(record.outputTail, /heartbeat was stale/i);
  assert.match(record.outputTail, /stale for .* unchanged across checks 5000ms apart/i);
  assert.equal(run.state, 'settled');
  assert.equal(run.settlement?.outcome, 'lost');
  assert.equal(processGroupEmpty(state.activeProcess.processGroupId), true, 'the validation process group is stopped');
  assert.throws(() => process.kill(state.supervisorPid, 0), { code: 'ESRCH' }, 'the stale supervisor is stopped');
});

weighted(4)('a service restart reconciles the same interval result and settles it once',
  { timeout: HOOK_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const capacity = () => ({ cpuCapacity: 8, memoryCapacityBytes: 8_000_000_000, freeMemoryBytes: 8_000_000_000, loadAverage: [] });
  const before = new HostRunScheduler(f.store, { capacity });
  t.after(() => before.stop());
  const hooksBefore = new RepositoryHooks(f.store, { hostRuns: before, validationPollMs: 25 });
  const armed = await armPublicationInterval(f, hooksBefore, before, { exitCode: 0, state: 'passed' });

  // The drafting service instance stops; a fresh one reattaches the same run row.
  before.stop();
  const after = new HostRunScheduler(f.store, { capacity });
  t.after(() => after.stop());
  const hooksAfter = new RepositoryHooks(f.store, { hostRuns: after, validationPollMs: 25 });
  assert.equal((hooksAfter as any).isolationDataDir(), (hooksBefore as any).isolationDataDir(),
    'the restarted service reads the same durable run directory');

  const { outcome, published } = await reconcileWithIntervalPublication(t, f,
    () => writeProjectValidationResult(armed.paths.resultPath, armed.authentic),
    () => hooksAfter.projectValidationGate(f.store.task(task.id), f.head, armed.validation));
  assert.equal(published, true, 'publication landed inside the restarted observation');
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  const record = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(record.state, 'passed');
  assert.equal(record.hostRunId, armed.runId);
  assert.equal(after.get(record.hostRunId!)?.settlement?.outcome, 'passed', 'the restarted instance owns the settlement');
  assert.equal(await armed.launches(), 1, 'the restarted observation executes no workload');
  const journal = f.store.hostRunJournal(record.hostRunId!);
  assert.equal(journal.filter(row => row.event === 'launch').length, 1);
  assert.equal(journal.filter(row => row.event === 'settlement').length, 1, 'one host settlement across the restart');

  // The pre-restart and post-restart instances converge on the same authentic result.
  assert.equal((await hooksBefore.projectValidationGate(f.store.task(task.id), f.head, armed.validation)).kind, 'ok');
  assert.equal((await hooksAfter.projectValidationGate(f.store.task(task.id), f.head, armed.validation)).kind, 'ok');
  assert.equal(await armed.launches(), 1, 'no repeated reconciliation launches the workload');
  assert.equal(f.store.hostRunJournal(record.hostRunId!).filter(row => row.event === 'settlement').length, 1,
    'no repeated reconciliation duplicates host accounting');
});

test('Queue host scheduler owns the validation wait position and clears it after admission', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] }) });
  const submittedAt = new Date().toISOString();
  scheduler.adoptRunning({ id: 'blocking-run', epoch: 1, caller: 'test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    launchedAt: submittedAt, pid: process.pid, submittedAt });
  const hooks = new RepositoryHooks(f.store, {
    hostRuns: scheduler,
  });
  const gatePromise = hooks.projectValidationGate(task, f.head, validationCommand("setTimeout(()=>process.exit(0),400)"));
  await waitFor(() => f.store.task(task.id).reason === 'Waiting for QA capacity (position 1)', 8_000, 'the capacity wait to show on the task');
  await waitFor(() => f.store.task(task.id).resolution.projectValidation?.capacityWait?.position === 1, 8_000, 'the recorded capacity wait');
  assert.equal(f.store.task(task.id).resolution.projectValidation?.state, 'running', 'waiting for capacity is not a failure or a stall');
  scheduler.settle('blocking-run', hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: 'blocking-run',
    outcome: 'lost', launched: true, settledAt: new Date().toISOString(), result: null, containers: [] }));
  await gatePromise;
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(recorded.state, 'passed', JSON.stringify(recorded));
  assert.equal(recorded.capacityWait, null, 'the transient wait clears at settle');
  assert.equal(recorded.capacityUnavailable, false);
  assert.equal(recorded.hostRunTelemetry?.outcome, 'passed');
  assert.equal(typeof recorded.hostRunTelemetry?.queueWaitMs, 'number');
  assert.ok(f.store.events(task.id).some(event => event.kind === 'project_validation_capacity_wait' && event.detail === '1'));
});

test('a task cancellation fence settled before admission prevents queued validation from launching', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] }) });
  const submittedAt = new Date().toISOString();
  scheduler.adoptRunning({ id: 'validation-cancel-blocker', epoch: 1, caller: 'test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    launchedAt: submittedAt, pid: process.pid, submittedAt });
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const marker = join(f.root, 'validation-must-not-launch-after-cancel');
  const gatePromise = hooks.projectValidationGate(task, f.head, validationCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`));
  await waitFor(() => f.store.task(task.id).resolution.projectValidation?.capacityWait?.position === 1,
    8_000, 'project validation to queue behind the blocker');

  const cancelled = await requestDisposition(f.store, cancellationDeps(hooks), {
    taskId: task.id, version: f.store.task(task.id).version, action: 'cancel', reason: 'Cancel queued validation',
  });
  scheduler.settle('validation-cancel-blocker', hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1,
    runId: 'validation-cancel-blocker', outcome: 'lost', launched: true, settledAt: new Date().toISOString(), result: null, containers: [] }));
  const outcome = await gatePromise;

  const validation = f.store.task(task.id).resolution.projectValidation!;
  const hostRun = scheduler.get(validation.hostRunId!)!;
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(outcome.kind, 'hold');
  assert.equal(validation.state, 'hold');
  assert.equal(hostRun.settlement?.outcome, 'cancelled');
  assert.equal(hostRun.settlement?.launched, false);
  const journal = f.store.hostRunJournal(hostRun.id);
  assert.equal(journal.some(row => row.event === 'launch'), false);
  const cancellationRequest = journal.findIndex(row => row.event === 'request' && (row.data as { method?: string }).method === 'host.run.cancel');
  assert.ok(cancellationRequest >= 0);
  assert.ok(cancellationRequest < journal.findIndex(row => row.event === 'settlement'));
  assert.equal(await import('node:fs/promises').then(fs => fs.access(marker).then(() => true, () => false)), false);
});

test('client runs queued then running in Queue keep the worker alive without spawning an admission query', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] }) });
  const submittedAt = new Date().toISOString();
  scheduler.adoptRunning({ id: 'liveness-blocker', epoch: 1, caller: 'queue:test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1000 }, launchedAt: submittedAt, pid: process.pid, submittedAt });
  const queued = scheduler.submit({ id: 'client-liveness-run', epoch: 1, submissionSource: 'client', caller: 'effigy:test-worker',
    repository: { origin: null, path: f.directory }, selector: 'qa', runClass: 'heavy', classSource: 'default',
    priority: 'interactive', runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 1000 }, submittedAt }, { launch: () => {} });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.position, 1);

  const effigyStub = join(f.root, 'effigy');
  const invocations = join(f.root, 'effigy-admission-invocations.txt');
  await writeFile(effigyStub, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$EFFIGY_INVOCATIONS"\nexit 0\n', { mode: 0o755 });
  await chmod(effigyStub, 0o755);
  const previousEffigy = process.env.EFFIGY, previousInvocations = process.env.EFFIGY_INVOCATIONS;
  process.env.EFFIGY = effigyStub;
  process.env.EFFIGY_INVOCATIONS = invocations;
  try {
    const engine = new Engine(f.store, idleAdapterFor(f.store), 0);
    engine.hooks.options.hostRuns = scheduler;
    f.store.setMeta('paused', false);
    const working = f.store.update(f.task.id, { phase: 'working', idleSince: '2026-09-28T10:00:00.000Z' });
    assert.equal(await engine.resolution.heavyRunAlive(working), true);
    assert.equal(f.store.task(working.id).reason, 'Waiting for QA capacity (position 1)');
    await engine.wake();
    const alive = f.store.task(working.id);
    assert.equal(alive.resolution.incident, null, 'no missing-callback incident while the client run is queued');
    assert.equal(alive.reason, 'Waiting for QA capacity (position 1)');

    scheduler.settle('liveness-blocker', hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1,
      runId: 'liveness-blocker', outcome: 'lost', launched: true, settledAt: new Date().toISOString(), result: null, containers: [] }));
    await waitFor(() => scheduler.get(queued.id)?.state === 'admitted', 8_000, 'the client run to be admitted');
    scheduler.markLaunched(queued.id);
    await engine.wake();
    const running = f.store.task(working.id);
    assert.equal(running.resolution.incident, null, 'no missing-callback incident while the client run is running');
    assert.equal(running.reason, "Worker's QA run is running under Nucleus's scheduler");
  } finally {
    if (previousEffigy === undefined) delete process.env.EFFIGY; else process.env.EFFIGY = previousEffigy;
    if (previousInvocations === undefined) delete process.env.EFFIGY_INVOCATIONS; else process.env.EFFIGY_INVOCATIONS = previousInvocations;
  }
  assert.equal(existsSync(invocations), false, 'Queue never spawns effigy admission queries');
});

// A 100 ms capacity deadline settled through scheduler timers is a wall-clock
// oracle: under the parallel suite's load it measured starvation, so it runs alone.
timing(1)('Queue scheduler capacity_timeout becomes a typed hold with scheduler telemetry', {}, async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store, {
    capacityDeadlineMs: 100,
    capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] }),
  });
  const submittedAt = new Date().toISOString();
  scheduler.adoptRunning({ id: 'capacity-timeout-blocker', epoch: 1, caller: 'queue:test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    budgetFallback: { cpu: 1, memoryBytes: 1000 }, launchedAt: submittedAt, pid: process.pid, submittedAt });
  const marker = join(f.root, 'capacity-timeout-command-launched');
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const pending = hooks.projectValidationGate(task, f.head, validationCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`));
  await waitFor(() => {
    const runId = f.store.task(task.id).resolution.projectValidation?.hostRunId;
    return Boolean(runId && scheduler.get(runId)?.settlement?.outcome === 'capacity_timeout');
  }, 8_000, 'Queue to settle the capacity deadline');
  const outcome = await pending;
  assert.equal(outcome.kind, 'hold', JSON.stringify(outcome));
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  const settledRun = scheduler.get(recorded.hostRunId!)!;
  assert.equal(recorded.state, 'hold');
  assert.equal(recorded.capacityUnavailable, true);
  assert.equal(recorded.exitCode, null);
  assert.match(recorded.outputTail, /capacity deadline/i);
  assert.deepEqual(recorded.hostRunTelemetry, {
    queueWaitMs: Date.parse(settledRun.settledAt!) - Date.parse(settledRun.submittedAt),
    wallMs: settledRun.wallMs, cpuMs: settledRun.cpuMs, outcome: 'capacity_timeout',
  });
  assert.equal(existsSync(marker), false, 'a timed-out queued validation never launches');
  assert.equal(f.store.task(task.id).resolution.revisionRuns, 0, 'a capacity hold never spends a revision round');
});

test('an operator retry clears the capacity hold so the validation actually runs again', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const held = { argv: ['effigy', 'qa'], digest: 'd'.repeat(64), exitCode: null, durationMs: 0, outputTail: 'QA capacity unavailable: deadline lapsed', base: f.base, head: f.head, state: 'hold' as const, queueBuild: '', settingsRevision: 0, pid: null, capacityWait: null, capacityUnavailable: true };
  f.store.update(f.task.id, { phase: 'needs_attention', reason: 'QA capacity unavailable', resolution: { ...f.store.task(f.task.id).resolution, attention: true, projectValidation: held } });
  const engine = new Engine(f.store, idleAdapterFor(f.store), 0);
  const retried = engine.resolution.retry(f.store.task(f.task.id), false, undefined, true);
  assert.equal(retried.resolution.projectValidation, null);
});

test('failing its checks after admission keeps the failure semantics of today', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const task = grantIntegrationTurn(f.store, f.task.id);
  const scheduler = new HostRunScheduler(f.store);
  const hooks = new RepositoryHooks(f.store, { hostRuns: scheduler });
  const outcome = await hooks.projectValidationGate(task, f.head, validationCommand("process.stdout.write('refusal marker');process.exit(3)"));
  assert.equal(outcome.kind, 'refused');
  assert.equal(outcome.kind === 'refused' ? outcome.detail : '', 'refusal marker');
  const recorded = f.store.task(task.id).resolution.projectValidation!;
  assert.equal(recorded.state, 'refused');
  assert.equal(recorded.exitCode, 3);
  assert.equal(recorded.capacityUnavailable, false);
  assert.equal('admission' in recorded, false);
  assert.equal(recorded.hostRunTelemetry?.outcome, 'failed');
});

test('telemetry reports queue wait, wall and CPU separately per project and task type', async t => {
  const f = await fixture(t);
  t.after(() => f.store.close());
  const base = { argv: ['effigy', 'qa'], digest: 'd'.repeat(64), exitCode: 0, durationMs: 10, outputTail: '', base: f.base, head: f.head, state: 'passed' as const, queueBuild: '', settingsRevision: 0, pid: null, capacityWait: null, capacityUnavailable: false };
  const joined = { ...base, hostRunTelemetry: { queueWaitMs: 100, wallMs: 1000, cpuMs: 700, outcome: 'passed' as const } };
  const unavailable = { ...base, digest: 'e'.repeat(64), admission: { caller: 'queue:t2:r2', availability: 'unavailable' as const, runId: null, state: null, queueWaitMs: null, wallMs: null, cpuUserMs: null, cpuSystemMs: null, peakRssBytes: null } };
  const second = f.store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'Second task', repoPath: f.repo, baseBranch: 'main',
    planningCommit: f.base, handoffPath: 'docs/plan.json', originAgentId: 'origin',
  }), 'host', 'handoff', f.base);
  f.store.update(f.task.id, { resolution: { ...f.store.task(f.task.id).resolution, projectValidation: joined } });
  f.store.update(second.id, { resolution: { ...f.store.task(second.id).resolution, projectValidation: unavailable } });
  for (const groupBy of ['none', 'repository', 'scope'] as const) {
    const snapshot = telemetrySnapshotSchema.parse(telemetrySnapshot(f.store, { window: 'all', groupBy }));
    assert.equal(snapshot.groups.length, 1);
    const qa = snapshot.groups[0]!.qaAdmission;
    assert.equal(qa.validations, 2, groupBy);
    assert.deepEqual([qa.queueWaitMs.count, qa.queueWaitMs.partialCount, qa.queueWaitMs.p50Ms], [1, 1, 100], groupBy);
    assert.deepEqual([qa.wallMs.count, qa.wallMs.partialCount, qa.wallMs.p50Ms], [1, 1, 1000], groupBy);
    assert.deepEqual([qa.cpuMs.count, qa.cpuMs.partialCount, qa.cpuMs.p50Ms], [1, 1, 700], groupBy);
    assert.equal(qa.capacityUnavailable, 0, groupBy);
  }
});

test('historical validation records with admission blocks remain readable', () => {
  const historical = projectValidationResultSchema.parse({
    argv: ['effigy', 'qa'], digest: 'f'.repeat(64), exitCode: 0, durationMs: 1000, outputTail: '',
    base: 'a'.repeat(40), head: 'b'.repeat(40), state: 'passed',
    admission: { caller: 'queue:task:run', availability: 'joined', runId: 'effigy-run', state: 'succeeded',
      queueWaitMs: 50, wallMs: 1000, cpuUserMs: 400, cpuSystemMs: 100, peakRssBytes: null },
  });
  assert.equal(historical.admission?.caller, 'queue:task:run');
  assert.equal(historical.admission?.queueWaitMs, 50);
});


/** An adapter whose only worker is idle in its own workspace; enough for the liveness sweep. */
function idleAdapterFor(store: Store): Adapter {
  return {
    profiles: async () => [] as Profile[], validate: async (t: Task) => t.planningCommit,
    createWorkspace: async (t: Task) => ({ id: `ws-${t.id}`, directory: '/fixture' }),
    findWorkspaces: async () => [], verifyWorkspace: async (t: Task) => t.branch,
    createAgent: createTaskAgent,
    findAgents: async () => [],
    observe: async (id: string) => {
      const task = store.tasks().find(candidate => candidate.agentId === id || candidate.agentId === `agent-${id}`);
      return { id, workspaceId: task?.workspaceId ?? `ws-${id}`, status: 'idle', active: false, permissions: false, error: '' };
    },
    archiveAgent: async () => {}, archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/11', head: 'abc' }),
    findOpenBranchPr: async () => [],
  } as unknown as Adapter;
}
