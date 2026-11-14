/**
 * Task 104 (and 114) — milestone QA runs a repository's full QA on main on request.
 *
 * A method (`project.qa.run`) and a board control start a run and show its
 * state, duration and result tail. Tests cover: the checkout is the integration
 * head in a linked worktree of the registered checkout; setup sees the
 * configured sibling layout; teardown runs after pass, fail and loss; setup
 * failure holds with its own step output surviving teardown; capacity waits
 * aren't failures; results are recorded; and a Queue service roll mid-run is
 * survived by the detached supervisor whose step records survive with it.
 */
import { test } from './support/sharded-test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, git } from '../core/git/index';
import type { ExecutionRequest } from '../core/hooks/hooks';
import { Store, digest } from '../core/store/store';
import { ProjectQaRunner, DEFAULT_PROJECT_QA_ARGV, DEFAULT_PROJECT_QA_TIMEOUT_MS } from './project-qa-runner-fixture';
import {
  QA_SUPERVISION_SCHEMA,
  QA_SUPERVISION_PLAN_SCHEMA,
  QA_SUPERVISION_SCHEMA_VERSION,
  qaSupervisionPaths,
  qaSupervisionPlanSchema,
  readQaCancelRequest,
  readHostRunResult,
  readQaSupervision,
  readQaSupervisionPlan,
  writeHostRunResult,
  supervisorLiveness,
  writeQaSupervision,
  writeQaSupervisionPlan,
  removeQaWorkspace,
} from '../core/qa/project-qa-supervisor';
import { findProcessByCommandToken, scanTokenVerdict, type ProcCommandLine } from '../core/machine/process-identity';
import { HostRunScheduler, classifyHostRun } from '../core/host-runs/host-run-scheduler';
import { checkoutRunScratchPlacement, runScratchRoot, runTemporaryDirectory, type RunScratchPlacement } from '../core/workspaces/run-scratch';
import type { CheckoutVolumeInfo } from '../core/workspaces/checkout-volume';
import { readHostRunTokenKeys } from '../service/callbacks/host-run-endpoint';
import { verifyRunToken } from "./host-run-token-fixture";
import { hostRunResultSchema, hostRunSettlementSchema, projectQaCancelInputSchema, projectQaGet, projectQaRunSchema, DEFAULT_PROCESS_TERMINATION_GRACE_MS, PROJECT_QA_TIMEOUT_MAX_MS, projectQaSchema, type ProjectQaRun, projectQaRetryTeardownInputSchema } from '../shared/contracts';
import { processGroupEmpty, processGroupHasStartIdentity } from '../core/machine/process-group';
import { PROCESS_START_IDENTITY_ENV, processesForStartIdentity } from '../core/machine/process-identity-search';
import { HOOK_TEST_TIMEOUT_MS, waitFor } from './support/budgets';
import { frozenHostRunSettlementSchema } from './support/contract-010-frozen';
import { buildConfiguredClone, materializeSeed, type GitSeed } from './support/git-seed';
import type { QaPipelineOutcome } from '../core/qa/project-qa-supervisor';
import { confirmStaleSupervisorHeartbeat } from '../core/machine/supervisor-watchdog';

/** Every case starts from the same published one-commit repository. */
const publishedRepository: GitSeed = { name: 'pqa', build: async root => {
  await buildConfiguredClone(root);
  const repo = join(root, 'repo');
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'initial');
  await git(repo, 'push', 'origin', 'main');
} };

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-pqa-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await materializeSeed(publishedRepository, root);
  const repo = join(root, 'repo');
  const storeDir = await mkdtemp(join(tmpdir(), 'nsq-pqa-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new Store(join(storeDir, 'queue.sqlite'));
  t.after(() => store.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'nsq-pqa-data-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const hostRunStateDir = join(dataDir, 'host-run');
  await mkdir(hostRunStateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(hostRunStateDir, 'token.key'), JSON.stringify({ format: 'host.run.keys', version: 1,
    current: { epoch: 1, keyB64: Buffer.alloc(32, 0x51).toString('base64') } }), { mode: 0o600 });
  return { root, repo, store, dataDir, hostRunStateDir };
}

/** A proved fixture volume for a QA run's temp leaf, the same placement production uses. */
function fixtureRunScratch(dir: string): { mount: string; scratch: RunScratchPlacement } {
  const mount = join(realpathSync(dir), 'Builds');
  mkdirSync(mount, { recursive: true });
  const volume: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: 'fixture', Internal: false, Writable: true, WritableVolume: true };
  return { mount, scratch: checkoutRunScratchPlacement({ mount, uuid: 'fixture', observe: () => volume }) };
}


const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface QaHarnessResult { code: number | null; stdout: string; stderr: string; records: Record<string, unknown>[] }

/**
 * Run the Queue service side of a milestone run in its own process, so a test
 * can kill it mid-run and prove a fresh process re-attaches to the detached
 * supervisor (`test/fixtures/qa-service.mjs`).
 */
async function qaServiceHarness(args: string[], timeoutMs = 90_000): Promise<QaHarnessResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'test/fixtures/qa-service.mjs'), ...args],
      { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`QA harness ${args[0]} timed out`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const records = stdout.split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
        .filter((value): value is Record<string, unknown> => value !== null);
      resolvePromise({ code, stdout, stderr, records });
    });
  });
}

const result = (code = 0, output = '') => ({
  pid: process.pid, processGroupId: process.pid, leaderStartIdentity: `fixture-leader-${randomUUID()}`,
  startIdentity: `fixture-step-${randomUUID()}`, processGroupEmpty: true,
  startedAt: new Date(Date.now() - 2).toISOString(), endedAt: new Date().toISOString(),
  code, signal: null, timedOut: false, stdoutExceeded: false, stderrExceeded: false,
  stdout: Buffer.from(output), stderr: Buffer.alloc(0), durationMs: 2,
});

async function setWorktreeHooks(f: Awaited<ReturnType<typeof fixture>>, hooks: { setup?: string; teardown?: string }) {
  await writeFile(join(f.repo, 'paseo.json'), `${JSON.stringify({ worktree: hooks})}\n`);
  await git(f.repo, 'add', 'paseo.json');
  await git(f.repo, 'commit', '-m', 'configure worktree hooks');
  await git(f.repo, 'push', 'origin', 'main');
}

async function setDependencyLedger(f: Awaited<ReturnType<typeof fixture>>, sibling: string) {
  const ledgerPath = join(f.repo, '.effigy/local/dependency-links.json');
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify({
    schema: 'effigy.deps.links.v1', schema_version: 1,
    links: [{ key: { manager: 'bun', consumer_repo: f.repo, library_path: sibling } }],
  })}\n`);
}

async function addSibling(f: Awaited<ReturnType<typeof fixture>>) {
  const bare = join(f.root, 'sibling-origin.git');
  const sibling = join(f.root, 'sibling');
  await command('git', ['init', '--bare', '--initial-branch=main', bare], f.root);
  await command('git', ['clone', bare, sibling], f.root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(sibling, 'README.md'), '# sibling\n');
  await git(sibling, 'add', '-A');
  await git(sibling, 'commit', '-m', 'initial');
  await git(sibling, 'push', 'origin', 'main');
  const primaryRepo = { origin: null, path: f.repo };
  const siblingRepo = { origin: null, path: sibling };
  f.store.upsertProject({ key: 'qa-suite', name: 'QA suite', repositories: [primaryRepo, siblingRepo], primary: primaryRepo });
  return sibling;
}

async function addRegisteredSiblingOutsideProject(f: Awaited<ReturnType<typeof fixture>>) {
  const bare = join(f.root, 'outside-origin.git');
  const sibling = join(f.root, 'outside');
  await command('git', ['init', '--bare', '--initial-branch=main', bare], f.root);
  await command('git', ['clone', bare, sibling], f.root);
  await git(sibling, 'config', 'user.name', 'Queue test');
  await git(sibling, 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(sibling, 'README.md'), '# outside project\n');
  await git(sibling, 'add', '-A');
  await git(sibling, 'commit', '-m', 'initial');
  await git(sibling, 'push', 'origin', 'main');
  const primary = { origin: null, path: f.repo };
  f.store.upsertProject({ key: 'qa-primary', name: 'QA primary', repositories: [primary], primary });
  f.store.putRepository({ origin: null, path: sibling }, null, 'registered source outside the primary project');
  return sibling;
}

test('the checkout is the fetched integration head in a Queue-owned directory', async t => {
  const f = await fixture(t);
  // Move the integration head from a second clone so the registered checkout
  // starts behind origin: the run must still check out the fetched head.
  await command('git', ['clone', join(f.root, 'origin.git'), join(f.root, 'other')], f.root);
  await git(join(f.root, 'other'), 'config', 'user.name', 'Queue test');
  await git(join(f.root, 'other'), 'config', 'user.email', 'queue@example.invalid');
  await writeFile(join(f.root, 'other', 'milestone.txt'), 'milestone\n');
  await git(join(f.root, 'other'), 'add', '-A');
  await git(join(f.root, 'other'), 'commit', '-m', 'milestone head');
  await git(join(f.root, 'other'), 'push', 'origin', 'main');
  const expected = await git(join(f.root, 'other'), 'rev-parse', 'HEAD');
  let observedCwd = '';
  let observedHead = '';
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, run: async request => {
      observedCwd = request.root;
      observedHead = await git(request.root, 'rev-parse', 'HEAD');
      return result(0, 'ok');
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'running', 30_000, 'the QA run to launch');
  assert.equal(f.store.qaRun(started.id)?.state, 'running');
  assert.equal(started.base, expected, 'the run records the fetched integration head');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run to settle');
  const settled = (await runner.get({ repository: f.repo }))!;
  assert.equal(settled.state, 'passed');
  assert.equal(settled.base, expected);
  assert.equal(observedHead, expected, 'the command ran detached at the fetched head');
  assert.notEqual(observedCwd, f.repo, 'never in the registered checkout');
  assert.ok(observedCwd.startsWith(await realpath(f.dataDir)), `Queue-owned checkout under the data directory, got ${observedCwd}`);
  assert.ok(!observedCwd.includes(f.repo), 'never in a task worktree path');
});

test('new QA checkout uses private external placement while supervision stays internal', async t => {
  const f = await fixture(t);
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  let observed = '', admissions = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: path => { admissions++; assert.ok(path.startsWith(`${builds}/project-qa/`)); } },
    run: async request => { observed = request.root; return result(); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed');
  assert.equal(settled.checkoutPath, observed);
  assert.ok(observed.startsWith(`${builds}/project-qa/`));
  assert.equal(existsSync(observed), false);
  assert.ok(admissions >= 3);
});

test('hourly QA retention removes settled checkouts and keeps logs and unsettled checkouts', async t => {
  const f = await fixture(t);
  const key = await realpath(f.repo), builds = join(f.root, 'builds');
  await mkdir(builds);
  const root = join(f.dataDir, 'project-qa', digest(key).slice(0, 24));
  await mkdir(root, { recursive: true });
  const oldFailedId = randomUUID(), settledId = randomUUID(), activeId = randomUUID(), latestFailureId = randomUUID();
  const oldFailedCheckout = join(f.dataDir, 'project-qa', digest(key).slice(0, 24), oldFailedId);
  const settledCheckout = join(f.dataDir, 'project-qa', digest(key).slice(0, 24), settledId);
  const activeCheckout = join(builds, 'project-qa', digest(key).slice(0, 24), activeId);
  const latestFailureCheckout = join(f.dataDir, 'project-qa', digest(key).slice(0, 24), latestFailureId);
  await mkdir(dirname(settledCheckout), { recursive: true });
  await mkdir(dirname(activeCheckout), { recursive: true });
  await git(f.repo, 'worktree', 'add', '--detach', oldFailedCheckout, 'HEAD');
  await git(f.repo, 'worktree', 'add', '--detach', settledCheckout, 'HEAD');
  await git(f.repo, 'worktree', 'add', '--detach', activeCheckout, 'HEAD');
  await git(f.repo, 'worktree', 'add', '--detach', latestFailureCheckout, 'HEAD');
  const log = join(root, `${settledId}.stdout.log`);
  await writeFile(log, 'retained QA output\n');
  const oldLog = join(root, `${settledId}.qa.stdout.log`);
  const oldResult = join(root, `${settledId}.result.json`);
  const activeLog = join(root, `${activeId}.qa.stdout.log`);
  const retryLog = join(root, `${latestFailureId}.teardown.stdout.log`);
  const orphanLog = join(root, `${randomUUID()}.live.log`);
  const unknown = join(root, 'unrecognized.log');
  const old = new Date(Date.now() - 5 * 86_400_000);
  for (const path of [oldLog, oldResult, activeLog, retryLog, orphanLog, unknown]) {
    await writeFile(path, 'retained evidence'); await utimes(path, old, old);
  }
  const base = await git(f.repo, 'rev-parse', 'HEAD');
  const record = (id: string, checkoutPath: string, state: 'passed' | 'running' | 'hold') => projectQaRunSchema.parse({
    id, repository: { origin: null, path: key }, key, checkoutPath, state, baseBranch: 'main', base,
    argv: ['fixture'], digest: 'c'.repeat(64), exitCode: state === 'passed' ? 0 : state === 'hold' ? 1 : null, durationMs: 10,
    outputTail: 'result retained in history', startedAt: new Date().toISOString(),
    finishedAt: state === 'running' ? null : old.toISOString(), pid: null,
    capacityWait: null, capacityUnavailable: false, ...(state === 'hold' ? { failedStep: 'teardown' } : {}),
  });
  f.store.putQaRun(record(oldFailedId, oldFailedCheckout, 'hold'));
  f.store.putQaRun(record(settledId, settledCheckout, 'passed'));
  f.store.putQaRun(record(activeId, activeCheckout, 'running'));
  f.store.putQaRun(record(latestFailureId, latestFailureCheckout, 'hold'));
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => {} } });

  await (runner as any).pruneSettledCheckouts();

  assert.equal(existsSync(settledCheckout), false, 'the Queue-owned settled checkout is reaped');
  assert.equal(existsSync(oldFailedCheckout), false, 'an older retryable failure does not retain its checkout');
  assert.equal(existsSync(latestFailureCheckout), true, 'the latest retryable run keeps the checkout its retry reads');
  assert.equal(existsSync(activeCheckout), true, 'an unsettled run keeps its checkout');
  assert.equal(existsSync(oldLog), false, 'expired settled output is pruned');
  assert.equal(existsSync(oldResult), false, 'expired result sidecars are pruned');
  assert.equal(existsSync(orphanLog), false, 'expired logs outlive neither their row nor the window');
  assert.equal(existsSync(activeLog), true, 'active output remains even with an old timestamp');
  assert.equal(existsSync(retryLog), true, 'retryable failure keeps its evidence');
  assert.equal(existsSync(unknown), true, 'unrecognized files are never retention targets');
  assert.equal(await readFile(log, 'utf8'), 'retained QA output\n', 'the run log stays with its result');
});

test('QA refuses unavailable storage before a checkout and preserves a lost admission', async t => {
  const f = await fixture(t);
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  const before = await git(f.repo, 'worktree', 'list', '--porcelain');
  let admissions = 0, commands = 0, failAt = 1;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => { if (++admissions >= failAt) throw Error('storage unavailable'); } },
    run: async () => { commands++; return result(); },
  });
  await assert.rejects(runner.run({ repository: f.repo }), /storage unavailable/);
  assert.equal(existsSync(join(builds, 'project-qa')), false);
  assert.equal(await git(f.repo, 'worktree', 'list', '--porcelain'), before);
  admissions = 0;
  failAt = 3;
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the refused QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.equal(existsSync(settled.checkoutPath!), false);
  assert.equal(commands, 0);
  assert.equal(await git(f.repo, 'worktree', 'list', '--porcelain'), before);
});

test('external QA runs setup and teardown and retains a checkout when storage disappears', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'setup-fixture', teardown: 'teardown-fixture' });
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  let available = true, checkout = '';
  const scripts: string[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => { if (!available) throw Error('storage unavailable'); } },
    worktreeHookRun: async request => { scripts.push(request.argv.at(-1)!); return result(); },
    run: async request => { checkout = request.root; available = false; return result(); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.deepEqual(scripts, ['setup-fixture']);
  assert.equal(settled.failedStep, 'teardown');
  assert.equal(existsSync(checkout), true);
  assert.match(settled.outputTail, /storage unavailable/);
  available = true;
  await runner.retryTeardown({ id: started.id, reason: 'storage repaired' });
  assert.deepEqual(scripts, ['setup-fixture', 'teardown-fixture']);
  assert.equal(existsSync(checkout), false);
});

test('external QA cleanup rejects a foreign directory without deleting it', async t => {
  const f = await fixture(t);
  const foreign = join(f.root, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'keep'), 'owner');
  await assert.rejects(removeQaWorkspace({ registeredPath: f.repo, checkoutPath: foreign, expectedHead: 'not-the-head', admission: () => {} }), /identity changed/);
  assert.equal(await readFile(join(foreign, 'keep'), 'utf8'), 'owner');
});

test('external cleanup retry never repeats a completed teardown', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'teardown-fixture' });
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  let available = true, checkout = '', teardownCalls = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => { if (!available) throw Error('storage unavailable'); } },
    worktreeHookRun: async () => { teardownCalls++; available = false; return result(); },
    run: async request => { checkout = request.root; return result(7); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'cleanup to stop');
  assert.equal(f.store.qaRun(started.id)?.state, 'hold');
  assert.equal(f.store.qaRun(started.id)?.checkoutCleanupPending, true);
  assert.equal(f.store.qaRun(started.id)?.failedStep, 'qa');
  assert.equal(teardownCalls, 1);
  assert.equal(existsSync(checkout), true);
  available = true;
  await runner.retryTeardown({ id: started.id, reason: 'storage repaired' });
  assert.equal(teardownCalls, 1);
  assert.equal(existsSync(checkout), false);
  assert.equal(f.store.qaRun(started.id)?.checkoutCleanupPending, false);
  assert.equal(f.store.qaRun(started.id)?.state, 'failed');
  assert.equal(f.store.qaRun(started.id)?.failedStep, 'qa');
});

test('lost external QA creation waits visibly while storage is unavailable and reconciles after repair', async t => {
  const f = await fixture(t), key = await realpath(f.repo), id = randomUUID();
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  const checkoutPath = join(builds, 'project-qa', digest(key).slice(0, 24), id);
  const run = projectQaRunSchema.parse({ id, repository: { origin: null, path: key }, key, checkoutPath, state: 'running',
    baseBranch: 'main', base: await git(f.repo, 'rev-parse', 'HEAD'), argv: ['fixture'], digest: 'b'.repeat(64),
    exitCode: null, durationMs: 0, outputTail: '', startedAt: new Date().toISOString(), finishedAt: null, pid: null,
    capacityWait: null, capacityUnavailable: false });
  f.store.putQaRun(run);
  let available = false;
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => { if (!available) throw Error('storage unavailable'); } } });
  (runner as any).inspectSupervisor = async () => ({ kind: 'dead', state: null, reason: 'fixture' });
  await runner.reconcile(key, id);
  assert.equal(f.store.qaRun(id)?.state, 'running');
  assert.match(f.store.qaRun(id)!.outputTail, /storage unavailable/);
  assert.equal(existsSync(checkoutPath), false);
  available = true;
  await runner.reconcile(key, id);
  assert.equal(f.store.qaRun(id)?.state, 'lost');
  assert.equal(existsSync(checkoutPath), false);
});

test('an uncertain teardown outcome is never replayed by the existing retry control', async t => {
  const f = await fixture(t), key = await realpath(f.repo), id = randomUUID();
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  const checkoutPath = join(builds, 'project-qa', digest(key).slice(0, 24), id);
  const run = projectQaRunSchema.parse({ id, repository: { origin: null, path: key }, key, checkoutPath, state: 'hold',
    baseBranch: 'main', base: await git(f.repo, 'rev-parse', 'HEAD'), argv: ['fixture'], digest: 'b'.repeat(64),
    exitCode: null, durationMs: 0, outputTail: 'uncertain', startedAt: new Date().toISOString(), finishedAt: null, pid: null,
    capacityWait: null, capacityUnavailable: false, failedStep: 'teardown', interruptedStep: 'teardown' });
  f.store.putQaRun(run);
  let hooks = 0;
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir,
    testPlacement: { dataDir: builds, admit: () => {} }, worktreeHookRun: async () => { hooks++; return result(); } });
  await assert.rejects(runner.retryTeardown({ id, reason: 'retry' }), /uncertain teardown outcome/);
  assert.equal(hooks, 0);
  assert.equal(existsSync(checkoutPath), false);
  assert.equal(f.store.qaRun(id)?.interruptedStep, 'teardown');
});

test('a queued milestone reattaches after the service owner rolls before admission', async t => {
  const f = await fixture(t);
  const capacity = () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] });
  const firstOwner = new HostRunScheduler(f.store, { capacity });
  t.after(() => firstOwner.stop());
  const submittedAt = new Date().toISOString();
  firstOwner.adoptRunning({ id: 'qa-capacity-blocker', epoch: 1, caller: 'test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    launchedAt: submittedAt, pid: null, submittedAt });
  const run = async () => ({ ...result(), pid: process.pid, processGroupId: process.pid, leaderStartIdentity: 'test-leader',
    startIdentity: 'test-process', processGroupEmpty: true, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  const firstRunner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: firstOwner, run });
  const submitted = await firstRunner.run({ repository: f.repo });
  assert.equal(f.store.qaRun(submitted.id)?.state, 'queued');
  firstOwner.stop();

  const restartedScheduler = new HostRunScheduler(f.store, { capacity });
  t.after(() => restartedScheduler.stop());
  const restartedRunner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: restartedScheduler, run });
  await restartedRunner.list();
  assert.equal(restartedScheduler.get(submitted.id)?.position, 1);
  const blocker = restartedScheduler.get('qa-capacity-blocker')!;
  restartedScheduler.settle(blocker.id, hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1,
    runId: blocker.id, outcome: 'lost', launched: true, settledAt: new Date().toISOString(), result: null, containers: [] }));
  await waitFor(() => restartedScheduler.get(submitted.id)?.state === 'settled', 30_000, 'the reattached QA run to settle');
  assert.equal(f.store.qaRun(submitted.id)?.state, 'passed');
});

test('the QA checkout is a linked worktree of the registered checkout and leaves it untouched', async t => {
  const f = await fixture(t);
  const registeredCommon = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const registeredHead = await git(f.repo, 'rev-parse', 'HEAD');
  const registeredBranch = await git(f.repo, 'branch', '--show-current');
  let observedCommon = '';
  let observedHead = '';
  let observedCwd = '';
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, run: async request => {
      observedCwd = request.root;
      observedCommon = await git(request.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      observedHead = await git(request.root, 'rev-parse', 'HEAD');
      return result(0, 'ok');
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run to settle');
  assert.equal(f.store.qaRun(started.id)!.state, 'passed', f.store.qaRun(started.id)!.outputTail);
  assert.equal(observedCommon, registeredCommon, 'the QA checkout .git resolves to the registered common directory');
  assert.equal(observedHead, started.base, 'the worktree is detached at the fetched integration head');
  assert.notEqual(observedCwd, f.repo, 'the QA checkout is not the registered checkout');
  assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), registeredHead, 'the registered HEAD never moved');
  assert.equal(await git(f.repo, 'branch', '--show-current'), registeredBranch, 'the registered checkout keeps its branch');
  assert.equal(await git(f.repo, 'status', '--porcelain'), '', 'the registered working tree is untouched');
  assert.doesNotMatch(await git(f.repo, 'worktree', 'list'), new RegExp(started.id), 'the run detaches its worktree registration on settle');
});

test('milestone QA tells its agent submitter once on pass and failure, and stays silent without one', async t => {
  const f = await fixture(t);
  const messages: Array<{ agentId: string; id: string; text: string }> = [];
  let code = 0;
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir,
    notify: async (agentId, id, text) => { messages.push({ agentId, id, text }); },
    run: async () => result(code, code === 0 ? 'passed' : 'failed') });
  const passed = await runner.run({ repository: f.repo, submitterAgentId: 'planner-agent' });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(passed.id)?.state ?? ''), 30_000, 'pass notification');
  code = 1;
  const failed = await runner.run({ repository: f.repo, submitterAgentId: 'planner-agent' });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(failed.id)?.state ?? ''), 30_000, 'failure notification');
  const silent = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(silent.id)?.state ?? ''), 30_000, 'silent run');
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.agentId === 'planner-agent'));
  assert.match(messages[0].text, /passed.*0 failed, 0 cancelled/);
  assert.match(messages[1].text, /failed.*1 failed, 0 cancelled/);
  assert.ok(messages.every(message => message.text.includes(message.id.replace(/^project-qa-settled-/, '').replace(/-planner-agent$/, ''))));
  assert.equal(new Set(messages.map(message => message.id)).size, 2);
});

test('non-TAP QA failures index a pointer to retained step output', async t => {
  const f = await fixture(t);
  const timeoutMs = 25_000;
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  let enforcedTimeoutMs = 0;
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir,
    run: async request => { enforcedTimeoutMs = request.timeoutMs; return result(1, 'nextest: FAIL [tests::assertion] expected 2, got 1'); } });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'non-TAP failure');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed');
  assert.equal(settled.runTimeoutMs, enforcedTimeoutMs, 'the recorded single-command timeout matches the executor limit');
  assert.equal(enforcedTimeoutMs, timeoutMs);
  assert.match(settled.failuresLog ?? '', /Retained output:/);
  assert.match(settled.failureIndexes?.[0]?.identities[0]?.title ?? '', /inspect retained output/);
  assert.ok(settled.failureIndexes?.[0]?.identities[0]?.location);
  assert.ok(existsSync(settled.failureIndexes![0].identities[0].location!));
});

test('worktree setup sees Queue-owned sibling checkouts before QA, then teardown runs after pass and fail', async t => {
  const f = await fixture(t);
  const sibling = await addSibling(f);
  await setWorktreeHooks(f, { setup: 'prepare-worktree', teardown: 'tear-down-worktree' });
  await setDependencyLedger(f, sibling);
  const registeredCommon = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const events: string[] = [];
  let code = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      const script = request.argv[1];
      if (script === 'prepare-worktree') {
        events.push('setup');
        assert.ok(existsSync(join(request.root, '..', 'sibling', 'README.md')), 'relative sibling is ready before setup');
        // The QA checkout is a linked worktree of the registered checkout, so
        // the repository's helper and Queue agree on the primary and its paths.
        const commonGitDir = await git(request.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
        assert.equal(commonGitDir, registeredCommon, 'the primary is the registered checkout');
        const ledger = JSON.parse(await readFile(join(f.repo, '.effigy/local/dependency-links.json'), 'utf8'));
        assert.equal(ledger.links[0].key.library_path, sibling, 'the registered ledger is not rewritten');
        assert.equal(await realpath(join(request.root, '..', 'sibling')), await realpath(sibling), 'the sibling link names the configured checkout');
        await writeFile(join(request.root, '.setup-ran'), 'yes');
      } else {
        events.push('teardown');
        assert.ok(existsSync(join(request.root, '.setup-ran')), 'teardown runs in the prepared checkout');
        await writeFile(join(request.root, '.teardown-ran'), 'yes');
      }
      return result();
    },
    run: async request => {
      events.push('qa');
      assert.ok(existsSync(join(request.root, '.setup-ran')), 'QA starts after setup');
      return result(code, code === 0 ? 'passed' : 'failed');
    },
  });

  const passed = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(passed.id)?.state ?? ''), 30_000, 'setup and QA pass to settle');
  assert.equal(f.store.qaRun(passed.id)!.state, 'passed', f.store.qaRun(passed.id)!.outputTail);
  assert.deepEqual(events, ['setup', 'qa', 'teardown']);
  const passedRunRoot = join(await realpath(f.dataDir), 'project-qa', digest(passed.key).slice(0, 24), passed.id);
  assert.equal(existsSync(passedRunRoot), false, 'the prepared run directory is removed');

  events.length = 0;
  code = 7;
  const failed = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(failed.id)?.state ?? ''), 30_000, 'setup and QA failure to settle');
  assert.equal(f.store.qaRun(failed.id)!.state, 'failed');
  assert.deepEqual(events, ['setup', 'qa', 'teardown']);
});

test('worktree setup prepares declared sources outside Queue project membership from configured checkouts', async t => {
  const f = await fixture(t);
  const sibling = await addRegisteredSiblingOutsideProject(f);
  await setWorktreeHooks(f, {
    setup: 'nucleus worktree prepare ../outside && effigy worktree:container:attach',
    teardown: 'tear-down-worktree',
  });
  await setDependencyLedger(f, sibling);
  assert.deepEqual(f.store.projectFor(f.repo)?.repositories.map(repo => repo.path), [f.repo]);

  let linkedSource = '';
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      if (request.argv[1].includes('nucleus worktree prepare')) {
        assert.ok(existsSync(join(request.root, '..', 'outside', 'README.md')), 'declared sibling is ready before worktree setup');
        linkedSource = await realpath(join(request.root, '..', 'outside'));
        assert.equal(linkedSource, await realpath(sibling), 'the declared source resolves to its configured checkout');
        // The same resolved source the repository's own helper derives from the
        // primary checkout, so `prepare` accepts the link Queue placed.
        assert.equal(await realpath(resolve(f.repo, '..', 'outside')), linkedSource);
        return result();
      }
      return result();
    },
    run: async () => result(),
  });

  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'QA with an outside-project sibling to settle');
  assert.equal(f.store.qaRun(started.id)!.state, 'passed', f.store.qaRun(started.id)!.outputTail);
  assert.equal(linkedSource, await realpath(sibling));
});

test('project QA skips and records an absent optional project member', async t => {
  const f = await fixture(t);
  const missing = { origin: 'https://github.com/example/optional.git', path: join(f.root, 'not-cloned') };
  const primary = { origin: null, path: f.repo };
  f.store.upsertProject({ key: 'qa-optional-member', name: 'QA optional member', repositories: [primary, missing], primary });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: async () => result() });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'QA with an absent optional member to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.skippedProjectMembers, [{ ...missing, reason: 'No local checkout' }]);
});

test('project QA still refuses a missing setup-declared sibling', async t => {
  const f = await fixture(t);
  const missingPath = '../not-cloned';
  await setWorktreeHooks(f, { setup: 'nucleus worktree prepare ../not-cloned' });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: async () => result() });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'QA with a missing required sibling to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.ok(settled.outputTail.includes(missingPath), settled.outputTail);
});

test('worktree setup reads the registered checkout as its primary checkout', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'attach-worktree', teardown: 'tear-down-worktree' });
  const localState = [
    ['.effigy/secrets/local.vault', 'encrypted-vault'],
    ['.effigy/secrets/local.vault.local-dev-key', 'dev-key'],
    ['.effigy/secrets/local.vault.local-unlock', 'unlock-key'],
  ] as const;
  for (const [relativePath, contents] of localState) {
    const path = join(f.repo, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o600 });
  }
  const registeredCommon = await git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      if (request.argv[1] !== 'attach-worktree') return result();
      const commonGitDir = await git(request.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
      assert.equal(commonGitDir, registeredCommon, 'the primary is the registered checkout');
      // The real attachWorktree reads the primary's vault through
      // `primaryCheckoutRoot`; here the registered checkout holds it directly.
      for (const [relativePath, contents] of localState) {
        const path = join(f.repo, relativePath);
        assert.equal(await readFile(path, 'utf8'), contents, 'the registered checkout keeps its local state');
        assert.equal((await stat(path)).mode & 0o777, 0o600, 'registered local state is untouched');
      }
      // Match attachWorktree: copy primary vault material into the linked checkout.
      for (const [relativePath, contents] of localState) {
        const path = join(request.root, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, { mode: 0o600 });
      }
      return result();
    },
    run: async request => {
      for (const [relativePath, contents] of localState)
        assert.equal(await readFile(join(request.root, relativePath), 'utf8'), contents);
      return result();
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run with inherited local state');
  assert.equal(f.store.qaRun(started.id)!.state, 'passed', f.store.qaRun(started.id)!.outputTail);
});

test('worktree setup failure is a hold with its output and does not run QA', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'bun install --frozen-lockfile', teardown: 'effigy worktree:container:teardown' });
  const calls: string[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      calls.push(request.argv[1]);
      return request.argv[1].startsWith('bun install') ? result(1, 'catalog sibling missing') : result();
    },
    run: async () => { calls.push('qa'); return result(); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the setup hold to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.match(settled.outputTail, /worktree setup failed/i);
  assert.match(settled.outputTail, /catalog sibling missing/);
  assert.deepEqual(calls, ['bun install --frozen-lockfile', 'effigy worktree:container:teardown']);
});

test('the durable project QA result keeps the compact TAP index beside capped diagnostics', async t => {
  const f = await fixture(t);
  const tap = ["TAP version 13", "not ok 1 - first failure __HOST_TOKEN__", `  error: ${"x".repeat(40_000)}`];
  for (let id = 2; id <= 35; id++) tap.push(`not ok ${id} - later failure ${id}`, `  location: 'file:///repo/test-${id}.test.ts:${id}:7'`);
  tap.push("not ok 36 - cancelled case", "  failureType: 'cancelledByParent'", "1..36", "# tests 36", "# fail 35", "# cancelled 1", "");
  const template = tap.join('\n');
  let hostToken = '';
  const messages: string[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir,
    notify: async (_agent, _id, text) => { messages.push(text); },
    run: async request => {
      hostToken = request.env?.HOST_RUN_TOKEN ?? '';
      const output = template.replaceAll('__HOST_TOKEN__', hostToken);
      request.onOutput?.('stdout', Buffer.from(output));
      return result(1, output);
    },
  });
  const started = await runner.run({ repository: f.repo, submitterAgentId: 'planner-agent' });
  await waitFor(() => messages.length > 0, 30_000, 'the TAP failure notice');
  assert.match(messages[0], /later failure 2 \(file:\/\/\/repo\/test-2.test.ts:2:7\)/);
  assert.match(messages[0], /16 more not listed/);

  const persisted = f.store.qaRun(started.id)!;
  const apiResult = projectQaRunSchema.parse(persisted);
  const index = apiResult.failureIndexes?.[0];
  assert.ok(index, 'the durable project QA record exposes its compact index');
  assert.equal(index.stage, 'qa');
  assert.equal(index.failed, 35);
  assert.equal(index.cancelled, 1);
  assert.equal(index.identities.length, 36);
  assert.equal(index.omittedIdentities, 0);
  assert.equal(index.diagnosticsTruncated, true);
  assert.ok(hostToken, 'the QA command receives its private host-run token');
  assert.ok(index.identities[0].title.includes('[REDACTED]'));
  assert.ok(apiResult.failuresLog!.includes('[REDACTED]'));
  assert.ok(!apiResult.failuresLog!.includes(hostToken), 'the verbose log does not expose the token');
  assert.ok(!JSON.stringify(index).includes(hostToken), 'the compact index does not expose the token');
  assert.ok(apiResult.failuresLog!.length <= 32_768, 'the verbose failures log retains its existing cap');
  assert.match(apiResult.outputTail, /TAP failure inventory:[\s\S]*qa: 35 failed, 1 cancelled; 36 identities retained, 0 omitted; diagnostics truncated/);
});

test('a failing setup step keeps its own stderr when teardown prints more afterwards', async t => {
  const f = await fixture(t);
  const setupLine = 'worktree:rust:seed: failed to prepare toolchain-keyed Cargo cache (exit 1)';
  await setWorktreeHooks(f, { setup: 'bun install --frozen-lockfile && effigy worktree:rust:seed', teardown: 'effigy worktree:container:teardown' });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      if (request.argv[1].startsWith('bun install')) {
        return { ...result(1, 'setup progress line\n'.repeat(400)), stderr: Buffer.from(`${setupLine}\n`), durationMs: 5 };
      }
      // Teardown prints far more than the shared tail would otherwise keep.
      return { ...result(0, 'teardown progress line\n'.repeat(400)), stdout: Buffer.from('teardown progress line\n'.repeat(400)), durationMs: 5 };
    },
    run: async () => { throw new Error('QA must not run after a failed setup'); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the failing setup run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.equal(settled.failedStep, 'setup');
  assert.match(settled.outputTail, /worktree:rust:seed: failed to prepare/, 'the failing step error survives later teardown output');
  const setup = settled.steps.find(step => step.name === 'setup')!;
  assert.equal(setup.exitCode, 1);
  assert.match(setup.stderrHead || setup.stderrTail, /worktree:rust:seed: failed to prepare/);
  const teardown = settled.steps.find(step => step.name === 'teardown');
  assert.ok(teardown, 'teardown still runs after a failed setup');
  assert.equal(teardown!.exitCode, 0);
  assert.ok(!settled.steps.some(step => step.name === 'qa'), 'the QA command did not run');
});

test('a failed teardown after setup failure is retryable and preserves the original failure', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'fail-setup', teardown: 'retire-container-scope' });
  let teardownAttempts = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    worktreeHookRun: async request => {
      if (request.argv[1] === 'fail-setup') return { ...result(1, 'setup output'), stderr: Buffer.from('setup failed\n') };
      teardownAttempts++;
      return teardownAttempts === 1
        ? { ...result(1, 'teardown output'), stderr: Buffer.from('teardown failed\n') }
        : result(0, 'teardown cleaned up');
    },
    run: async () => { throw new Error('QA must not run after setup failure'); },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 30_000, 'the setup and teardown failures to settle');
  const held = f.store.qaRun(started.id)!;
  const setup = held.steps.find(step => step.name === 'setup')!;
  const failedTeardown = held.steps.find(step => step.name === 'teardown')!;
  assert.equal(held.failedStep, 'setup');
  assert.equal(Boolean(held.checkoutCleanupPending), false);
  assert.equal(setup.exitCode, 1);
  assert.equal(failedTeardown.exitCode, 1);
  assert.match(held.outputTail, /Next action: retry teardown/);
  const heldApiRun = (await runner.get({ id: held.id }))!;
  assert.equal(heldApiRun.failedStep, 'setup');
  assert.match(heldApiRun.outputTail, /Next action: retry teardown/, 'project.qa.get exposes the recovery action in run detail');
  const setupLog = setup.stderrLogPath!;
  const teardownLog = failedTeardown.stderrLogPath!;
  const originalExitCode = held.exitCode;

  await runner.retryTeardown({ id: held.id, reason: 'retry failed cleanup' });
  const settled = f.store.qaRun(held.id)!;
  assert.equal(settled.state, 'failed');
  assert.equal(settled.exitCode, originalExitCode);
  assert.equal(settled.failedStep, 'setup');
  const apiRun = (await runner.get({ id: held.id }))!;
  assert.equal(apiRun.failedStep, 'setup', 'project.qa.get keeps the original first failure');
  assert.deepEqual(settled.steps.find(step => step.name === 'setup'), setup);
  assert.equal(settled.steps.filter(step => step.name === 'teardown').length, 2);
  assert.match(await readFile(setupLog, 'utf8'), /setup failed/);
  assert.match(await readFile(teardownLog, 'utf8'), /teardown failed/);
  assert.equal(existsSync(join(await realpath(f.dataDir), 'project-qa', digest(held.key).slice(0, 24), held.id)), false);
});

test('a rerun replaces a stale sibling link in the QA root', async t => {
  const f = await fixture(t);
  const sibling = await addSibling(f);
  await setWorktreeHooks(f, { setup: 'prepare-worktree', teardown: 'tear-down-worktree' });
  await setDependencyLedger(f, sibling);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      if (request.argv[1] === 'prepare-worktree')
        assert.ok(existsSync(join(request.root, '..', 'sibling', 'README.md')));
      return result();
    },
    run: async () => result(),
  });

  const first = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(first.id)?.state ?? ''), 30_000, 'the first QA run to settle');
  assert.equal(f.store.qaRun(first.id)!.state, 'passed');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(first.key).slice(0, 24));
  const linkPath = join(runRoot, 'sibling');
  assert.equal(await realpath(linkPath), await realpath(sibling), 'the QA root carries the configured sibling link');
  // A failed teardown or a moved checkout can leave a link pointing elsewhere.
  const decoy = join(f.root, 'decoy');
  await mkdir(decoy, { recursive: true });
  await rm(linkPath, { force: true });
  await symlink(decoy, linkPath);

  let secondLinkTarget = '';
  const rerun = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => {
      if (request.argv[1] === 'prepare-worktree') secondLinkTarget = await realpath(join(request.root, '..', 'sibling'));
      return result();
    },
    run: async () => result(),
  });
  const second = await rerun.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(second.id)?.state ?? ''), 30_000, 'the rerun to settle');
  assert.equal(f.store.qaRun(second.id)!.state, 'passed', 'the stale link does not block setup');
  assert.equal(secondLinkTarget, await realpath(sibling), 'the rerun replaces the stale link with the configured source');
});

test('one run per repository: a second request while one is running returns the running one', async t => {
  const f = await fixture(t);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, run: async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return { ...result(0, 'slow ok'), durationMs: 600 };
    },
  });
  const first = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(first.id)?.state === 'running', 30_000, 'the first QA run to launch');
  assert.ok(['queued', 'running'].includes(first.state));
  const second = await runner.run({ repository: f.repo });
  assert.equal(second.id, first.id, 'the second request returns the running run');
  assert.equal(second.state, 'running');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(first.id)?.state ?? ''), 30_000, 'the slow QA run to settle');
  assert.equal((await runner.get({ repository: f.repo }))!.state, 'passed');
  const third = await runner.run({ repository: f.repo });
  assert.notEqual(third.id, first.id, 'a settled run does not fence the next milestone');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(third.id)?.state ?? ''), 30_000, 'the next milestone to settle');
});

test("Queue capacity waits aren't failures: the run records its own position and launches when admitted", async t => {
  const f = await fixture(t);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000_000, freeMemoryBytes: 1_000_000_000, loadAverage: [] }) });
  const submittedAt = new Date().toISOString();
  scheduler.adoptRunning({ id: 'blocking-qa', epoch: 1, caller: 'test:blocker', repository: { origin: null, path: f.repo },
    selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone', runTimeoutMs: 60_000,
    launchedAt: submittedAt, pid: process.pid, submittedAt });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, hostRuns: scheduler,
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ...result(0, 'qa ok'), durationMs: 100 };
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.capacityWait?.position === 1, 30_000, 'the Queue capacity wait to show on the run');
  assert.equal(f.store.qaRun(started.id)!.state, 'queued', 'waiting for capacity is not a failure or a stall');
  scheduler.settle('blocking-qa', hostRunSettlementSchema.parse({ format: 'host.run.settlement', version: 1, runId: 'blocking-qa',
    outcome: 'lost', launched: true, settledAt: new Date().toISOString(), result: null, containers: [] }));
  await waitFor(() => f.store.qaRun(started.id)?.state === 'running', 30_000, 'the queued QA run to launch');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', 'a capacity wait never becomes a failure');
  assert.equal(settled.capacityUnavailable, false);
  assert.equal(settled.capacityWait, null, 'the transient wait clears at settle');
  assert.equal('admission' in settled, false);
  assert.ok(settled.hostRunEpoch);
});

test('results are recorded with state, duration and tail; the command defaults to effigy qa', async t => {
  const f = await fixture(t);
  // Per-task validation stays opt-in: no default command is stored.
  assert.equal(f.store.canonicalRepository(f.repo, null)?.validation ?? null, null);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, run: async () => ({ ...result(3, 'line one\nline two\n'), stderr: Buffer.from('boom\n'), durationMs: 12,
      processGroupId: 7821, leaderStartIdentity: 'qa-step-start', terminationSignal: 'SIGTERM' }),
  });
  const started = await runner.run({ repository: f.repo });
  assert.deepEqual(started.argv, [...DEFAULT_PROJECT_QA_ARGV], 'the command falls back to effigy qa');
  assert.equal(started.exitCode, null);
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the failing QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed', 'a non-zero exit is a recorded failure, never a merge gate');
  assert.equal(settled.exitCode, 3);
  assert.ok(settled.durationMs >= 0);
  assert.ok(settled.finishedAt && settled.finishedAt >= settled.startedAt);
  assert.match(settled.outputTail, /boom/);
  assert.equal(settled.terminationGraceMs, 30_000);
  assert.equal(settled.steps.find(step => step.name === 'qa')?.processGroupId, 7821);
  assert.equal(settled.steps.find(step => step.name === 'qa')?.leaderStartIdentity, 'qa-step-start');
  assert.equal(settled.steps.find(step => step.name === 'qa')?.terminationSignal, 'SIGTERM');
  assert.equal(settled.steps.find(step => step.name === 'qa')?.processGroupEmpty, true);
  assert.equal((await runner.get({ repository: f.repo }))!.id, started.id);
  assert.equal((await runner.get({ id: started.id }))!.id, started.id, 'id lookup returns that run');
  assert.equal(projectQaGet.input.safeParse({ id: started.id }).success, true);
  assert.equal(projectQaGet.input.safeParse({ repository: f.repo }).success, true);
  assert.ok((await runner.list()).some(run => run.id === started.id), 'the board list shows the run');
  // The per-task `validation` command is never the milestone command (Project-K planner, 2026-09-30):
  // it also runs on every prospective merge. Milestone QA uses the separate `qa` setting.
  f.store.putRepository({ origin: null, path: f.repo }, null, '', { argv: ['per-task-validation'], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 }, null,
    { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 3_600_000, maxOutputBytes: 4096, terminationGraceMs: 123 });
  assert.equal(f.store.canonicalRepository(f.repo, null)?.qa?.timeoutMs, 3_600_000, 'a milestone command may run for an hour');
  assert.equal(f.store.canonicalRepository(f.repo, null)?.qa?.terminationGraceMs, 123);
  let seenArgv: string[] | null = null;
  let seenGraceMs: number | null = null;
  const runnerOpt = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, run: async request => {
      seenArgv = [request.executable, ...request.argv];
      seenGraceMs = request.terminationGraceMs ?? null;
      return result(0, 'opt-in ok');
    },
  });
  // Clear the finished run's fence by running after settle: the new run picks
  // up the opted-in command.
  const opted = await runnerOpt.run({ repository: f.repo });
  assert.equal(opted.terminationGraceMs, 123, 'the configured grace is attached to the QA run');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(opted.id)?.state ?? ''), 30_000, 'the opt-in QA run to settle');
  assert.equal(seenArgv![0], process.execPath, 'the qa setting is used, not validation');
  assert.equal(seenGraceMs, 123, 'the configured grace reaches the shared executor');
  assert.equal(f.store.qaRun(opted.id)!.state, 'passed');
});

test('contract 010 timeout kills a SIGTERM-ignoring group and records the host result atomically', async t => {
  const f = await fixture(t);
  const script = "trap '' TERM; exec sleep 60";
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: ['/bin/sh', '-c', script], timeoutMs: 250, maxOutputBytes: 4096, terminationGraceMs: 100 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the timed-out QA group to stop');
  const settled = f.store.qaRun(started.id)!;
  const qa = settled.steps.find(step => step.name === 'qa')!;
  assert.equal(settled.state, 'timed_out');
  assert.equal(settled.hostSettlement?.outcome, 'timed_out');
  assert.equal(qa.timedOut, true);
  assert.equal(qa.terminationSignal, 'SIGKILL', 'SIGKILL follows the configured SIGTERM grace');
  assert.equal(qa.processGroupEmpty, true);
  assert.equal(settled.hostSettlement?.result?.signal, 'SIGKILL');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { resultPath } = qaSupervisionPaths(runRoot, started.id);
  const record = readHostRunResult(resultPath, started.id)!;
  assert.equal(record.format, 'host.run.result');
  assert.equal(hostRunResultSchema.safeParse(record).success, true);
  assert.equal(record.startedAt, qa.startedAt);
  assert.equal(record.endedAt, qa.endedAt);
  assert.equal(record.wallMs, qa.wallMs);
  assert.equal(record.exitCode, null);
  assert.equal(record.signal, 'SIGKILL');
  assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
});

test('contract 010 QA results record measured process-tree CPU', async t => {
  const f = await fixture(t);
  const script = "const until=Date.now()+700;let n=0;while(Date.now()<until)n=(n+Math.random())%100000;process.stdout.write(String(Math.floor(n)))";
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', script], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the CPU-measured QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  const cpuMs = settled.hostSettlement?.result?.cpuMs;
  assert.ok(typeof cpuMs === 'number' && cpuMs > 0, `expected measured CPU, got ${cpuMs}`);
  assert.equal(frozenHostRunSettlementSchema.safeParse(settled.hostSettlement).success, true, 'hostSettlement is the frozen Contract 010 shape');
  assert.doesNotMatch(JSON.stringify(settled), /cpuCoverage/, 'project.qa records never carry the internal reason');
  const hostRun = f.store.hostRun(started.id);
  assert.ok(hostRun, 'the milestone run has a scheduler row');
  assert.equal(hostRun.cpuMs, cpuMs);
  assert.doesNotMatch(JSON.stringify(hostRun), /cpuCoverage/, 'the stored row keeps main\'s shape');
  assert.equal(HostRunScheduler.forStore(f.store).cpuCoverage(started.id), 'sampled', 'the sidecar reason, bound at settle, rests in internal meta');
});

test('milestone progress-write failure preserves a live QA reservation and recovers its result', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'echo setup-done' });
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: ['/bin/sh', '-c', 'sleep 2; echo qa-done'], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const realPutQaRun = f.store.putQaRun.bind(f.store);
  let injected = 0;
  let processGroupId: number | null = null;
  (f.store as any).putQaRun = (run: ProjectQaRun) => {
    if (run.state === 'running' && run.steps.some(step => step.name === 'setup')) {
      injected++;
      throw new Error('injected QA progress write failure');
    }
    return realPutQaRun(run);
  };
  t.after(() => {
    (f.store as any).putQaRun = realPutQaRun;
    if (processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* the run already exited */ } }
  });

  const started = await runner.run({ repository: f.repo });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const paths = qaSupervisionPaths(runRoot, started.id);
  await waitFor(() => injected > 0, 15_000, 'the supervisor progress mirror to fail');
  // The first failed mirror can land at the setup-to-QA boundary, when the
  // supervision file legitimately has no activeProcess yet. Wait for the next
  // poll to publish the live QA command instead of reading that empty snapshot.
  await waitFor(() => {
    const group = runner.hostRuns.get(started.id)?.processGroupId;
    return Boolean(group && !processGroupEmpty(group));
  }, 15_000, 'the scheduler to mirror the live QA command identity');
  const hostRun = runner.hostRuns.get(started.id)!;
  processGroupId = hostRun.processGroupId;
  assert.equal(f.store.qaRun(started.id)?.state, 'running', 'the Queue row is not settled as lost');
  assert.equal(hostRun.state, 'running');
  assert.equal(hostRun.settlement, null, 'the scheduler keeps the host reservation');
  assert.ok(processGroupId && !processGroupEmpty(processGroupId), 'the QA command is still live');
  assert.ok(readQaSupervision(paths.statePath)?.activeProcess, 'durable process identity remains available');
  assert.equal(readHostRunResult(paths.resultPath, started.id), null, 'no terminal result has been written');

  (f.store as any).putQaRun = realPutQaRun;
  await waitFor(() => readHostRunResult(paths.resultPath, started.id) !== null, 15_000, 'the QA supervisor to write its result');
  await runner.get({ id: started.id });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'passed', 10_000, 'the completed supervisor to reconcile');
  const recovered = f.store.qaRun(started.id);
  assert.equal(recovered?.state, 'passed', recovered?.outputTail);
  assert.equal(runner.hostRuns.get(started.id)?.settlement?.outcome, 'passed');
});

test('a durable QA result settles while an escaped descendant holds capacity until it exits', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const identityToken = `qa-descendant-${randomUUID()}`;
  const carrier = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    detached: true, stdio: 'ignore', env: { ...process.env, [PROCESS_START_IDENTITY_ENV]: identityToken },
  });
  assert.ok(carrier.pid);
  const childGroupId = carrier.pid!;
  const processGroupId = 2_147_000_000;
  t.after(() => { try { process.kill(-childGroupId, 'SIGKILL'); } catch { /* already gone */ } });
  let escapedDescendant: { pid: number; startIdentity: string } | undefined;
  await waitFor(() => {
    const search = processesForStartIdentity(identityToken);
    escapedDescendant = search.state === 'found'
      ? search.processes.filter(process => process.pid === carrier.pid).map(process => ({ pid: process.pid, startIdentity: process.startIdentity }))[0]
      : undefined;
    return Boolean(escapedDescendant);
  }, 10_000, 'the detached descendant identity to appear');
  assert.ok(escapedDescendant);
  const startedAt = new Date(Date.now() - 100).toISOString();
  const real = await seedSupervisedRow(f, { id, pid: 2_147_000_000, identityToken, startedAt });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(real).slice(0, 24));
  const { resultPath } = qaSupervisionPaths(runRoot, id);
  const result = hostRunResultSchema.parse({ format: 'host.run.result', version: 1, runId: id, epoch: 1,
    pgid: processGroupId, startIdentity: `${processGroupId}@qa-original`, exitCode: 0, signal: null,
    startedAt, endedAt: new Date().toISOString(), wallMs: 100, cpuMs: null, escapedDescendants: [escapedDescendant] });
  writeHostRunResult(resultPath, result);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 1, memoryCapacityBytes: 1_000_000 }) });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: scheduler, supervisionPollMs: 25 });

  const observed = await runner.get({ id });
  assert.equal(observed?.state, 'passed', 'the result record settles the QA outcome');
  assert.equal(scheduler.get(id)?.state, 'settled');
  assert.equal(f.store.qaRun(id)?.state, 'passed');
  assert.equal(scheduler.get(id)?.settlement?.outcome, 'passed');
  assert.equal(scheduler.get(id)?.capacityReleasedAt, null, 'the live escaped child retains host capacity');
  assert.equal(scheduler.get(id)?.escapedDescendantsProvenDeadAt, null);

  const waiterId = `waiter-${id}`;
  const waiter = scheduler.submit({ id: waiterId, epoch: 1, caller: `test:${waiterId}`,
    // One heavy CPU: the held run keeps it (an unmeasured run reserves at least one
    // CPU), so a waiter on a fresh selector waits for the escaped child to exit.
    repository: { origin: null, path: f.repo }, selector: 'qa:waiter', runClass: 'heavy', classSource: 'default',
    priority: 'milestone', runTimeoutMs: 60_000, budgetFallback: { cpu: 1, memoryBytes: 1000 } }, {
    launch: run => { scheduler.markLaunched(run.id); },
  });
  assert.equal(waiter.state, 'queued', 'the held escaped descendant blocks a second host run');

  process.kill(-childGroupId, 'SIGKILL');
  await waitFor(() => scheduler.get(id)?.capacityReleasedAt !== null, 10_000, 'escaped-descendant capacity release after child exit');
  assert.equal(scheduler.get(id)?.capacityReleaseReason, 'all recorded escaped descendants proven dead');
  assert.ok(scheduler.get(id)?.escapedDescendantsProvenDeadAt);
  await waitFor(() => scheduler.get(waiterId)?.state === 'running', 10_000, 'the queued run to launch after capacity release');
});

test('a one-step milestone launch fact contains the command process identity', async t => {
  const f = await fixture(t);
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 100 });
  const scheduler = new HostRunScheduler(f.store, {
    capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 1_000_000 }),
  });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: scheduler, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 15_000, 'the one-step QA run to settle');

  const launchData = (runId: string) => f.store.hostRunJournal(runId)
    .filter(entry => entry.event === 'launched').map(entry => entry.data as Record<string, unknown>);
  const launched = launchData(started.id);
  assert.ok(launched.length > 0, 'the scheduler publishes a command launch fact');
  assert.ok(launched.every(data => data.pgid === data.pid && typeof data.pgid === 'number'
    && typeof data.startIdentity === 'string' && data.startIdentity.length > 0),
  JSON.stringify(launched));
  assert.equal(scheduler.get(started.id)?.processGroupId, scheduler.get(started.id)?.pid);
  assert.ok(scheduler.get(started.id)?.startIdentity);
});

test('a setsid descendant holding stdout does not keep a settled step open and is recorded', async t => {
  const f = await fixture(t);
  let escaped: number[] = [];
  // The descendant's pid is fixture-owned so cleanup still finds it when the
  // settlement assertion fails before the run records the escaped identity.
  const descendantPidFile = join(f.root, 'setsid-descendant.pid');
  t.after(async () => {
    for (const pid of escaped) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    try {
      const pid = Number(await readFile(descendantPidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
    } catch { /* no descendant was recorded */ }
  });
  // The parent writes the descendant's identity and exits only after its own
  // spawn event, so the supervisor sees an executed child with the run's
  // marker environment rather than a fork that has not exec'd yet. It is still
  // a live setsid descendant holding stdout.
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });",
    `fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
    "child.unref();",
    "child.on('spawn', () => process.stdout.write('parent done\\n'));",
  ].join(' ');
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', script], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 100 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 15_000, 'the command group to settle despite the inherited stdout pipe');
  const settled = f.store.qaRun(started.id)!;
  const qa = settled.steps.find(step => step.name === 'qa')!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.equal(qa.processGroupEmpty, true);
  assert.match(qa.stdoutHead, /parent done/);
  assert.ok(settled.escapedDescendants.length > 0, 'the detached descendant remains visible on the run');
  assert.deepEqual(settled.escapedDescendants, settled.hostSettlement?.result?.escapedDescendants);
  escaped = settled.escapedDescendants.map(process => process.pid);
});

test('a cancel before command launch settles without a host result or leftover marker', async t => {
  const f = await fixture(t);
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const internal = runner as unknown as { worktreeHooksAt: (path: string, ref: string) => Promise<unknown> };
  const readHooks = internal.worktreeHooksAt.bind(runner);
  let markWaiting!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>(resolve => { markWaiting = resolve; });
  const barrier = new Promise<void>(resolve => { resume = resolve; });
  internal.worktreeHooksAt = async (path, ref) => {
    markWaiting();
    await barrier;
    return readHooks(path, ref);
  };

  const started = await runner.run({ repository: f.repo });
  await waiting;
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { cancelPath, planPath } = qaSupervisionPaths(runRoot, started.id);
  await runner.cancel({ id: started.id, reason: 'cancel before launch' });
  assert.equal(f.store.qaRun(started.id)?.cancelReason, 'cancel before launch');
  assert.equal(f.store.qaRun(started.id)?.hostSettlement?.launched, false);
  resume();
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 15_000, 'the unlaunched cancellation to settle');
  await waitFor(() => !existsSync(planPath) && !existsSync(cancelPath), 15_000, 'cancelled launch preparation to clean its marker');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'cancelled');
  assert.equal(settled.hostSettlement?.launched, false);
  assert.equal(settled.hostSettlement?.result, null);
  assert.deepEqual(settled.steps, []);
  assert.equal(existsSync(planPath), false);
  assert.equal(existsSync(cancelPath), false);
});

test('project.qa.cancel stops the group, runs teardown and settles cancelled', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'echo teardown-ran' });
  const readyPath = join(f.dataDir, 'cancel-child-ready');
  const script = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`;
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', script], timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 100 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { statePath } = qaSupervisionPaths(runRoot, started.id);
  await waitFor(() => readQaSupervision(statePath)?.inFlight === 'qa' && existsSync(readyPath), 15_000, 'the QA command to install its SIGTERM handler');
  assert.equal(projectQaCancelInputSchema.safeParse({ id: started.id, reason: 'operator requested stop' }).success, true);
  assert.equal(projectQaCancelInputSchema.safeParse({ id: started.id, reason: ' ' }).success, false);
  await runner.cancel({ id: started.id, reason: 'operator requested stop' });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 15_000, 'the cancelled run and teardown to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'cancelled');
  assert.equal(settled.cancelReason, 'operator requested stop');
  assert.equal(settled.hostSettlement?.outcome, 'cancelled');
  assert.equal(settled.hostSettlement?.result?.signal, 'SIGKILL');
  assert.deepEqual(settled.steps.map(step => step.name), ['qa', 'teardown']);
  assert.equal(settled.steps.find(step => step.name === 'qa')?.terminationSignal, 'SIGKILL');
  assert.match(settled.steps.find(step => step.name === 'teardown')?.stdoutHead ?? '', /teardown-ran/);
  const repeated = await runner.cancel({ id: started.id, reason: 'duplicate request' });
  assert.equal(repeated.state, 'cancelled');
  assert.equal(repeated.cancelReason, 'operator requested stop', 'retries keep the original cancellation reason');
});

test('concurrent requests share one run: the claim is atomic across runner instances', async t => {
  const f = await fixture(t);
  let invocations = 0;
  const slow = async () => {
    invocations++;
    await new Promise(resolve => setTimeout(resolve, 800));
    return { ...result(0, 'slow ok'), durationMs: 800 };
  };
  // Separate runner instances, as runtime-owner builds one per RPC: the fence
  // must hold across instances, not just within one object.
  const a = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: slow });
  const b = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: slow });
  const [first, second] = await Promise.all([a.run({ repository: f.repo }), b.run({ repository: f.repo })]);
  await waitFor(() => f.store.qaRun(first.id)?.state === 'running', 30_000, 'the shared QA run to launch');
  assert.ok(['queued', 'running'].includes(first.state));
  assert.equal(second.id, first.id, 'the concurrent request returns the running run');
  assert.ok(['queued', 'running'].includes(second.state));
  assert.equal((await a.get({ repository: f.repo }))!.state, 'running', 'a live fenced run is never reconciled away');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(first.id)?.state ?? ''), 30_000, 'the shared QA run to settle');
  assert.equal(invocations, 1, 'one repository, one run');
  assert.equal(f.store.qaRun(first.id)!.state, 'passed');
});

test('an orphaned running row runs teardown, then reconciles to lost with its checkout removed', async t => {
  const f = await fixture(t);
  const { randomUUID } = await import('node:crypto');
  const real = await realpath(f.repo);
  const id = randomUUID();
  const orphan = {
    id, repository: { origin: null, path: real }, key: real, state: 'running' as const,
    baseBranch: 'main', base: 'a'.repeat(40), argv: ['effigy', 'qa'], digest: 'b'.repeat(64),
    exitCode: null, durationMs: 0, outputTail: 'partial', startedAt: new Date().toISOString(),
    finishedAt: null, pid: null, capacityWait: null, capacityUnavailable: false,
    steps: [], failedStep: null, interruptedStep: null, hostSettlement: null, escapedDescendants: [], cancelReason: null,
    logWriteErrors: [],
  };
  f.store.putQaRun(orphan);
  // A leftover Queue-owned checkout from the dead backend.
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(real).slice(0, 24));
  const checkout = join(runRoot, id);
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'stale.txt'), 'stale\n');
  await writeFile(join(checkout, 'paseo.json'), JSON.stringify({ worktree: { teardown: 'retire-run-scope' } }));
  const teardownRoots: string[] = [];
  const builds = join(f.root, 'builds');
  await mkdir(builds);
  let externalAdmissions = 0, newCheckout = '';
  const recovering = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, testPlacement: { dataDir: builds, admit: () => { externalAdmissions++; } },
    worktreeHookRun: async request => { teardownRoots.push(request.root); return result(); },
    run: async request => { newCheckout = request.root; return result(); },
  });
  const read = await recovering.get({ id });
  assert.equal(read!.state, 'lost', 'the orphaned run settles lost after its absent supervisor is proven');
  assert.match(read!.outputTail, /lost this QA run/);
  assert.equal(read!.capacityWait, null);
  assert.deepEqual(teardownRoots, [checkout], 'the retained worktree is torn down before removal');
  assert.equal(existsSync(checkout), false, 'the orphaned checkout is reaped');
  assert.equal(externalAdmissions, 0, 'legacy reconciliation uses its recorded internal path');
  const fresh = await recovering.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(fresh.id)?.state ?? ''), 30_000, 'new external QA to settle');
  assert.equal(f.store.qaRun(fresh.id)?.state, 'passed');
  assert.ok(newCheckout.startsWith(`${builds}/project-qa/`));
  assert.ok(externalAdmissions > 0);
  assert.equal(existsSync(newCheckout), false);
});

test('detached QA survives a service roll with a private external checkout and internal supervision', async t => {
  const f = await fixture(t);
  const mount = join(f.root, 'Builds');
  await mkdir(mount);
  const captures = Object.fromEntries(['setup', 'qa', 'teardown'].map(step => [step, join(f.root, `${step}-external`)]));
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const capture = (step: string) => `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(captures[step])},process.cwd())`)}`;
  await setWorktreeHooks(f, { setup: capture('setup'), teardown: capture('teardown') });
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(captures.qa)},process.cwd());setTimeout(()=>{},4000)`],
      timeoutMs: 60_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const input = { dataDir: f.dataDir, storePath: f.store.path, fixtureMount: mount };
  const rolled = await qaServiceHarness(['run', JSON.stringify({ ...input, repository: f.repo, waitForInFlight: 'qa' })], 60_000);
  assert.equal(rolled.code, 0, rolled.stderr);
  const started = rolled.records[0]?.record as ProjectQaRun;
  assert.equal(rolled.records[1]?.inFlight, 'qa');
  assert.ok(started.checkoutPath?.startsWith(`${mount}/queue/project-qa/`));
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const plan = readQaSupervisionPlan(qaSupervisionPaths(runRoot, started.id).planPath)!;
  assert.equal(plan.runRoot, runRoot);
  assert.equal(plan.checkoutPath, started.checkoutPath);
  assert.equal(plan.externalCheckout, true);
  const restarted = await qaServiceHarness(['settle', JSON.stringify({ ...input, id: started.id })], 60_000);
  assert.equal(restarted.code, 0, restarted.stderr);
  const settled = restarted.records[0]?.record as ProjectQaRun;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.steps.map(step => step.name), ['setup', 'qa', 'teardown']);
  for (const path of Object.values(captures)) assert.equal(await readFile(path, 'utf8'), started.checkoutPath);
  assert.equal(existsSync(started.checkoutPath!), false);
});

test('a service roll mid-QA survives: a fresh service re-attaches to the detached supervisor and records the real result', async t => {
  const f = await fixture(t);
  const captures = Object.fromEntries(['setup', 'qa', 'teardown'].map(step => [step, join(f.root, `${step}.json`)]));
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const captureStep = (step: string) => `${shellQuote(process.execPath)} -e ${shellQuote(
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(captures[step])},JSON.stringify({id:process.env.HOST_RUN_ID,token:process.env.HOST_RUN_TOKEN,cwd:fs.realpathSync(process.cwd())}));process.stdout.write(process.env.HOST_RUN_TOKEN)`
  )}`;
  await setWorktreeHooks(f, { setup: captureStep('setup'), teardown: captureStep('teardown') });
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: [process.execPath, '-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(captures.qa)},JSON.stringify({id:process.env.HOST_RUN_ID,token:process.env.HOST_RUN_TOKEN,cwd:fs.realpathSync(process.cwd())}));process.stdout.write(process.env.HOST_RUN_TOKEN);setTimeout(()=>{},4000)`],
      timeoutMs: 60_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });

  // The first service starts the run and dies while QA is in flight; only the
  // detached supervisor keeps running.
  const rolled = await qaServiceHarness(['run', JSON.stringify({ dataDir: f.dataDir, storePath: f.store.path, repository: f.repo, waitForInFlight: 'qa' })], 60_000);
  assert.equal(rolled.code, 0, rolled.stderr);
  const started = rolled.records[0]?.record as ProjectQaRun;
  assert.equal(started.state, 'running');
  assert.equal(rolled.records[1]?.inFlight, 'qa', 'the first service died while QA was in flight');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const planPath = qaSupervisionPaths(runRoot, started.id).planPath;
  const plan = readQaSupervisionPlan(planPath)!;
  assert.ok(plan.hostRunToken, 'the detached plan durably stores the issued credential');
  assert.equal((await stat(planPath)).mode & 0o777, 0o600, 'the credential plan is owner-only');
  await waitFor(() => existsSync(captures.qa), 10_000, 'the QA command to publish its token-bearing environment');
  const qaCapture = JSON.parse(await readFile(captures.qa, 'utf8')) as { id: string; token: string; cwd: string };
  const keys = readHostRunTokenKeys(f.hostRunStateDir)!;
  const inside = verifyRunToken(plan.hostRunToken, { keys, epoch: started.hostRunEpoch!, cwd: qaCapture.cwd });
  assert.equal(inside.valid, true);
  if (inside.valid) {
    assert.equal(inside.claims.runId, started.id);
    assert.equal(inside.claims.class, started.runClass);
    assert.equal(inside.claims.root, qaCapture.cwd);
    assert.equal(inside.claims.exp, Date.parse(started.startedAt) + started.runTimeoutMs! + 30_000);
  }
  assert.deepEqual(verifyRunToken(plan.hostRunToken, { keys, epoch: started.hostRunEpoch!, cwd: f.root }), { valid: false, reason: 'wrong_root' });

  // A fresh process is the restarted service: it must attach, not reap.
  const restarted = await qaServiceHarness(['settle', JSON.stringify({ dataDir: f.dataDir, storePath: f.store.path, id: started.id })], 60_000);
  assert.equal(restarted.code, 0, restarted.stderr);
  const settled = restarted.records[0]?.record as ProjectQaRun;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.steps.map(step => step.name), ['setup', 'qa', 'teardown'], 'every step the supervisor recorded survives the roll');
  assert.equal(settled.steps.find(step => step.name === 'qa')!.exitCode, 0);
  assert.ok(settled.durationMs >= 3_000, `the real duration survives the roll, got ${settled.durationMs}`);
  assert.equal(settled.interruptedStep, null);
  assert.equal('admission' in settled, false);
  assert.equal(settled.hostRunEpoch, 1);
  const stepCaptures = await Promise.all(Object.values(captures).map(async path => JSON.parse(await readFile(path, 'utf8')) as { id: string; token: string; cwd: string }));
  assert.deepEqual(stepCaptures.map(entry => entry.id), [started.id, started.id, started.id]);
  assert.deepEqual(stepCaptures.map(entry => entry.token), [plan.hostRunToken, plan.hostRunToken, plan.hostRunToken]);
  const allStepOutput = settled.steps.map(step => [step.stdoutHead, step.stdoutTail, step.stderrHead, step.stderrTail].join('\n')).join('\n');
  assert.doesNotMatch(allStepOutput, new RegExp(plan.hostRunToken!));
  assert.match(allStepOutput, /\[REDACTED\]/);
  for (const step of settled.steps) for (const path of [step.stdoutLogPath, step.stderrLogPath])
    if (path) assert.doesNotMatch(await readFile(path, 'utf8'), new RegExp(plan.hostRunToken!));
});

test('a live supervisor with a stale heartbeat is terminated only after unchanged confirmation and settles lost', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'echo setup-done', teardown: 'echo teardown-done' });
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: ['/bin/sh', '-c', 'sleep 60'], timeoutMs: 120_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 100 });
  const started = await runner.run({ repository: f.repo });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { statePath } = qaSupervisionPaths(runRoot, started.id);
  await waitFor(() => readQaSupervision(statePath)?.activeProcess?.step === 'qa', 60_000, 'the supervisor to record the QA step process');
  const supervisor = readQaSupervision(statePath)!;
  assert.equal(supervisor.inFlight, 'qa', 'the QA step is in flight');
  assert.ok(supervisor.identityToken, 'the supervisor records the run identity token, so a restarted service can prove liveness');

  // A live supervisor is never reconciled away by another reader.
  const observer = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 100 });
  assert.equal((await observer.get({ id: started.id }))!.state, 'running', 'a live supervisor keeps the run running');

  const active = supervisor.activeProcess!;
  assert.equal(active.step, 'qa');
  assert.ok(active.processGroupId > 0);
  t.after(() => {
    if (processGroupHasStartIdentity(active.processGroupId, supervisor.identityToken)) {
      try { process.kill(-active.processGroupId, 'SIGKILL'); } catch { /* the QA group is already gone */ }
    }
    if (supervisorLiveness(supervisor.pid, supervisor.identityToken).state === 'live') {
      try { process.kill(-supervisor.pid, 'SIGCONT'); } catch { /* the supervisor group is already gone */ }
      try { process.kill(supervisor.pid, 'SIGKILL'); } catch { /* the supervisor is already gone */ }
    }
  });
  process.kill(supervisor.pid, 'SIGSTOP'); // freeze its event loop while preserving live identity
  assert.equal(supervisorLiveness(supervisor.pid, supervisor.identityToken).state, 'live', 'the stopped process still proves the run identity');
  writeQaSupervision(statePath, { ...supervisor, heartbeatAt: new Date(Date.now() - 240_000).toISOString() });
  assert.ok(Date.now() - Date.parse(readQaSupervision(statePath)!.heartbeatAt) > 180_000, 'the durable heartbeat exceeds the shared stale threshold');
  await observer.reconcile(started.key, started.id); // first stale observation is never enough to kill
  assert.equal(supervisorLiveness(supervisor.pid, supervisor.identityToken).state, 'live');
  await new Promise(resolve => setTimeout(resolve, 5_100));
  await observer.reconcile(started.key, started.id); // same stale heartbeat confirms a stuck supervisor

  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 40_000, 'the stale-heartbeat run to settle');
  assert.equal(processGroupEmpty(active.processGroupId), true, 'the recorded QA process group is stopped');
  assert.equal(supervisorLiveness(supervisor.pid, supervisor.identityToken).state, 'dead', 'the stale supervisor is stopped');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'lost');
  assert.equal(settled.hostSettlement?.outcome, 'lost');
  assert.match(settled.outputTail, /stale for .* unchanged across checks 5000ms apart/i);
  assert.equal(settled.interruptedStep, 'qa', 'the in-flight step is named, not lost with the run');
  assert.equal(settled.failedStep, null);
  assert.deepEqual(settled.steps.map(step => step.name), ['setup', 'teardown'], 'the prior step is kept and teardown is its own step');
  assert.equal(settled.steps.find(step => step.name === 'teardown')!.exitCode, 0);
  assert.match(settled.outputTail, /lost this QA run/);
  assert.match(settled.outputTail, /qa step was in flight/);
  const realDuration = Date.parse(settled.finishedAt!) - Date.parse(settled.startedAt);
  assert.ok(Math.abs(settled.durationMs - realDuration) < 2_000, `the lost run keeps the real duration, got ${settled.durationMs} vs ${realDuration}`);
  assert.ok(settled.durationMs > 0);
  assert.equal(existsSync(join(runRoot, started.id)), false, 'the Queue-owned checkout is reaped after teardown');
  assert.equal(readQaSupervision(statePath), null, 'the settled run removes its supervision file');
});

test('stale heartbeat ages under the watchdog threshold and heartbeat progress do not confirm a hung supervisor', () => {
  const observations = new Map<string, { heartbeatAt: string; firstObservedAt: number }>();
  const heartbeatAt = new Date(1_000).toISOString();
  assert.equal(confirmStaleSupervisorHeartbeat(observations, 'run', heartbeatAt, 16_000), null, '15 seconds is tolerated');
  assert.equal(confirmStaleSupervisorHeartbeat(observations, 'run', heartbeatAt, 61_000), null, '60 seconds is tolerated');
  const oldHeartbeat = new Date(1_000).toISOString();
  assert.equal(confirmStaleSupervisorHeartbeat(observations, 'run', oldHeartbeat, 181_002), null, 'first observation only records a candidate');
  const advancedHeartbeat = new Date(176_000).toISOString();
  assert.equal(confirmStaleSupervisorHeartbeat(observations, 'run', advancedHeartbeat, 182_000), null, 'heartbeat progress resets confirmation');
});

test('supervisor liveness trusts only the run token: a different command line is dead, an unreadable one is unknown', () => {
  const command = 'node --import tsx /queue/bin/queue-qa-supervisor.mjs /plan token-abc';
  assert.equal(supervisorLiveness(4242, 'token-abc', { alive: () => true, command: () => command }).state, 'live');
  assert.equal(supervisorLiveness(4242, 'token-abc', { alive: () => true, command: () => 'node something-else' }).state, 'dead',
    'a recycled pid runs a different command line');
  assert.equal(supervisorLiveness(4242, 'token-abc', { alive: () => true, command: () => null }).state, 'unknown',
    'an unreadable command line is never proof of death');
  assert.equal(supervisorLiveness(4242, 'token-abc', { alive: () => false, command: () => command }).state, 'dead',
    'a gone pid is proven dead');
  assert.equal(findProcessByCommandToken(`nobody-carries-${randomUUID()}`).state, 'absent',
    'a completed scan with no match is proof of absence');
  // Linux /proc can refuse a read while the process exists; that entry may be
  // the supervisor, so it must leave the scan unknown rather than absent.
  const entry = (pid: number, read: ProcCommandLine) => ({ pid, read });
  assert.equal(scanTokenVerdict([entry(1, { state: 'read', line: 'node /plan token-abc' }), entry(2, { state: 'unreadable' })], 'token-abc').state, 'found');
  assert.equal(scanTokenVerdict([entry(1, { state: 'read', line: 'node /plan other' }), entry(2, { state: 'gone' }), entry(3, { state: 'empty' })], 'token-abc').state, 'absent',
    'every entry read and ruled out is proof of absence');
  assert.equal(scanTokenVerdict([entry(1, { state: 'read', line: 'node /plan other' }), entry(2, { state: 'unreadable' })], 'token-abc').state, 'unknown',
    'an unreadable /proc entry is never proof of absence');
});

/** Seed a running row plus the plan the service wrote before spawning, for recovery tests. */
async function seedSupervisedRow(f: Awaited<ReturnType<typeof fixture>>, options: { id: string; pid: number | null; identityToken: string; startedAt: string; steps?: ProjectQaRun['steps']; argv?: string[]; base?: string; timeoutMs?: number; state?: 'queued' | 'running' }) {
  const real = await realpath(f.repo);
  const base = options.base ?? 'a'.repeat(40);
  const argv = options.argv ?? ['effigy', 'qa'];
  const timeoutMs = options.timeoutMs ?? 30_000;
  f.store.putQaRun({
    id: options.id, repository: { origin: null, path: real }, key: real, state: options.state ?? 'running',
    baseBranch: 'main', base, argv, digest: 'b'.repeat(64),
    exitCode: null, durationMs: 0, outputTail: 'partial', startedAt: options.startedAt,
    finishedAt: null, pid: options.pid, capacityWait: null, capacityUnavailable: false,
    steps: options.steps ?? [], failedStep: null, interruptedStep: null, hostSettlement: null, escapedDescendants: [], cancelReason: null,
    logWriteErrors: [],
  });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(real).slice(0, 24));
  await mkdir(runRoot, { recursive: true });
  const { planPath } = qaSupervisionPaths(runRoot, options.id);
  writeQaSupervisionPlan(planPath, qaSupervisionPlanSchema.parse({
    schema: QA_SUPERVISION_PLAN_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: options.id, key: real, caller: `queue:milestone:${digest(real).slice(0, 24)}:${options.id}`,
    base, baseBranch: 'main', startedAt: options.startedAt, startedAtMs: Date.parse(options.startedAt),
    checkoutPath: join(runRoot, options.id), registeredPath: real, runRoot,
    argv, timeoutMs, maxOutputBytes: 4096, hostRunStateDir: f.hostRunStateDir,
    hookTimeoutMs: 30_000, hookMaxOutputBytes: 4096,
    identityToken: options.identityToken, links: [],
  }));
  return real;
}

test('a restarted service settles a finished run from its durable result record', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const startedAt = new Date(Date.now() - 50).toISOString();
  const real = await seedSupervisedRow(f, { id, pid: process.pid, identityToken: 'finished-supervisor-token-1234', startedAt });
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(real).slice(0, 24));
  const { resultPath } = qaSupervisionPaths(runRoot, id);
  const record = hostRunResultSchema.parse({
    format: 'host.run.result', version: 1, runId: id, epoch: 1, pgid: 2_000_000_000,
    startIdentity: '2000000000@2026-09-30T12:00:00.000Z', exitCode: 0, signal: null,
    startedAt, endedAt: new Date().toISOString(), wallMs: 45, cpuMs: 0, escapedDescendants: [],
  });
  writeHostRunResult(resultPath, record);

  const restarted = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const settled = await restarted.get({ id });
  assert.equal(settled!.state, 'passed');
  assert.equal(settled!.hostSettlement?.format, 'host.run.settlement');
  assert.equal(settled!.hostSettlement?.outcome, 'passed');
  assert.equal(settled!.hostSettlement?.launched, true);
  assert.deepEqual(settled!.hostSettlement?.result, record);
  assert.deepEqual(readHostRunResult(resultPath, id), record, 'the durable result remains beside the settled run');
});

test('a scheduler settlement journal failure rolls back the milestone QA result too', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const startedAt = new Date(Date.now() - 100).toISOString();
  const finishedAt = new Date().toISOString();
  const argv = ['effigy', 'qa'];
  const repository = { origin: null, path: f.repo };
  const qa = projectQaRunSchema.parse({
    id, repository, key: f.repo, state: 'running', submittedAt: startedAt, queuePosition: null,
    hostRunEpoch: 1, selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone',
    runTimeoutMs: 60_000, maxOutputBytes: 4096,
    baseBranch: 'main', base: await git(f.repo, 'rev-parse', 'origin/main'), argv, digest: digest(JSON.stringify(argv)),
    exitCode: null, durationMs: 0, outputTail: '', startedAt, finishedAt: null, pid: null,
    capacityWait: null, capacityUnavailable: false, steps: [], failedStep: null,
    interruptedStep: null, hostSettlement: null, escapedDescendants: [], cancelReason: null,
  });
  f.store.putQaRun(qa);
  const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 4, memoryCapacityBytes: 1_000_000 }) });
  scheduler.adoptRunning({ id, epoch: 1, caller: `test:${id}`, repository, selector: 'qa', runClass: 'heavy', classSource: 'default',
    priority: 'milestone', runTimeoutMs: 60_000, submittedAt: startedAt, launchedAt: startedAt, pid: process.pid });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: scheduler });
  const hostResult = hostRunResultSchema.parse({
    format: 'host.run.result', version: 1, runId: id, epoch: 1, pgid: process.pid, startIdentity: `test-${id}`,
    exitCode: 0, signal: null, startedAt, endedAt: finishedAt, wallMs: 100, cpuMs: 50, escapedDescendants: [],
  });
  const outcome: QaPipelineOutcome & { interruptedStep: null } = {
    state: 'passed', exitCode: 0, durationMs: 100, detail: 'QA passed.', steps: [], failedStep: null,
    finishedAt, hostResult, escapedDescendants: [], cancelReason: null, interruptedStep: null,
  };
  const settle = (runner as unknown as { settle(run: ProjectQaRun, outcome: QaPipelineOutcome & { interruptedStep: null }): Promise<ProjectQaRun> }).settle.bind(runner);
  f.store.db.exec(`CREATE TRIGGER fail_host_settlement BEFORE INSERT ON host_run_journal
    WHEN NEW.event='settlement' BEGIN SELECT RAISE(ABORT,'injected settlement journal failure'); END`);

  await assert.rejects(settle(qa, outcome), /injected settlement journal failure/);
  assert.equal(f.store.qaRun(id)?.state, 'running', 'the companion milestone row rolled back');
  assert.equal(scheduler.get(id)?.state, 'running', 'the scheduler row rolled back');
  assert.equal(f.store.hostRunJournal(id).some(row => row.event === 'settlement'), false);

  f.store.db.exec('DROP TRIGGER fail_host_settlement');
  const settled = await settle(qa, outcome);
  assert.equal(settled.state, 'passed');
  assert.equal(scheduler.get(id)?.state, 'settled');
});

test('a bare live pid is never proof of a supervisor: a mismatched identity reconciles as lost', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  // A live pid with no matching command line, as a recycled pid or a stale plan
  // would look. Recovery must settle the run, not watch an unrelated process.
  const real = await seedSupervisedRow(f, { id, pid: process.pid, identityToken: 'not-carried-by-this-process-000000', startedAt,
    steps: [{ name: 'setup', command: 'echo setup', exitCode: 0, signal: null, timedOut: false, stdoutHead: 'setup-done', stdoutTail: '', stderrHead: '', stderrTail: '', stdoutLogPath: null, stderrLogPath: null, stdoutBytes: 0, stderrBytes: 0 }] });
  assert.equal(real.length > 0, true);
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 50 });
  const read = await runner.get({ id });
  assert.equal(read!.state, 'lost', 'the live pid does not carry the run token, so the run is not watched forever');
  assert.match(read!.outputTail, /another process/);
  assert.equal(read!.interruptedStep, null);
  assert.deepEqual(read!.steps.map(step => step.name), ['setup'], 'the steps already recorded are kept');
});

test('a claimed run with no published pid follows the live token-bearing process, and only settles lost once it is gone', async t => {
  const f = await fixture(t);
  const id = randomUUID();
  const identityToken = `boot-token-${randomUUID()}`;
  // A live process carrying the run's token, as the just-spawned supervisor is
  // after a roll between spawn and recording its pid.
  const carrier = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', identityToken], { stdio: 'ignore' });
  t.after(() => { try { carrier.kill('SIGKILL'); } catch { /* already gone */ } });
  await waitFor(() => findProcessByCommandToken(identityToken).state === 'found', 10_000, 'the token-bearing process to be visible');
  const startedAt = new Date().toISOString();
  const real = await seedSupervisedRow(f, { id, pid: null, identityToken, startedAt });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const read = await runner.get({ id });
  assert.equal(read!.state, 'running', 'a live process carrying the token keeps the run unresolved, however long it takes');
  carrier.kill('SIGKILL');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(real).slice(0, 24));
  const { statePath } = qaSupervisionPaths(runRoot, id);
  writeQaSupervision(statePath, {
    schema: QA_SUPERVISION_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: id, key: real, pid: 2_147_000_000, identityToken,
    startedAt, heartbeatAt: startedAt, inFlight: null, activeProcess: null, pendingProcessIdentity: null,
    steps: [], failedStep: null, logWriteErrors: [], detail: '', escapedDescendants: [], cancelReason: null, result: null,
  });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(id)?.state ?? ''), 30_000, 'the run to settle once the token-bearing process is gone');
  const settled = f.store.qaRun(id)!;
  assert.equal(settled.state, 'lost');
  assert.match(settled.outputTail, /Queue backend lost this QA run/);
});

test('a service restart resumes a claimed QA run before supervisor state, with a queued or running QA row', async t => {
  for (const qaState of ['queued', 'running'] as const) {
    const f = await fixture(t);
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const markerPath = join(f.dataDir, 'qa-command-count');
    const argv = [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(markerPath)}, 'x')`];
    const base = await git(f.repo, 'rev-parse', 'HEAD');
    const real = await seedSupervisedRow(f, { id, pid: null, identityToken: randomUUID(), startedAt, argv, base, timeoutMs: 60_000, state: qaState });
    const scheduler = new HostRunScheduler(f.store, { capacity: () => ({ cpuCapacity: 2, memoryCapacityBytes: 2_000_000_000,
      freeMemoryBytes: 2_000_000_000, loadAverage: [] }) });
    t.after(() => scheduler.stop());
    scheduler.adoptRunning({ id, epoch: 1, caller: `queue:milestone:${digest(real).slice(0, 24)}:${id}`,
      repository: { origin: null, path: real }, selector: 'qa', runClass: 'heavy', classSource: 'default', priority: 'milestone',
      runTimeoutMs: 60_000, launchedAt: startedAt, submittedAt: startedAt, pid: null });

    // Queue records the host launch and crashes before the detached supervisor
    // publishes initial state. Reusing the same plan is safe because that state
    // precedes checkout preparation and every QA command.
    const restarted = new ProjectQaRunner(f.store, { dataDir: f.dataDir, hostRuns: scheduler, supervisionPollMs: 25 });
    if (qaState === 'queued') await restarted.list();
    else await restarted.get({ id });
    await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(id)?.state ?? ''), 30_000, 'the restarted run to settle');
    const settledRun = f.store.qaRun(id)!;
    assert.equal(settledRun.state, 'passed', settledRun.outputTail);
    assert.equal(await readFile(markerPath, 'utf8'), 'x', 'the same QA command runs exactly once');
    assert.equal(scheduler.get(id)?.state, 'settled');
    assert.equal(scheduler.get(id)?.settlement?.outcome, 'passed');
    assert.equal(settledRun.steps.filter(step => step.name === 'qa').length, 1);
  }
});

/** #121: a staged QA setting validates slug names, uniqueness, count and the total timeout; single-argv is unchanged. */
test('a staged QA setting validates its names, count and total timeout; a single-argv setting is unchanged', () => {
  const stage = (name: string, timeoutMs = 1_000) => ({ name, argv: ['effigy', name], timeoutMs });
  const staged = projectQaSchema.parse({ stages: [stage('compile'), stage('test')] });
  assert.deepEqual(staged.stages?.map(item => item.name), ['compile', 'test']);
  assert.equal(staged.maxOutputBytes, 65_536, 'the top-level output cap is the stage default');
  assert.throws(() => projectQaSchema.parse({ stages: [stage('Compile')] }), /slug-shaped/);
  assert.throws(() => projectQaSchema.parse({ stages: [stage('a'), stage('a')] }), /unique/);
  assert.throws(() => projectQaSchema.parse({ stages: Array.from({ length: 9 }, (_, index) => stage(`s${index}`)) }), /too_big|Too big/);
  assert.throws(() => projectQaSchema.parse({ stages: [stage('setup')] }), /reserved/);
  assert.throws(() => projectQaSchema.parse({ stages: [stage('a', PROJECT_QA_TIMEOUT_MAX_MS), stage('b', 1_000)] }), /above/);
  assert.throws(() => projectQaSchema.parse({ argv: ['effigy', 'qa'], timeoutMs: 1_000, stages: [stage('a')] }), /replaces/);
  assert.throws(() => projectQaSchema.parse({}), /argv and timeoutMs/);

  const single = projectQaSchema.parse({ argv: ['effigy', 'qa'], timeoutMs: 3_600_000, maxOutputBytes: 4_096 });
  assert.deepEqual(single.argv, ['effigy', 'qa']);
  assert.equal(single.stages, undefined);
  assert.equal(single.terminationGraceMs, DEFAULT_PROCESS_TERMINATION_GRACE_MS);
});

/**
 * #121 — a staged milestone QA setting runs ordered stages as separate recorded
 * steps, one scheduler admission, with each step's full output in a log beside
 * the run. A single-argv setting stays exactly one "qa" step.
 */
async function setStages(f: Awaited<ReturnType<typeof fixture>>, stages: Array<{ name: string; argv: string[]; timeoutMs: number; maxOutputBytes?: number }>, terminationGraceMs = 30_000) {
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null, { stages, terminationGraceMs });
}

test('a staged QA setting runs every stage in order as its own step under one admission', async t => {
  const f = await fixture(t);
  const scripts = { compile: 'process.stdout.write("compiled\\n")', test: 'process.stdout.write("tested\\n")' };
  await setStages(f, [
    { name: 'compile', argv: [process.execPath, '-e', scripts.compile], timeoutMs: 30_000 },
    { name: 'test', argv: [process.execPath, '-e', scripts.test], timeoutMs: 40_000 },
  ]);
  const order: string[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => {
      const script = request.argv[1];
      order.push(script === scripts.compile ? 'compile' : 'test');
      return result(0, script === scripts.compile ? 'compiled\n' : 'tested\n');
    },
  });
  const started = await runner.run({ repository: f.repo });
  assert.deepEqual(started.stages?.map(stage => stage.name), ['compile', 'test'], 'the run records its ordered stages');
  assert.equal(started.runTimeoutMs, 70_000 + 2 * DEFAULT_PROJECT_QA_TIMEOUT_MS, 'one admission envelopes setup, the stage timeouts and teardown');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the staged run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(order, ['compile', 'test'], 'stages run in order without re-queuing');
  assert.deepEqual(settled.steps.map(step => step.name), ['compile', 'test']);
  assert.equal(settled.failedStep, null);
  assert.match(settled.steps.find(step => step.name === 'compile')!.stdoutHead, /compiled/);
  assert.match(settled.steps.find(step => step.name === 'test')!.stdoutHead, /tested/);
});

test('a failing first stage stops the run, teardown still runs, and failedStep names the stage', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'echo teardown-ran' });
  const scripts = { compile: 'process.exit(5)', test: 'process.exit(0)' };
  await setStages(f, [
    { name: 'compile', argv: [process.execPath, '-e', scripts.compile], timeoutMs: 30_000 },
    { name: 'test', argv: [process.execPath, '-e', scripts.test], timeoutMs: 30_000 },
  ]);
  const calls: string[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    worktreeHookRun: async () => { calls.push('teardown'); return result(0, 'teardown-ran\n'); },
    run: async request => {
      const compile = request.argv[1] === scripts.compile;
      calls.push(compile ? 'compile' : 'test');
      return result(compile ? 5 : 0, compile ? 'clippy: error at column 42\n' : 'should not run\n');
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the failing staged run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed');
  assert.equal(settled.failedStep, 'compile', 'failedStep names the first failing stage');
  assert.deepEqual(calls, ['compile', 'teardown'], 'the second stage never runs and teardown still does');
  assert.deepEqual(settled.steps.map(step => step.name), ['compile', 'teardown']);
  assert.match(settled.outputTail, /clippy: error at column 42/);
});

test('a stage timeout terminates that stage group, records the step and stops the run', async t => {
  const f = await fixture(t);
  const script = "trap '' TERM; exec sleep 60";
  await setStages(f, [
    { name: 'slow', argv: ['/bin/sh', '-c', script], timeoutMs: 250 },
    { name: 'after', argv: [process.execPath, '-e', 'process.stdout.write("after\\n")'], timeoutMs: 30_000 },
  ], 100);
  // A process outside the stage's group: a scoped termination must leave it alive.
  const carrier = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { carrier.kill('SIGKILL'); } catch { /* already gone */ } });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the timed-out stage group to stop');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'timed_out');
  const slow = settled.steps.find(step => step.name === 'slow')!;
  assert.equal(slow.timedOut, true);
  assert.equal(slow.terminationSignal, 'SIGKILL', 'SIGKILL follows the configured SIGTERM grace');
  assert.equal(slow.processGroupEmpty, true);
  assert.ok(!settled.steps.some(step => step.name === 'after'), 'the stage after a timeout never runs');
  assert.doesNotThrow(() => process.kill(carrier.pid!, 0), 'a process outside the stage group is untouched');
});

test('a single-argv QA setting keeps its legacy record: one qa step and no stages', async t => {
  const f = await fixture(t);
  const argv = [process.execPath, '-e', 'process.stdout.write("plain\\n")'];
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv, timeoutMs: 30_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: async () => result(0, 'plain\n') });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the single-argv run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed');
  assert.deepEqual(settled.argv, argv);
  assert.equal(settled.stages, undefined, 'a single-argv run records no synthetic stages');
  assert.deepEqual(settled.steps.map(step => step.name), ['qa']);
  assert.equal(settled.runTimeoutMs, 30_000, 'the legacy run timeout is the configured command timeout');
});

test('a failing stage records full output beyond the short excerpt in its log', async t => {
  const f = await fixture(t);
  const marker = 'clippy-error-at-column-42';
  // The marker sits in the middle: past the 512-byte head and before the 512-byte tail.
  const output = Buffer.from(`${'before line that is not the error\n'.repeat(200)}${marker}\n${'after line that is not the error\n'.repeat(200)}`);
  await setStages(f, [{ name: 'clippy', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 30_000, maxOutputBytes: 65_536 }]);
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, run: async () => ({ ...result(1), stdout: output, durationMs: 3 }) });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the failing stage to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed');
  const clippy = settled.steps.find(step => step.name === 'clippy')!;
  assert.ok(clippy.stdoutLogPath, 'the step records its full-output log path');
  assert.equal(clippy.stdoutBytes, output.length, 'the log byte count is the retained stream length');
  assert.ok(clippy.stdoutLogPath!.startsWith(await realpath(f.dataDir)), 'the log lives beside the run under the QA root');
  assert.equal((await stat(clippy.stdoutLogPath!)).mode & 0o777, 0o600, 'the log is owner-only');
  const logged = await readFile(clippy.stdoutLogPath!, 'utf8');
  assert.match(logged, /clippy-error-at-column-42/, 'the log holds output the excerpt drops');
  assert.doesNotMatch(clippy.stdoutHead + clippy.stdoutTail, /clippy-error-at-column-42/, 'the short excerpt alone would have lost it');
});

test('a later stage failure is reported by the host result, not the first stage success', async t => {
  const f = await fixture(t);
  await setStages(f, [
    { name: 'compile', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 30_000 },
    { name: 'test', argv: [process.execPath, '-e', 'process.exit(7)'], timeoutMs: 30_000 },
  ]);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => result(request.argv[1].includes('7') ? 7 : 0, request.argv[1].includes('7') ? 'test failed\n' : 'compiled\n'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the later-stage failure to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed');
  assert.equal(settled.exitCode, 7);
  assert.equal(settled.failedStep, 'test');
  assert.equal(settled.hostSettlement?.outcome, 'failed');
  assert.equal(settled.hostSettlement?.result?.exitCode, 7, 'the host result carries the failing stage exit, never the first stage 0');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { resultPath } = qaSupervisionPaths(runRoot, started.id);
  assert.equal(readHostRunResult(resultPath, started.id)?.exitCode, 7, 'the durable host result agrees with the failed run');
});

test('a step log that cannot be written is reported, not silently shown as missing output', async t => {
  const f = await fixture(t);
  await setStages(f, [{ name: 'compile', argv: [process.execPath, '-e', 'process.exit(1)'], timeoutMs: 30_000 }]);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    logWrite: () => ({ bytes: null, error: 'injected log-write failure' }),
    run: async () => result(1, 'clippy: error\n'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the run with a failing log writer to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'failed');
  const compile = settled.steps.find(step => step.name === 'compile')!;
  assert.equal(compile.stdoutLogPath, null);
  assert.equal(compile.stdoutBytes, 0);
  assert.match(settled.outputTail, /injected log-write failure/, 'the log-write failure is visible on the run');
  assert.match(settled.outputTail, /Full-output log for step compile \(stdout\)/);
});

test('a setup-step log-write failure survives setup output and a setup failure', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'echo setup-with-output' });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    logWrite: () => ({ bytes: null, error: 'injected setup log-write failure' }),
    worktreeHookRun: async request => request.argv[1] === 'fail-setup' ? result(1, 'setup progress\n') : result(0, 'setup output\n'),
    run: async () => result(0, 'qa ok\n'),
  });
  // A passing setup that emitted output must not replace the log diagnostic.
  const passedSetup = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(passedSetup.id)?.state ?? ''), 30_000, 'the passing setup run to settle');
  const passed = f.store.qaRun(passedSetup.id)!;
  assert.equal(passed.state, 'passed', passed.outputTail);
  assert.match(passed.outputTail, /injected setup log-write failure/, 'the diagnostic survives a passing setup that emitted output');
  assert.match(passed.outputTail, /Worktree setup output/);

  // A failing setup likewise appends its failure beside the diagnostic.
  await setWorktreeHooks(f, { setup: 'fail-setup' });
  const failedSetup = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(failedSetup.id)?.state ?? ''), 30_000, 'the failing setup run to settle');
  const settled = f.store.qaRun(failedSetup.id)!;
  assert.equal(settled.state, 'hold');
  assert.equal(settled.failedStep, 'setup');
  assert.match(settled.outputTail, /injected setup log-write failure/, 'the diagnostic survives a setup failure');
  assert.match(settled.outputTail, /worktree setup failed/i);
  assert.match(settled.outputTail, /setup progress/);
});

test('a log-write failure survives later output: the run reports it apart from the truncated output tail', async t => {
  const f = await fixture(t);
  // Far more output than the 2,000-character tail keeps, so only a separate field can carry the diagnostic.
  const output = `first line\n${'noisy output line that must not evict the diagnostic\n'.repeat(120)}last line\n`;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    logWrite: () => ({ bytes: null, error: 'injected log-write failure' }),
    run: async () => result(0, output),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the chatty run with a failing log writer to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.logWriteErrors.map(entry => [entry.step, entry.stream, entry.error]),
    [['qa', 'stdout', 'injected log-write failure'], ['qa', 'stderr', 'injected log-write failure']],
    'the log-write failure stays on its own bounded field');
  assert.ok(settled.outputTail.length <= 2000, 'the output tail is still bounded');
  assert.doesNotMatch(settled.outputTail, /could not be written/, 'later output pushed the diagnostic out of the tail');
});

test('log-write failures are bounded to the newest sixteen on the run record', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'echo setup', teardown: 'echo teardown' });
  await setStages(f, Array.from({ length: 8 }, (_, index) => ({ name: `stage-${index}`, argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 30_000 })));
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    logWrite: () => ({ bytes: null, error: 'injected log-write failure' }),
    worktreeHookRun: async () => result(0, 'hook output'),
    run: async () => result(0, 'stage output'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the many-step run with a failing log writer to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.equal(settled.steps.length, 10, 'setup, eight stages and teardown each recorded a step');
  assert.equal(settled.logWriteErrors.length, 16, 'ten steps times two streams are capped at sixteen entries');
});

test('the host envelope covers setup and teardown so a slow setup and near-budget stage cannot shorten the next stage', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { setup: 'sleep 0.3' });
  // Measure the stage windows without charging Node bootstrap against these short waits.
  await setStages(f, [
    { name: 'compile', argv: ['/bin/sh', '-c', 'exec sleep 0.7'], timeoutMs: 1_000 },
    { name: 'test', argv: ['/bin/sh', '-c', 'exec sleep 0.9'], timeoutMs: 1_500 },
  ]);
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25 });
  const started = await runner.run({ repository: f.repo });
  assert.equal(started.runTimeoutMs, 1_000 + 1_500 + 2 * DEFAULT_PROJECT_QA_TIMEOUT_MS,
    'the envelope covers setup and teardown beside every stage window, not just the stage total');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 60_000, 'the staged run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  const compile = settled.steps.find(step => step.name === 'compile')!;
  const testStep = settled.steps.find(step => step.name === 'test')!;
  assert.ok(compile.wallMs !== undefined && compile.wallMs >= 600, `the first stage used most of its budget (${compile.wallMs}ms)`);
  assert.equal(testStep.timedOut, false, 'the second stage is not cut short by setup or the earlier stage');
  assert.equal(testStep.signal, null);
  assert.ok(testStep.wallMs !== undefined && testStep.wallMs >= 800, `the second stage received its full configured window (${testStep.wallMs}ms)`);
});

test('a passing staged run whose first stage is named qa reports the last stage in the host result', async t => {
  const f = await fixture(t);
  await setStages(f, [
    { name: 'qa', argv: [process.execPath, '-e', 'process.stdout.write("qa\\n")'], timeoutMs: 30_000 },
    { name: 'studio', argv: [process.execPath, '-e', 'process.stdout.write("studio\\n")'], timeoutMs: 30_000 },
  ]);
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => {
      const studio = request.argv[1].includes('studio');
      return { ...result(0, studio ? 'studio\n' : 'qa\n'), pid: studio ? 7102 : 7101, processGroupId: studio ? 7102 : 7101,
        startIdentity: studio ? 'studio-start' : 'qa-start', leaderStartIdentity: studio ? 'studio-leader' : 'qa-leader' };
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the two-stage pass to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.equal(settled.steps.find(step => step.name === 'qa')?.processGroupId, 7101);
  assert.equal(settled.steps.find(step => step.name === 'studio')?.processGroupId, 7102);
  assert.equal(settled.hostSettlement?.result?.pgid, 7102, 'the host result names the last executed stage, not the earlier qa stage');
  assert.equal(settled.hostSettlement?.result?.startIdentity, 'studio-start');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { resultPath } = qaSupervisionPaths(runRoot, started.id);
  assert.equal(readHostRunResult(resultPath, started.id)?.pgid, 7102, 'the durable host result identifies the latter stage');
  assert.equal(readHostRunResult(resultPath, started.id)?.startIdentity, 'studio-start');
});

test('a settled teardown failure retries in place to passed and keeps both teardown attempts', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'retire-container-scope' });
  let teardownFails = true;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async request => request.argv[1] === 'retire-container-scope' && teardownFails
      ? { ...result(1, 'error: colima profile effigy-release is not running'), stderr: Buffer.from('error: colima profile effigy-release is not running\n'), durationMs: 4 }
      : result(0, 'teardown ok'),
    run: async () => result(0, 'qa passed'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 30_000, 'the teardown hold to settle');
  const held = f.store.qaRun(started.id)!;
  assert.equal(held.failedStep, 'teardown');
  const qaBefore = held.steps.find(step => step.name === 'qa')!;
  assert.equal(qaBefore.exitCode, 0);
  assert.equal(held.steps.filter(step => step.name === 'teardown').length, 1);
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(held.key).slice(0, 24));
  const checkout = join(runRoot, held.id);
  assert.ok(existsSync(checkout), 'a failed teardown retains the Queue-owned checkout');
  assert.equal(projectQaRetryTeardownInputSchema.safeParse({ id: held.id, reason: 'colima restarted' }).success, true);
  assert.equal(projectQaRetryTeardownInputSchema.safeParse({ id: held.id, reason: ' ' }).success, false);

  teardownFails = false;
  const retried = await runner.retryTeardown({ id: held.id, reason: 'colima restarted' });
  assert.equal(retried.state, 'passed', retried.outputTail);
  const settled = f.store.qaRun(held.id)!;
  assert.equal(settled.state, 'passed');
  assert.equal(settled.failedStep, null, 'a settled passed run no longer names teardown as failed');
  assert.deepEqual(settled.steps.find(step => step.name === 'qa'), qaBefore, 'the QA step result, exit code and output are unchanged');
  assert.equal(settled.steps.filter(step => step.name === 'teardown').length, 2, 'both teardown attempts are kept');
  assert.equal(existsSync(checkout), false, 'a successful teardown retry removes the checkout');
  assert.equal(settled.teardownRetryAttempt, 1);
});

test('a staged run whose teardown fails then retries keeps every stage log and both teardown logs', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'retire-container-scope' });
  await setStages(f, [
    { name: 'compile', argv: [process.execPath, '-e', 'process.stdout.write("compile output")'], timeoutMs: 30_000 },
    { name: 'test', argv: [process.execPath, '-e', 'process.stdout.write("test output")'], timeoutMs: 30_000 },
  ]);
  let teardownAttempts = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    worktreeHookRun: async request => {
      if (request.argv[1] === 'retire-container-scope') {
        teardownAttempts++;
        return teardownAttempts === 1
          ? { ...result(1, 'first teardown output'), stderr: Buffer.from('teardown broke\n') }
          : result(0, 'second teardown output');
      }
      return result(0, 'setup output');
    },
    run: async request => result(0, request.argv[1].includes('compile') ? 'compile output' : 'test output'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 30_000, 'the staged teardown hold to settle');
  const held = f.store.qaRun(started.id)!;
  assert.equal(held.failedStep, 'teardown');
  const compile = held.steps.find(step => step.name === 'compile')!;
  const testStep = held.steps.find(step => step.name === 'test')!;
  const firstTeardown = held.steps.find(step => step.name === 'teardown')!;
  const compileLog = compile.stdoutLogPath!;
  const testLog = testStep.stdoutLogPath!;
  const firstTeardownLog = firstTeardown.stdoutLogPath!;
  assert.ok(existsSync(compileLog) && existsSync(testLog) && existsSync(firstTeardownLog), 'each step wrote its own full-output log');
  assert.match(await readFile(compileLog, 'utf8'), /compile output/);
  assert.match(await readFile(testLog, 'utf8'), /test output/);
  assert.match(await readFile(firstTeardownLog, 'utf8'), /first teardown output/);

  const retried = await runner.retryTeardown({ id: held.id, reason: 'colima restarted' });
  assert.equal(retried.state, 'passed', retried.outputTail);
  const settled = f.store.qaRun(held.id)!;
  assert.deepEqual(settled.steps.map(step => step.name), ['compile', 'test', 'teardown', 'teardown'], 'the retry appends a teardown attempt');
  assert.ok(existsSync(compileLog) && existsSync(testLog), 'the retry never removes an earlier stage log');
  assert.match(await readFile(compileLog, 'utf8'), /compile output/, 'the compile log is unchanged');
  assert.match(await readFile(testLog, 'utf8'), /test output/, 'the test log is unchanged');
  assert.ok(existsSync(firstTeardownLog), 'the failed teardown attempt keeps its own log');
  const secondTeardown = settled.steps.filter(step => step.name === 'teardown')[1]!;
  assert.ok(secondTeardown.stdoutLogPath && secondTeardown.stdoutLogPath !== firstTeardownLog, 'the retry writes its own attempt-numbered log');
  assert.match(await readFile(secondTeardown.stdoutLogPath!, 'utf8'), /second teardown output/);
});

test('a teardown retry that fails again stays hold with the new attempt recorded', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'retire-container-scope' });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async () => result(1, 'colima still stopped'),
    run: async () => result(0, 'qa passed'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 30_000, 'the first teardown failure to settle');
  const retried = await runner.retryTeardown({ id: started.id, reason: 'try again' });
  assert.equal(retried.state, 'hold');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold', 'a retry that fails again keeps the run on hold');
  assert.equal(settled.failedStep, 'teardown');
  assert.equal(settled.steps.filter(step => step.name === 'teardown').length, 2, 'the retry attempt is appended');
  assert.match(settled.outputTail, /teardown retry: try again/i);
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(settled.key).slice(0, 24));
  assert.ok(existsSync(join(runRoot, settled.id)), 'a failed retry still retains the checkout');
});

test('a teardown retry is refused for a run not failed at teardown', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'retire-container-scope' });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async () => result(0, 'teardown ok'),
    run: async () => result(7, 'qa failed'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'failed', 30_000, 'the QA failure to settle');
  assert.equal(f.store.qaRun(started.id)!.failedStep, 'qa');
  await assert.rejects(() => runner.retryTeardown({ id: started.id, reason: 'not teardown' }),
    /did not fail at teardown/);
});

test('a teardown retry is refused while a supervisor is live', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'retire-container-scope' });
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, worktreeHookRun: async () => result(1, 'colima stopped'),
    run: async () => result(0, 'qa passed'),
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 30_000, 'the teardown failure to settle');
  // A settled run whose supervisor is still live: a token-bearing process plus
  // the plan the service would have written before spawning it.
  const identityToken = `live-retry-token-${randomUUID()}`;
  const carrier = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', identityToken], { stdio: 'ignore' });
  t.after(() => { try { carrier.kill('SIGKILL'); } catch { /* already gone */ } });
  await waitFor(() => findProcessByCommandToken(identityToken).state === 'found', 10_000, 'the live supervisor carrier to appear');
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(started.key).slice(0, 24));
  const { planPath } = qaSupervisionPaths(runRoot, started.id);
  writeQaSupervisionPlan(planPath, qaSupervisionPlanSchema.parse({
    schema: QA_SUPERVISION_PLAN_SCHEMA, schema_version: QA_SUPERVISION_SCHEMA_VERSION,
    runId: started.id, key: started.key, caller: `queue:qa:${started.key}:${started.id}`,
    base: started.base, baseBranch: 'main', startedAt: started.startedAt, startedAtMs: Date.parse(started.startedAt),
    checkoutPath: join(runRoot, started.id), registeredPath: f.repo, runRoot,
    argv: started.argv, timeoutMs: 30_000, maxOutputBytes: 4096, hookTimeoutMs: 30_000, hookMaxOutputBytes: 4096,
    identityToken, links: [],
  }));
  await assert.rejects(() => runner.retryTeardown({ id: started.id, reason: 'while live' }), /live supervisor/);
});

test('the detached supervisor reruns only teardown and settles to the QA result it implies', async t => {
  const f = await fixture(t);
  await setWorktreeHooks(f, { teardown: 'test -f .allow-teardown' });
  f.store.putRepository({ origin: null, path: f.repo }, null, '', null, null,
    { argv: ['/bin/sh', '-c', 'echo qa-ok'], timeoutMs: 60_000, maxOutputBytes: 4096, terminationGraceMs: 30_000 });
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 50 });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => f.store.qaRun(started.id)?.state === 'hold', 60_000, 'the detached teardown failure to settle');
  const held = f.store.qaRun(started.id)!;
  assert.equal(held.failedStep, 'teardown');
  const qaBefore = held.steps.find(step => step.name === 'qa')!;
  assert.equal(qaBefore.exitCode, 0);
  const runRoot = join(await realpath(f.dataDir), 'project-qa', digest(held.key).slice(0, 24));
  const checkout = join(runRoot, held.id);
  assert.ok(existsSync(checkout), 'a failed detached teardown retains the checkout');
  await writeFile(join(checkout, '.allow-teardown'), 'yes\n');

  const retrying = await runner.retryTeardown({ id: held.id, reason: 'colima restarted' });
  assert.equal(retrying.state, 'running', 'the retry runs through a detached supervisor');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(held.id)?.state ?? ''), 60_000, 'the detached teardown retry to settle');
  const settled = f.store.qaRun(held.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.steps.find(step => step.name === 'qa'), qaBefore, 'the QA step result, exit code and output are unchanged');
  assert.equal(settled.steps.filter(step => step.name === 'teardown').length, 2);
  assert.equal(existsSync(checkout), false, 'a successful detached teardown retry removes the checkout');
});

/**
 * Papercut 65c2883a — a staged milestone setting's parent admission class must
 * cover every stage in any order, with exact classification evidence. The
 * original incident (invalid_parent_token) had no retained first-stage
 * evidence; #121 already aggregated all stages, so these cases pin the actual
 * boundary rather than the unproven light-first theory: a light first stage
 * never makes a later heavy stage light, and the recorded source names where
 * the class the run took actually came from.
 */
async function setEffigyManifest(f: Awaited<ReturnType<typeof fixture>>, tables: string) {
  await writeFile(join(f.repo, 'effigy.toml'), tables);
  await git(f.repo, 'add', 'effigy.toml');
  await git(f.repo, 'commit', '-m', 'declare Effigy admission classes');
  await git(f.repo, 'push', 'origin', 'main');
}

interface QaCapturedLaunch {
  token: string;
  verified: ReturnType<typeof verifyRunToken>;
}

/** Verify a stage's inherited credential while its run checkout still exists. */
async function captureLaunch(f: Awaited<ReturnType<typeof fixture>>, request: ExecutionRequest): Promise<QaCapturedLaunch> {
  const token = request.env.HOST_RUN_TOKEN ?? '';
  const keys = readHostRunTokenKeys(f.hostRunStateDir)!;
  return { token, verified: verifyRunToken(token, { keys, epoch: keys.current.epoch, cwd: await realpath(request.root) }) };
}

test('a staged QA setting takes its parent class from the heaviest stage, so a light first stage cannot make a later heavy stage light', async t => {
  const f = await fixture(t);
  await setEffigyManifest(f, '[tasks."qa:docs"]\nadmission = "light"\n');
  await setStages(f, [
    { name: 'docs', argv: ['effigy', 'qa:docs'], timeoutMs: 30_000 },
    { name: 'tests', argv: ['effigy', 'test'], timeoutMs: 30_000 },
  ]);
  // The first stage on its own is genuinely light: a first-stage-only parent
  // would admit this run as light.
  assert.deepEqual(classifyHostRun(f.repo, 'qa:docs'), { runClass: 'light', classSource: 'manifest' });
  assert.deepEqual(classifyHostRun(f.repo, 'test'), { runClass: 'heavy', classSource: 'default' });
  const launches: QaCapturedLaunch[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => {
      launches.push(await captureLaunch(f, request));
      return result(0, `${request.argv[1]} passed\n`);
    },
  });
  const started = await runner.run({ repository: f.repo });
  assert.equal(started.runClass, 'heavy', 'a later heavy stage must never inherit a light first stage');
  assert.equal(started.classSource, 'default', 'the manifest declared only the light stage, so it did not select the heavy class');
  assert.equal(f.store.hostRun(started.id)?.runClass, 'heavy', 'the host-run admission carries the heaviest stage');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the staged run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  assert.deepEqual(settled.steps.map(step => step.name), ['docs', 'tests'], 'both stages ran in order');
  assert.equal(launches.length, 2, 'each stage launched under the run environment');
  for (const launch of launches) {
    assert.equal(launch.verified.valid, true, 'each stage inherits the run parent token at the run checkout');
    if (launch.verified.valid) {
      assert.equal(launch.verified.claims.class, 'heavy', 'the launch credential carries the heaviest stage, not the first stage');
      assert.equal(launch.verified.claims.runId, started.id);
    }
  }
  assert.equal(new Set(launches.map(launch => launch.token)).size, 1, 'every stage of one run shares one parent token');
});

test('a manifest-declared heavy stage keeps the staged parent heavy through a later light stage and records manifest evidence', async t => {
  const f = await fixture(t);
  await setEffigyManifest(f, '[tasks."test"]\nadmission = "heavy"\n\n[tasks."qa:docs"]\nadmission = "light"\n');
  await setStages(f, [
    { name: 'tests', argv: ['effigy', 'test'], timeoutMs: 30_000 },
    { name: 'docs', argv: ['effigy', 'qa:docs'], timeoutMs: 30_000 },
  ]);
  const launches: QaCapturedLaunch[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => { launches.push(await captureLaunch(f, request)); return result(0); },
  });
  const started = await runner.run({ repository: f.repo });
  assert.equal(started.runClass, 'heavy', 'the heavy first stage still governs the parent class');
  assert.equal(started.classSource, 'manifest', 'the manifest selected the heavy class the run took');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the heavy-first staged run to settle');
  for (const launch of launches) {
    assert.equal(launch.verified.valid, true, 'the heavy parent token verifies at the run checkout');
    if (launch.verified.valid) assert.equal(launch.verified.claims.class, 'heavy');
  }
});

test('an all-light staged setting stays light and issues a light parent token', async t => {
  const f = await fixture(t);
  await setEffigyManifest(f, '[tasks."qa:docs"]\nadmission = "light"\n\n[tasks."lint"]\nadmission = "light"\n');
  await setStages(f, [
    { name: 'docs', argv: ['effigy', 'qa:docs'], timeoutMs: 30_000 },
    { name: 'lint', argv: ['effigy', 'lint'], timeoutMs: 30_000 },
  ]);
  assert.deepEqual(classifyHostRun(f.repo, 'lint'), { runClass: 'light', classSource: 'manifest' });
  const launches: QaCapturedLaunch[] = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, supervisionPollMs: 25,
    run: async request => { launches.push(await captureLaunch(f, request)); return result(0); },
  });
  const started = await runner.run({ repository: f.repo });
  assert.equal(started.runClass, 'light', 'no stage is heavy, so the parent stays light');
  assert.equal(started.classSource, 'manifest', 'the manifest selected every light class');
  assert.equal(f.store.hostRun(started.id)?.runClass, 'light');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the all-light staged run to settle');
  for (const launch of launches) {
    assert.equal(launch.verified.valid, true);
    if (launch.verified.valid) assert.equal(launch.verified.claims.class, 'light', 'the parent token follows the run class, not a fixed value');
  }
});

test('staged classification reads only the selected checkout manifest and falls back to Queue defaults for missing or unknown declarations', async t => {
  const f = await fixture(t);
  // An unrelated manifest one directory above the registered checkout, and one
  // the checkout tries to include from outside itself, must both be ignored.
  await writeFile(join(f.root, 'effigy.toml'), '[tasks."test"]\nadmission = "light"\n');
  await writeFile(join(f.root, 'outside.toml'), '[tasks."test"]\nadmission = "light"\n');
  await writeFile(join(f.repo, 'effigy.toml'), 'include = ["../outside.toml"]\n');
  assert.deepEqual(classifyHostRun(f.repo, 'test'), { runClass: 'heavy', classSource: 'default' });
  await setStages(f, [{ name: 'tests', argv: ['effigy', 'test'], timeoutMs: 30_000 }]);
  const runner = new ProjectQaRunner(f.store, { dataDir: f.dataDir, supervisionPollMs: 25, run: async () => result(0) });
  const started = await runner.run({ repository: f.repo });
  assert.equal(started.runClass, 'heavy', 'an unrelated manifest cannot set the selected checkout class');
  assert.equal(started.classSource, 'default');
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the default-class run to settle');

  // The existing contract reads a missing or unknown declaration as Queue's
  // default list, never as a refusal to classify.
  await writeFile(join(f.repo, 'effigy.toml'), '[tasks."test"]\nnote = "no admission declared"\n');
  assert.deepEqual(classifyHostRun(f.repo, 'test'), { runClass: 'heavy', classSource: 'default' });
  await writeFile(join(f.repo, 'effigy.toml'), '[tasks."test"]\nadmission = "medium"\n');
  assert.deepEqual(classifyHostRun(f.repo, 'test'), { runClass: 'heavy', classSource: 'default' });
  assert.deepEqual(classifyHostRun(f.repo, 'test', true), { runClass: 'light', classSource: 'default' });

  // Missing or unknown stage configuration is refused by the existing QA-setting
  // schema before classification runs, so no unknown stage is admitted at all.
  assert.throws(() => projectQaSchema.parse({ stages: [{ name: 'docs', argv: ['effigy', 'qa:docs'], timeoutMs: 30_000, shell: true }] }),
    /Unrecognized key/);
  assert.throws(() => projectQaSchema.parse({ stages: [{ name: 'docs', argv: ['effigy', 'qa:docs'] }] }),
    /expected number, received undefined/);
});

test("a QA stage environment uses the run-scratch leaf and the leaf is gone after settlement", async t => {
  const f = await fixture(t);
  const { mount, scratch } = fixtureRunScratch(f.root);
  const decoy = process.env.TMPDIR;
  assert.ok(decoy, 'the service process has a TMPDIR; old code would copy it');
  const seen: Array<{ tmpdir?: string; tmp?: string; temp?: string; leafLived: boolean }> = [];
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, runScratch: scratch,
    run: async request => {
      const tmpdir = request.env.TMPDIR, tmp = request.env.TMP, temp = request.env.TEMP;
      seen.push({ tmpdir, tmp, temp, leafLived: Boolean(tmpdir && existsSync(tmpdir)) });
      return result(0, 'ok\n');
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the scratch QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'passed', settled.outputTail);
  const namespace = f.store.scratchNamespaceFor({ repoPath: settled.repository.path, repository: settled.repository.origin });
  const expected = runTemporaryDirectory(started.id, runScratchRoot(mount, namespace));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.tmpdir, expected);
  assert.equal(seen[0]!.tmp, expected);
  assert.equal(seen[0]!.temp, expected);
  assert.equal(seen[0]!.leafLived, true, 'the leaf exists while the stage runs');
  assert.notEqual(seen[0]!.tmpdir, decoy, 'old code copied the service TMPDIR; the stage must not inherit it');
  assert.ok(seen[0]!.tmpdir!.startsWith(`${mount}/scratch/${namespace}/`));
  assert.equal(settled.temporaryDirectory, expected);
  assert.equal(existsSync(expected), false, 'the leaf is removed once the run settles and the checkout is gone');
});

test("an absent scratch volume refuses the QA launch and never falls back to the service TMPDIR", async t => {
  const f = await fixture(t);
  const mount = join(f.root, 'missing-volume');
  const volume: CheckoutVolumeInfo = { MountPoint: mount, VolumeUUID: 'fixture', Internal: false, Writable: true, WritableVolume: true };
  const scratch = checkoutRunScratchPlacement({ mount, uuid: 'fixture', observe: () => volume });
  const decoy = process.env.TMPDIR;
  let commands = 0;
  const runner = new ProjectQaRunner(f.store, {
    dataDir: f.dataDir, runScratch: scratch,
    run: async request => {
      commands++;
      assert.notEqual(request.env.TMPDIR, decoy);
      return result(0);
    },
  });
  const started = await runner.run({ repository: f.repo });
  await waitFor(() => !['queued', 'running'].includes(f.store.qaRun(started.id)?.state ?? ''), 30_000, 'the refused scratch QA run to settle');
  const settled = f.store.qaRun(started.id)!;
  assert.equal(settled.state, 'hold');
  assert.match(settled.outputTail, /storage unavailable|checkout storage unavailable/i);
  assert.equal(commands, 0, 'no stage launched, so nothing inherited the service TMPDIR');
  assert.equal(existsSync(join(mount, 'scratch')), false, 'the absent mount was not created on the internal drive');
  assert.equal(settled.temporaryDirectory, undefined);
});
