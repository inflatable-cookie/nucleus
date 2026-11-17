import { fakeAdapter, observeIdle } from './support/fakes';
import { paseoCatalog } from './support/pool-shapes';
import { configuredClone, materializeSeed } from './support/git-seed';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, symlink, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { submissionSchema, type Profile } from '../shared/contracts';
import { PaseoAdapter, type Adapter } from '../service/paseo-composition';
import { command, git, withIntegrationCheckout, cleanupIntegrationCheckout, validateDispatch, verifyWorkspace, proveRebindableDispatchBase } from '../core/git/index';
import type { Task } from '../shared/contracts';
import { syncMain, integrationBaseGate, verifyCloseoutPublication } from '../core/forge/index';
import { briefDigest } from '../core/planning/brief';
import { RepositoryHooks } from '../core/hooks/hooks';
import { ensureTaskNodeModules } from '../core/workspaces/task-node-modules';

/**
 * The integration checkout is the queue's own, and a branch that is merely behind is a
 * fast-forward. Refusing dispatch on it created a loop live: the only thing that synced
 * the branch was the closeout of a task that had already merged, while the refusal
 * blocked the tasks that would have produced one.
 */
async function makeRepo(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-dispatch-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(configuredClone, root);
  const repo = join(root, 'repo');
  return { root, repo };
}

async function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const handoff = 'plan';
const dispatchTask = (repo: string, planningCommit: string) => ({
  repoPath: repo, baseBranch: 'main', branch: 'ns-task', planningCommit,
  handoffPath: 'docs/handoff.md', handoffText: handoff,
}) as unknown as Task;

async function reviewLockfileFixture(t: any) {
  const { root, repo } = await makeRepo(t);
  const writeDependency = async (directory: string, version: string) => {
    const dependency = join(directory, 'vendor', 'fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dep', version, main: 'index.js' }));
    await writeFile(join(dependency, 'index.js'), `module.exports = { version: '${version}' };\n`);
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await writeFile(join(directory, '.npmrc'), 'install-links=true\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'review-lockfile-fixture', version: '1.0.0', dependencies: { 'fixture-dep': 'file:vendor/fixture-dep' } }));
    await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  };
  await writeDependency(repo, '1.0.0');
  const planning = await commit(repo, 'initial dependency lockfile', { 'docs/handoff.md': handoff, '.gitignore': 'node_modules/\n' });
  await git(repo, 'push', 'origin', 'main');
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], repo);
  const workspaceRoot = join(root, 'review-workspaces');
  await mkdir(workspaceRoot);
  await symlink(join(repo, 'node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  const taskDirectory = join(workspaceRoot, 'review-task');
  await git(repo, 'worktree', 'add', '-b', 'ns-review-task', taskDirectory, planning);
  // This is the worker's initial install. The PR then changes its lockfile.
  await ensureTaskNodeModules(taskDirectory, repo, workspaceRoot);
  await writeDependency(taskDirectory, '2.0.0');
  const head = await commit(taskDirectory, 'update dependency lockfile in PR', {
    '.gitignore': 'node_modules/\n', '.npmrc': 'install-links=true\n',
    'package.json': await readFile(join(taskDirectory, 'package.json'), 'utf8'),
    'package-lock.json': await readFile(join(taskDirectory, 'package-lock.json'), 'utf8'),
    'vendor/fixture-dep/package.json': await readFile(join(taskDirectory, 'vendor/fixture-dep/package.json'), 'utf8'),
    'vendor/fixture-dep/index.js': await readFile(join(taskDirectory, 'vendor/fixture-dep/index.js'), 'utf8'),
  });

  const store = new Store(join(root, 'review.sqlite'));
  store.setMeta('paused', false);
  const worker: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test-worker', notes: '', available: true, problem: '', supportedThinking: [] };
  const reviewer: Profile = { id: 'reviewer', name: 'Reviewer', provider: 'test', model: 'test-reviewer', notes: '', available: true, problem: '', supportedThinking: [] };
  store.setMeta('pool', [
    { profileId: worker.id, enabled: true, group: 'workers', roles: ['worker'], weight: 1, scopes: ['general'] },
    { profileId: reviewer.id, enabled: true, group: 'reviewers', roles: ['reviewer'], weight: 1, scopes: ['general'] },
  ]);
  store.setProfiles([worker, reviewer].map(profile => ({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, notes: profile.notes })));
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Review changed dependencies', repoPath: repo,
    planningCommit: planning, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', handoff, planning,
  { branch: 'ns-review-task', baseBranch: 'main' });
  const task = store.update(submitted.id, {
    phase: 'awaiting_review', workspaceId: 'ws-review-task', directory: taskDirectory, workspaceIntent: true,
    agentIntent: true, agentId: 'worker-agent', runId: 'worker-run', profile: worker, workerModel: worker.model, workerModels: [worker.model],
    prHead: head, prUrl: 'https://github.com/example/repo/pull/41', resumePrNumber: 41,
    completion: { taskId: submitted.id, runId: 'worker-run', eventId: 'worker-ready', status: 'ready_for_review', summary: 'Ready', prNumber: 41, head },
  });
  let reviewerStarts = 0;
  let beforeReviewerStart: () => Promise<void> = async () => {};
  const adapter = fakeAdapter({
    catalog: async () => paseoCatalog(),
    verifyPr: async current => ({ url: current.prUrl!, head }),
    createRun: async current => {
      reviewerStarts++;
      await beforeReviewerStart();
      return { id: 'reviewer-agent', workspaceId: current.workspaceId! };
    },
    observe: observeIdle('ws-review-task'),
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [worker, reviewer];
  return { root, repo, workspaceRoot, taskDirectory, store, engine, task, head, reviewerStarts: () => reviewerStarts,
    beforeReviewerStart: (fn: () => Promise<void>) => { beforeReviewerStart = fn; } };
}

test('ordinary reviewer setup follows a lockfile changed after the worker install', async t => {
  const f = await reviewLockfileFixture(t);
  f.beforeReviewerStart(async () => {
    assert.equal(await command('node', ['-p', "require('fixture-dep').version"], f.taskDirectory), '2.0.0');
  });
  try {
    await f.engine.resolution.advance(f.store.task(f.task.id));
    assert.equal(f.reviewerStarts(), 1, f.store.task(f.task.id).reason);
    assert.equal(f.store.run(f.store.task(f.task.id).resolution.currentRunId!)?.role, 'reviewer');
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test('a failed reviewer dependency refresh records its error and starts no agent', async t => {
  const f = await reviewLockfileFixture(t);
  // The worker installed from the original lockfile. Corrupt the submitted PR's
  // changed lockfile so the real npm ci lifecycle fails during review setup.
  await writeFile(join(f.taskDirectory, 'package-lock.json'), '{ invalid lockfile');
  try {
    await f.engine.resolution.advance(f.store.task(f.task.id));
    const task = f.store.task(f.task.id);
    assert.match(task.reason, /Task node_modules setup failed with npm ci/);
    assert.equal(task.phase, 'awaiting_review');
    assert.equal(f.reviewerStarts(), 0, 'the reviewer must not start while its install is stale');
    assert.equal(f.store.runs(task.id).filter(run => run.role === 'reviewer').length, 0, 'dependency setup fails before run reservation');
    const gitDir = await git(f.taskDirectory, 'rev-parse', '--path-format=absolute', '--git-dir');
    const state = JSON.parse(await readFile(join(gitDir, 'nucleus', 'task-node-modules.json'), 'utf8'));
    assert.equal(state.status, 'failed');
    assert.match(state.error, /EJSONPARSE/);
  } finally {
    await f.engine.stop();
    f.store.close();
  }
});

test('a new task gets a private install from the lockfile advanced by dispatch', async t => {
  const { root, repo } = await makeRepo(t);
  const writeDependency = async (directory: string, version: string) => {
    const dependency = join(directory, 'vendor', 'fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dep', version, main: 'index.js' }));
    await writeFile(join(dependency, 'index.js'), `module.exports = { version: '${version}' };\n`);
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await writeFile(join(directory, '.npmrc'), 'install-links=true\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dispatch-lockfile-fixture', version: '1.0.0', dependencies: { 'fixture-dep': 'file:vendor/fixture-dep' } }));
    await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  };

  await writeDependency(repo, '1.0.0');
  const planning = await commit(repo, 'planning with lockfile', { 'docs/handoff.md': handoff, '.gitignore': 'node_modules/\n' });
  await git(repo, 'push', 'origin', 'main');
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], repo);

  const workspaceRoot = join(root, 'shared-workspaces');
  await mkdir(workspaceRoot);
  await symlink(join(repo, 'node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  assert.equal(await command('node', ['-p', "require('fixture-dep').version"], repo), '1.0.0');

  const peer = join(root, 'peer');
  await command('git', ['clone', join(root, 'origin.git'), peer], root);
  await git(peer, 'config', 'user.name', 'Queue test');
  await git(peer, 'config', 'user.email', 'queue@example.invalid');
  await git(peer, 'checkout', '-b', 'dependency-update');
  await writeDependency(peer, '2.0.0');
  await git(peer, 'add', '.gitignore', '.npmrc', 'package.json', 'package-lock.json', 'vendor');
  await git(peer, 'commit', '-m', 'prepare dependency update');
  await git(peer, 'checkout', 'main');
  await git(peer, 'merge', '--no-ff', 'dependency-update', '-m', 'merge dependency update');
  await git(peer, 'push', 'origin', 'main');

  const taskDirectory = join(workspaceRoot, 'next-task');
  const store = new Store(join(root, 'queue.sqlite'));
  store.setMeta('paused', false);
  store.setMeta('pool', [{ profileId: 'worker', enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
  store.setProfiles([{ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, notes: profile.notes }]);
  let launches = 0;
  const adapter = fakeAdapter({
    catalog: async () => paseoCatalog(),
    validate: validateDispatch,
    createWorkspace: async task => {
      assert.equal(task.planningBase, await git(peer, 'rev-parse', 'HEAD'));
      // Deliberately provision at the submitted base. verifyWorkspace must
      // fast-forward it to the lockfile-changing planning base before install.
      await git(repo, 'worktree', 'add', '-b', task.branch, taskDirectory, planning);
      assert.equal(await git(taskDirectory, 'rev-parse', 'HEAD'), planning);
      return { id: 'ws-next-task', directory: taskDirectory };
    },
    verifyWorkspace,
    createAgent: async task => { launches++; return { id: `agent-${task.id}`, workspaceId: task.workspaceId }; },
    observe: observeIdle('ws-next-task'),
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  const queued = store.insert(submissionSchema.parse({
    submissionId: randomUUID(), title: 'New task after lockfile merge', repoPath: repo,
    planningCommit: planning, handoffPath: 'docs/handoff.md', originAgentId: 'origin',
  }), 'host', handoff, planning, { branch: 'ns-next-task', baseBranch: 'main' });
  try {
    await engine.dispatchTask(queued.id, false);
    assert.equal(launches, 1, 'the worker starts after task-local dependency setup succeeds');
    assert.equal(await git(taskDirectory, 'rev-parse', 'HEAD'), await git(peer, 'rev-parse', 'HEAD'), 'workspace verification fast-forwarded to the merged lockfile');
    assert.equal(await command('node', ['-p', "require('fixture-dep').version"], taskDirectory), '2.0.0');
    assert.equal(await command('node', ['-p', "require('fixture-dep').version"], repo), '1.0.0', 'the task install does not rewrite the shared install for other worktrees');
  } finally {
    await engine.stop();
    store.close();
  }
});

test('a task on a non-main integration base installs from that base lockfile', async t => {
  const { root, repo } = await makeRepo(t);
  const writeDependency = async (directory: string, version: string) => {
    const dependency = join(directory, 'vendor', 'fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dep', version, main: 'index.js' }));
    await writeFile(join(dependency, 'index.js'), `module.exports = { version: '${version}' };\n`);
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await writeFile(join(directory, '.npmrc'), 'install-links=true\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dispatch-lockfile-fixture', version: '1.0.0', dependencies: { 'fixture-dep': 'file:vendor/fixture-dep' } }));
    await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  };
  await writeDependency(repo, '1.0.0');
  const main = await commit(repo, 'main lockfile', { 'docs/handoff.md': handoff, '.gitignore': 'node_modules/\n' });
  await git(repo, 'push', 'origin', 'main');
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], repo);
  const workspaceRoot = join(root, 'shared-workspaces');
  await mkdir(workspaceRoot);
  await symlink(join(repo, 'node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  await git(repo, 'checkout', '-b', 'release/v0.5');
  await writeDependency(repo, '2.0.0');
  await git(repo, 'add', '.gitignore', '.npmrc', 'package.json', 'package-lock.json', 'vendor');
  await git(repo, 'commit', '-m', 'release dependency update');
  const release = await git(repo, 'rev-parse', 'HEAD');
  const taskDirectory = join(workspaceRoot, 'release-task');
  await git(repo, 'worktree', 'add', '-b', 'ns-release-task', taskDirectory, release);
  await ensureTaskNodeModules(taskDirectory, repo, workspaceRoot);
  assert.equal(await command('node', ['-p', "require('fixture-dep').version"], taskDirectory), '2.0.0');
  assert.equal(await command('node', ['-p', "require('fixture-dep').version"], repo), '1.0.0');
  assert.notEqual(main, release);
});

test('failed task install keeps its error after npm ci deletes node_modules and retries', async t => {
  const { root, repo } = await makeRepo(t);
  const writeDependency = async (directory: string, version: string) => {
    const dependency = join(directory, 'vendor', 'fixture-dep');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dep', version, main: 'index.js' }));
    await writeFile(join(dependency, 'index.js'), `module.exports = { version: '${version}' };\n`);
    await writeFile(join(directory, '.gitignore'), 'node_modules/\n');
    await writeFile(join(directory, '.npmrc'), 'install-links=true\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dispatch-lockfile-fixture', version: '1.0.0', dependencies: { 'fixture-dep': 'file:vendor/fixture-dep' } }));
    await command('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  };
  await writeDependency(repo, '1.0.0');
  await commit(repo, 'main lockfile', { 'docs/handoff.md': handoff, '.gitignore': 'node_modules/\n' });
  await git(repo, 'push', 'origin', 'main');
  await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], repo);
  const workspaceRoot = join(root, 'shared-workspaces');
  await mkdir(workspaceRoot);
  await symlink(join(repo, 'node_modules'), join(workspaceRoot, 'node_modules'), 'dir');
  await git(repo, 'checkout', '-b', 'ns-task');
  await writeDependency(repo, '2.0.0');
  await git(repo, 'add', '.gitignore', '.npmrc', 'package.json', 'package-lock.json', 'vendor');
  await git(repo, 'commit', '-m', 'task lockfile update');
  await git(repo, 'checkout', 'main');
  const taskDirectory = join(workspaceRoot, 'task');
  await git(repo, 'worktree', 'add', taskDirectory, 'ns-task');

  const previousPath = process.env.PATH;
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\nrm -rf node_modules\nprintf "fixture task npm ci failure" >&2\nexit 23\n');
  await chmod(join(fakeBin, 'npm'), 0o755);
  process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
  try {
    await assert.rejects(ensureTaskNodeModules(taskDirectory, repo, workspaceRoot), /Task node_modules setup failed with npm ci: fixture task npm ci failure/);
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(existsSync(join(taskDirectory, 'node_modules')), false);
  assert.equal(await command('node', ['-p', "require('fixture-dep').version"], repo), '1.0.0', 'the failed task refresh leaves the shared install untouched');
  const gitDir = await git(taskDirectory, 'rev-parse', '--path-format=absolute', '--git-dir');
  const state = JSON.parse(await readFile(join(gitDir, 'nucleus', 'task-node-modules.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.match(state.error, /fixture task npm ci failure/);
  await ensureTaskNodeModules(taskDirectory, repo, workspaceRoot);
  assert.equal(await command('node', ['-p', "require('fixture-dep').version"], taskDirectory), '2.0.0');
});

test('a behind-only integration branch is fast-forwarded at dispatch', async t => {
  const { root, repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  await git(repo, 'push', 'origin', 'main');
  const peer = join(root, 'peer');
  await command('git', ['clone', join(root, 'origin.git'), peer], root);
  await git(peer, 'config', 'user.name', 'Queue test');
  await git(peer, 'config', 'user.email', 'queue@example.invalid');
  const landed = await commit(peer, 'landed elsewhere', { 'docs/other.json': '{}' });
  await git(peer, 'push', 'origin', 'main');
  assert.notEqual(await git(repo, 'rev-parse', 'main'), landed, 'the checkout starts behind');

  const base = await validateDispatch(dispatchTask(repo, planning));
  assert.equal(base, landed, 'dispatch repaired the branch and dispatched from the repaired base');
  assert.equal(await git(repo, 'rev-parse', 'main'), landed);
});

test('a diverged integration branch still refuses dispatch', async t => {
  const { root, repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  await git(repo, 'push', 'origin', 'main');
  const peer = join(root, 'peer');
  await command('git', ['clone', join(root, 'origin.git'), peer], root);
  await git(peer, 'config', 'user.name', 'Queue test');
  await git(peer, 'config', 'user.email', 'queue@example.invalid');
  await commit(peer, 'landed elsewhere', { 'docs/other.json': '{}' });
  await git(peer, 'push', 'origin', 'main');
  await commit(repo, 'local work that is not on origin', { 'docs/local.json': '{}' });

  await assert.rejects(() => validateDispatch(dispatchTask(repo, planning)), /diverged from origin/);
});

/**
 * A dispatch records `planningBase` when the handoff is submitted and requires the worker worktree
 * to sit exactly on it. If main advances in between - a coordinator's own handoff push will do it -
 * the worktree lands on the newer head and dispatch refuses forever, while retry_validation refuses
 * because a workspace is visible. Nothing is pinned to the old base in that state, so the base may
 * be re-recorded, but only onto a head that provably carries the same work.
 */
test('a dispatch base may be re-recorded only onto a descendant carrying the submitted handoff', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'coordinator docs push', { 'docs/notes.md': 'notes' });
  await git(repo, 'checkout', '-q', '-b', 'ns-task');
  const task = { ...dispatchTask(repo, planning), planningBase: planning } as unknown as Task;

  assert.equal(await proveRebindableDispatchBase(task, repo, advanced), advanced, 'a clean descendant carrying the handoff is a valid new base');

  await writeFile(join(repo, 'docs/notes.md'), 'dirty');
  await assert.rejects(() => proveRebindableDispatchBase(task, repo, advanced), /not clean/);
  await git(repo, 'checkout', '-q', '--', 'docs/notes.md');

  await writeFile(join(repo, 'docs/handoff.md'), 'superseded');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'handoff changed');
  const rewritten = await git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(() => proveRebindableDispatchBase(task, repo, rewritten), /does not match the submitted handoff/);

  await assert.rejects(() => proveRebindableDispatchBase(task, repo, planning), /already at the recorded dispatch base/);
});

test('a dispatch base is never re-recorded onto a rewritten head', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  await git(repo, 'checkout', '-q', '-b', 'ns-task');
  // A genuine rewrite: a fresh root that does not contain the recorded base at all. The worktree is
  // clean, on the queue-owned branch and at the proposed head, so only the descendant proof stands
  // between this and silently discarding whatever the rewrite removed.
  await git(repo, 'checkout', '-q', '--orphan', 'rewritten');
  await git(repo, 'rm', '-rq', '--cached', '.');
  const diverged = await commit(repo, 'rewritten history', { 'docs/handoff.md': handoff, 'docs/other.md': 'x' });
  await git(repo, 'branch', '-q', '-f', 'ns-task', diverged);
  await git(repo, 'checkout', '-q', 'ns-task');
  const task = { ...dispatchTask(repo, planning), planningBase: planning } as unknown as Task;
  await assert.rejects(() => proveRebindableDispatchBase(task, repo, diverged), /does not descend from the recorded base/);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), diverged, 'the worktree is left exactly as it was found');
});

/** A task whose workspace was created but whose worker was never: the only state a base re-record is for. */
function dispatchFixture(repo: string, planningBase: string, changes: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nsq-rerecord-'));
  const store = new Store(join(dir, 'queue.sqlite'));
  store.setMeta('paused', false);
  const profile: Profile = { id: 'worker', name: 'worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
  const adapter = { profiles: async () => [profile], validate: async (t: any) => t.planningCommit,
    createWorkspace: async (t: any) => ({ id: `ws-${t.id}`, directory: repo }), findWorkspaces: async () => [{ id: 'ws', directory: repo }],
    verifyWorkspace: async (t: any) => t.branch, createAgent: async (t: any) => ({ id: `agent-${t.runId}`, workspaceId: t.workspaceId }),
    findAgents: async () => [], observe: observeIdle('ws'),
    archiveAgent: async () => {}, verifyPr: async () => ({ url: 'https://example.invalid/pr/1', head: 'a'.repeat(40) }) } as unknown as Adapter;
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  const submitted = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: repo, planningCommit: planningBase, handoffPath: 'docs/handoff.md', originAgentId: 'origin' }), 'host', handoff, planningBase);
  const task = store.update(submitted.id, { phase: 'needs_attention', planningBase, workspaceIntent: true, workspaceId: `ws-${submitted.id}`,
    directory: repo, branch: `ns-${submitted.id}`, profile, profileGroup: 'author', runId: 'initial',
    reason: 'Worker worktree does not match the recorded dispatch base', ...changes });
  return { store, engine, adapter, task, close: async () => { await engine.stop(); store.close(); } };
}

test('the dispatch-base re-record returns a workerless task to the queue from the worktree head', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'coordinator docs push', { 'docs/notes.md': 'notes' });
  await git(repo, 'checkout', '-q', '-b', 'ns-task');
  const f = dispatchFixture(repo, planning, { branch: 'ns-task' }); try {
    const rerecorded = await f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version, action: 'retry_effect', effect: 'planning_base', reason: 'Re-record the dispatch base' });
    assert.equal(rerecorded.planningBase, advanced, 'the base moves to the worktree head, which is current main');
    assert.equal(rerecorded.phase, 'queued', 'the task returns to the queue so ordinary dispatch creates the worker');
    assert.equal(rerecorded.workspaceId, f.task.workspaceId, 'the existing workspace is kept, not recreated');
    assert.ok(f.store.eventsAll(f.task.id).some(event => event.kind === 'planning_base_rerecorded'), 'the re-record is recorded');
  } finally { await f.close(); }
});

test('the dispatch-base re-record refuses once a worker, run or PR identity exists', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'coordinator docs push', { 'docs/notes.md': 'notes' });
  await git(repo, 'checkout', '-q', '-b', 'ns-task');
  for (const [label, changes, expected] of [
    ['an agent in flight', { agentIntent: true }, /worker agent already exists|No recorded side effect planning_base is pending/],
    ['a PR identity', { prUrl: 'https://example.invalid/pr/1', prHead: 'a'.repeat(40) }, /PR identity already exists|No recorded side effect planning_base is pending/],
  ] as const) {
    const f = dispatchFixture(repo, planning, changes as Record<string, unknown>); try {
      await assert.rejects(() => f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version, action: 'retry_effect', effect: 'planning_base', reason: 'Re-record the dispatch base' }), expected, label);
      assert.equal(f.store.task(f.task.id).planningBase, planning, `${label}: the recorded base is untouched`);
    } finally { await f.close(); }
  }
  const f = dispatchFixture(repo, planning); try {
    f.store.putRun({ id: 'initial', taskId: f.task.id, role: 'worker', status: 'running', released: false } as never);
    await assert.rejects(() => f.engine.performTaskControl({ taskId: f.task.id, version: f.store.task(f.task.id).version, action: 'retry_effect', effect: 'planning_base', reason: 'Re-record the dispatch base' }), /worker run already exists|No recorded side effect planning_base is pending/);
  } finally { await f.close(); }
  // A recovery run is not a worker: it exists because an uncertain creation had to be diagnosed, and
  // gating on any run at all refused exactly the state this control was built for.
  const r = dispatchFixture(repo, planning, { branch: 'ns-task' }); try {
    r.store.putRun({ id: 'recovery', taskId: r.task.id, role: 'recovery', status: 'finished', released: true } as never);
    const rerecorded = await r.engine.performTaskControl({ taskId: r.task.id, version: r.store.task(r.task.id).version, action: 'retry_effect', effect: 'planning_base', reason: 'Re-record the dispatch base' });
    assert.equal(rerecorded.planningBase, advanced, 'a settled recovery run does not block the re-record');
  } finally { await r.close(); }
});

/**
 * Main moves under an active wave, so a workspace created moments after planningBase was recorded can
 * land on a different head. Requiring exact equality refused forever, while the only thing that could
 * reconcile the two was the dispatch the refusal blocked. Both non-equal cases have an exact repair.
 */
test('a worker worktree ahead of or behind the recorded base is reconciled, and a diverged one refuses', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'later main', { 'docs/notes.md': 'notes' });
  await git(repo, 'checkout', '-q', '-b', 'ns-task');
  const base = { ...dispatchTask(repo, planning), planningBase: planning } as unknown as Task;

  // Ahead: the worktree already contains the recorded base, so nothing is rewritten.
  assert.equal(await verifyWorkspace(base, repo), 'ns-task', 'a worktree ahead of the base is accepted as-is');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), advanced, 'an ahead worktree is not moved');

  // Behind: a clean fast-forward, exactly as the integration branch is repaired at dispatch.
  await git(repo, 'reset', '-q', '--hard', planning);
  const ahead = { ...base, planningBase: advanced } as unknown as Task;
  assert.equal(await verifyWorkspace(ahead, repo), 'ns-task', 'a behind-only worktree is fast-forwarded');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), advanced, 'the worktree lands exactly on the recorded base');

  // Diverged: a real conflict, still refused.
  await git(repo, 'checkout', '-q', '--orphan', 'rewritten');
  await git(repo, 'rm', '-rq', '--cached', '.');
  const diverged = await commit(repo, 'rewritten history', { 'docs/handoff.md': handoff });
  await git(repo, 'branch', '-q', '-f', 'ns-task', diverged);
  await git(repo, 'checkout', '-q', 'ns-task');
  await assert.rejects(() => verifyWorkspace(base, repo), /does not match the recorded dispatch base/);
});


test('retry_validation fast-forwards the exact retained workspace and resolves its escalated episode', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'new base', { 'docs/later.md': 'later' });
  await git(repo, 'checkout', '-b', 'ns-task', planning);
  const f = dispatchFixture(repo, advanced, { branch: 'ns-task', runId: null, held: true });
  try {
    f.adapter.findWorkspaces = async () => [{ id: f.task.workspaceId!, directory: repo }];
    f.adapter.verifyWorkspace = verifyWorkspace;
    f.engine.resolution.attention(f.task, 'Worker worktree behind base');
    f.engine.resolution.recovery.escalate(f.store.task(f.task.id), 'Operator repair needed');
    const current = f.store.task(f.task.id);
    const result = await f.engine.performTaskControl({ taskId: current.id, version: current.version, action:'restart',reason:'Replay the pre-dispatch validation' });
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), advanced);
    assert.equal(result.phase, 'queued');
    assert.equal(result.workspaceId, current.workspaceId);
    assert.equal(result.planningBase, current.planningBase);
    assert.equal(result.resolution.incident?.status, 'resolved');
    assert.equal(result.agentId, null);
  } finally { await f.close(); }
});


/** A task recorded on a real `-1` collision worktree, with the production adapter's inventory and archive. */
async function collisionFixture(t: any) {
  const { root, repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const advanced = await commit(repo, 'new base', { 'docs/later.md': 'later' });
  const original = join(root, 'original'), collision = join(root, 'collision');
  const f = dispatchFixture(repo, advanced, { runId: null, held: true, workspaceId: 'collision', directory: collision });
  await git(repo, 'worktree', 'add', '-b', f.task.branch, original, planning);
  await git(repo, 'worktree', 'add', '-b', `${f.task.branch}-1`, collision, planning);
  const paseo = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/report.mjs');
  const entries = [
    { id: 'original', projectRootPath: repo, worktreeSlug: `ns-${f.task.id}`, workspaceDirectory: original },
    { id: 'collision', projectRootPath: repo, worktreeSlug: `ns-${f.task.id}-1`, workspaceDirectory: collision },
  ];
  const archived: string[] = [];
  (paseo as any).api = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, workspaces: {
    list: async () => ({ entries, pageInfo: { hasMore: false } }),
    ref: (id: string) => ({ refresh: async () => {}, current: () => entries.find(e => e.id === id),
      directory: entries.find(e => e.id === id)?.workspaceDirectory,
      archive: async () => {
        const index = entries.findIndex(e => e.id === id), directory = entries[index]?.workspaceDirectory;
        archived.push(id);
        if (directory) await rm(directory, { recursive: true, force: true });
        entries.splice(index, 1);
        return { archivedAt: new Date().toISOString() };
      } }),
  } };
  f.adapter.findWorkspaces = paseo.findWorkspaces.bind(paseo);
  f.adapter.verifyWorkspace = verifyWorkspace;
  f.adapter.archiveTaskWorkspace = paseo.archiveTaskWorkspace.bind(paseo);
  return { ...f, planning, advanced, original, collision, entries, archived };
}

test('operator rebind repairs a real suffixed workspace record and archives only the displaced collision', async t => {
  const f = await collisionFixture(t);
  const { planning, advanced, original, collision, entries, archived } = f;
  try {
    await assert.rejects(f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version, action:'restart',reason:'Replay the pre-dispatch validation' }), /queue-owned branch/);
    assert.equal(await git(collision, 'rev-parse', 'HEAD'), planning, 'wrong-branch refusal does not fast-forward the collision');
    await writeFile(join(original, 'untracked'), 'preserve');
    await assert.rejects(f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version,
      action:'restart',reason:'Replay the pre-dispatch validation', rebindWorkspaceId: 'original' }), /not clean/);
    assert.equal(f.store.task(f.task.id).workspaceId, 'collision');
    await rm(join(original, 'untracked'));
    entries.push({ ...entries[0] });
    await assert.rejects(f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version,
      action:'restart',reason:'Replay the pre-dispatch validation', rebindWorkspaceId: 'original' }), /does not uniquely match/);
    entries.pop();
    const repaired = await f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version,
      action:'restart',reason:'Replay the pre-dispatch validation', rebindWorkspaceId: 'original' });
    assert.equal(repaired.workspaceId, 'original');
    assert.equal(repaired.directory, original);
    assert.equal(repaired.held, true);
    assert.equal(repaired.agentId, null);
    assert.equal(await git(original, 'rev-parse', 'HEAD'), advanced);
    assert.equal(await git(collision, 'rev-parse', 'HEAD'), planning, 'displaced worktree is preserved');
    const cleaned = await f.engine.performTaskControl({ taskId: repaired.id, version: repaired.version,
      action: 'retry_effect', effect: 'workspace_archive.collision', reason: 'Archive the rebind-displaced workspace' });
    assert.deepEqual(archived, ['collision']);
    assert.equal(cleaned.workspaceId, 'original');
    assert.equal(cleaned.held, true);
    assert.equal(cleaned.phase, 'queued');
  } finally { await f.close(); }
});


test('a rebind-displaced collision stays releasable after the worker is dispatched', async t => {
  const f = await collisionFixture(t);
  try {
    const repaired = await f.engine.performTaskControl({ taskId: f.task.id, version: f.task.version,
      action:'restart',reason:'Replay the pre-dispatch validation', rebindWorkspaceId: 'original' });
    // Dispatch proceeded before cleanup: a live worker, run and PR now belong to the task.
    const working = f.store.update(repaired.id, { phase: 'working', held: false, agentId: 'agent-1', runId: 'run-1',
      prUrl: 'https://example.invalid/pr/1' });
    f.store.putRun({ id: 'run-1', taskId: working.id, role: 'worker', workspaceId: 'original', released: false } as any);
    f.store.putRun({ id: 'stray', taskId: working.id, role: 'recovery', workspaceId: 'collision', released: false } as any);
    const control = () => ({ taskId: working.id, version: f.store.task(working.id).version,
      action: 'retry_effect' as const, effect: 'workspace_archive.collision', reason: 'Archive the rebind-displaced workspace' });
    await assert.rejects(f.engine.performTaskControl(control()), /still named by a live run/);
    f.store.putRun({ ...f.store.run('stray')!, released: true });
    const cleaned = await f.engine.performTaskControl(control());
    assert.deepEqual(f.archived, ['collision']);
    assert.equal(cleaned.workspaceId, 'original');
    assert.equal(cleaned.phase, 'working');
    assert.equal(cleaned.agentId, 'agent-1');
    assert.equal(await git(f.original, 'rev-parse', 'HEAD'), f.advanced, 'the working tree is untouched');
  } finally { await f.close(); }
});


test('repin refuses an undispatched handoff and points to resubmission and supersession', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const f = dispatchFixture(repo, planning);
  try {
    const queued = f.store.update(f.task.id, { phase: 'queued', workspaceIntent: false, workspaceId: null,
      directory: null, runId: null, profile: null, profileGroup: null,
      instruction: { path: 'docs/handoff.md', commit: planning, digest: 'sha256:' + '0'.repeat(64), mediaType: 'text/markdown' } });
    await assert.rejects(f.engine.performTaskControl({ taskId: queued.id, version: queued.version, action: 'amend_brief', reason: 'Re-pin the instruction' }), /resubmit.*supersede/);
    assert.equal(f.store.task(queued.id).version, queued.version);
  } finally { await f.close(); }
});

test('repin changes only the pin while a stopped revision still holds the lane', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const amended = await commit(repo, 'amend the handoff', { 'docs/handoff.md': handoff + '\nAmended ruling.\n' });
  const f = dispatchFixture(repo, planning, { phase: 'changes_requested', reason: 'Revision thread running', runId: 'initial',
    prUrl: 'https://example.invalid/pr/1', prHead: 'a'.repeat(40),
    instruction: { path: 'docs/handoff.md', commit: planning, digest: 'sha256:' + '0'.repeat(64), mediaType: 'text/markdown' } });
  try {
    const current = f.store.task(f.task.id);
    f.store.putRun({ id: 'stopped', taskId: current.id, role: 'revision', generation: 1, head: 'a'.repeat(40), base: planning, agentId: 'dead',
      workspaceId: current.workspaceId, instruction: null, profile: null, profileGroup: null, status: 'running', createdAt: new Date().toISOString(),
      lastObservedAt: null, active: false, idleSince: null, completion: null, released: false } as any);
    f.store.update(current.id, { resolution: { ...current.resolution, currentRunId: 'stopped', attention: true,
      review: { eventId: 'r', taskId: current.id, runId: 'rev', status: 'changes_required', summary: 'fix', head: 'b'.repeat(40) } as any } });
    const before = f.store.task(f.task.id);
    const repinned = await f.engine.performTaskControl({ taskId: before.id, version: before.version, action: 'amend_brief', reason: 'Re-pin the instruction' });
    assert.equal(repinned.instruction?.commit, amended);
    assert.equal(repinned.phase, 'changes_requested', 'g05.180: the stopped revision keeps its lane');
    assert.equal(repinned.resolution.attention, true);
    assert.equal(repinned.resolution.currentRunId, 'stopped');
  } finally { await f.close(); }
});

test('repin still re-runs the pre-merge gate for a lane held there with an accepted review', async t => {
  const { repo } = await makeRepo(t);
  const planning = await commit(repo, 'planning', { 'docs/handoff.md': handoff });
  const amended = await commit(repo, 'amend the handoff', { 'docs/handoff.md': handoff + '\nAmended ruling.\n' });
  const head = 'a'.repeat(40);
  const f = dispatchFixture(repo, planning, { phase: 'needs_attention', reason: 'Repository hook lifecycle-gate task.pre_merge holds this transition: instruction changed', runId: 'initial',
    prUrl: 'https://example.invalid/pr/1', prHead: head,
    instruction: { path: 'docs/handoff.md', commit: planning, digest: 'sha256:' + '0'.repeat(64), mediaType: 'text/markdown' } });
  try {
    const current = f.store.task(f.task.id);
    f.store.update(current.id, { resolution: { ...current.resolution, currentRunId: null, attention: true,
      review: { eventId: 'r', taskId: current.id, runId: 'rev', status: 'ready_to_merge', summary: 'ok', head, reviewCommentId: 1 } as any } });
    const before = f.store.task(f.task.id);
    const repinned = await f.engine.performTaskControl({ taskId: before.id, version: before.version, action: 'amend_brief', reason: 'Re-pin the instruction' });
    assert.equal(repinned.instruction?.commit, amended);
    assert.equal(repinned.phase, 'verifying');
    assert.equal(repinned.resolution.attention, false);
  } finally { await f.close(); }
});


test('release brief dispatch and merged-base sync preserve registered main throughout', async t => {
  const {root,repo}=await makeRepo(t);
  const released=await commit(repo,'released v0.5.1',{'base.txt':'released'});
  await git(repo,'push','origin','main');
  await git(repo,'branch','release/v0.5',released);await git(repo,'push','origin','release/v0.5');
  const main=await commit(repo,'ongoing main sweep',{'sweep.txt':'main only'});await git(repo,'push','origin','main');
  const text='Release-line brief',digest=briefDigest(text);
  const task={repoPath:repo,baseBranch:'release/v0.5',branch:'ns-release',planningCommit:released,
    handoffPath:'',handoffText:text,brief:{text,digest,mediaType:'text/markdown'},briefVersions:[{text,digest}],directory:repo,resolution:{}} as unknown as Task;
  const listing=await git(repo,'worktree','list','--porcelain');
  assert.equal(await validateDispatch(task),released);
  const hooks = new RepositoryHooks({} as Store);
  assert.equal(await hooks.integrationBase(task), released);
  assert.deepEqual(await hooks.prospectiveMergeGate(task, { head: released }), { kind: 'none' });
  assert.deepEqual(await integrationBaseGate(task, released), { base: released, wait: '' });
  assert.equal(await git(repo,'branch','--show-current'),'main');assert.equal(await git(repo,'rev-parse','HEAD'),main);
  const writer=join(root,'writer');await git(root,'clone','--branch','release/v0.5',join(root,'origin.git'),writer);
  await git(writer,'config','user.name','Queue test');await git(writer,'config','user.email','queue@example.invalid');
  const merged=await commit(writer,'reviewed patch',{'patch.txt':'release only'});await git(writer,'push','origin','release/v0.5');
  task.resolution.mergedCommit=merged;
  await assert.rejects(syncMain(task,()=>false),/Paused/);
  assert.equal(await git(repo,'rev-parse','release/v0.5'),released);
  assert.equal(await syncMain(task),merged);assert.equal(await syncMain(task),merged);
  task.resolution.syncedCommit = merged;
  assert.equal(await verifyCloseoutPublication(task), merged);
  assert.equal(await hooks.integrationBase(task), merged, 'verification rechecks the synchronized release base');
  assert.equal(await validateDispatch(task),merged,'next dispatch branches from the synchronized release ref');
  assert.equal(await git(repo,'rev-parse','release/v0.5'),merged);
  assert.equal(await git(repo,'branch','--show-current'),'main');assert.equal(await git(repo,'rev-parse','HEAD'),main);
  assert.equal(await git(repo,'status','--porcelain'),'');assert.equal(await git(repo,'worktree','list','--porcelain'),listing);
});

test('release routing refuses dirty main, owned base worktrees, divergence and invalid ancestry', async t => {
  const {root,repo}=await makeRepo(t);
  const released=await commit(repo,'released',{'base.txt':'base'});await git(repo,'push','origin','main');
  await git(repo,'branch','release/v0.5',released);await git(repo,'push','origin','release/v0.5');
  const text='Release brief',digest=briefDigest(text);
  const task={repoPath:repo,baseBranch:'release/v0.5',branch:'ns-release',planningCommit:released,
    handoffPath:'',handoffText:text,brief:{text,digest,mediaType:'text/markdown'},briefVersions:[{text,digest}],resolution:{}} as unknown as Task;
  await writeFile(join(repo,'dirty.txt'),'preserve');await assert.rejects(validateDispatch(task),/dirty or changed/);
  await rm(join(repo,'dirty.txt'));
  const owned=join(root,'owned');await git(repo,'worktree','add',owned,'release/v0.5');
  await assert.rejects(validateDispatch(task),/already.*(?:checked out|used)/);assert.equal(await git(owned,'rev-parse','HEAD'),released);
  await git(repo,'worktree','remove',owned);
  const unpublished=await commit(repo,'unrelated main work',{'main.txt':'main'});
  await assert.rejects(validateDispatch({...task,planningCommit:unpublished}),/not on the integration branch/);
  await git(repo,'branch','-f','release/v0.5',unpublished);
  await assert.rejects(validateDispatch(task),/diverged from origin/);
  task.resolution.mergedCommit=unpublished;await assert.rejects(syncMain(task));
  assert.equal(await git(repo,'branch','--show-current'),'main');assert.equal(await git(repo,'rev-parse','HEAD'),unpublished);
  assert.equal((await git(repo,'worktree','list','--porcelain')).split('worktree ').length,2,'no private worktrees retained after refusal');
  await assert.rejects(validateDispatch({...task,baseBranch:'main',repoPath:repo,brief:null}),/exactly one/);
});


test('release routing detects a registered-head race and cleans its private worktree',async t=>{
  const {repo}=await makeRepo(t);
  const released=await commit(repo,'released',{'base.txt':'base'});await git(repo,'push','origin','main');
  await git(repo,'branch','release/v0.5',released);await git(repo,'push','origin','release/v0.5');
  const task={repoPath:repo,baseBranch:'release/v0.5',brief:{text:'brief'}} as Task;
  let concurrent='';
  await assert.rejects(withIntegrationCheckout(task,async (_checkout,unchanged)=>{
    concurrent=await commit(repo,'concurrent main author',{'main.txt':'preserved'});
    await unchanged();
  }),/dirty or changed registered main/);
  assert.equal(await git(repo,'branch','--show-current'),'main');assert.equal(await git(repo,'rev-parse','HEAD'),concurrent);
  assert.equal(await git(repo,'rev-parse','release/v0.5'),released);
  assert.equal((await git(repo,'worktree','list','--porcelain')).split('worktree ').length,2);
});


test('failed-add cleanup preserves a registered partial checkout and removes only proven unregistered roots',async t=>{
  const {root,repo}=await makeRepo(t);
  const released=await commit(repo,'released',{'base.txt':'base'});await git(repo,'push','origin','main');
  await git(repo,'branch','release/v0.5',released);
  const privateRoot=join(root,'private'),checkout=join(privateRoot,'checkout');await mkdir(privateRoot);
  await git(repo,'worktree','add',checkout,'release/v0.5');
  await writeFile(join(checkout,'partial-output.txt'),'preserve after failed add');
  // Git may register/materialize the checkout, then throw before the caller marks added.
  await assert.rejects(cleanupIntegrationCheckout(repo,privateRoot,checkout,false),/Preserving uncertain/);
  assert.match(await git(repo,'worktree','list','--porcelain'),/private\/checkout/);
  assert.match(await git(checkout,'status','--porcelain'),/partial-output/);
  await assert.rejects(cleanupIntegrationCheckout(repo,privateRoot,checkout,true),/modified or untracked/);
  await rm(join(checkout,'partial-output.txt'));await git(repo,'worktree','remove',checkout);
  await cleanupIntegrationCheckout(repo,privateRoot,checkout,false);
  const {existsSync}=await import('node:fs');assert.equal(existsSync(privateRoot),false);
  assert.equal(await git(repo,'branch','--show-current'),'main');assert.equal(await git(repo,'rev-parse','HEAD'),released);
});


test('prospective release verification refuses dirty, owned and unsynchronized bases without altering main', async t => {
  const { root, repo } = await makeRepo(t);
  const released = await commit(repo, 'released', { 'base.txt': 'base' });
  await git(repo, 'push', 'origin', 'main');
  await git(repo, 'branch', 'release/v0.5', released); await git(repo, 'push', 'origin', 'release/v0.5');
  const main = await commit(repo, 'main sweep', { 'main.txt': 'main' }); await git(repo, 'push', 'origin', 'main');
  const task = { repoPath: repo, baseBranch: 'release/v0.5', brief: { text: 'release brief' } } as Task;
  const hooks = new RepositoryHooks({} as Store);
  const listing = await git(repo, 'worktree', 'list', '--porcelain');
  await writeFile(join(repo, 'dirty.txt'), 'preserve');
  await assert.rejects(hooks.integrationBase(task), /dirty or changed/);
  await rm(join(repo, 'dirty.txt'));
  const owned = join(root, 'owned'); await git(repo, 'worktree', 'add', owned, 'release/v0.5');
  await assert.rejects(hooks.integrationBase(task), /already.*(?:checked out|used)/);
  assert.equal(await git(owned, 'rev-parse', 'HEAD'), released);
  await git(repo, 'worktree', 'remove', owned);
  await git(repo, 'branch', '-f', 'release/v0.5', main);
  const refusal = await hooks.prospectiveMergeGate(task, { head: main });
  assert.equal(refusal.kind, 'hold');
  assert.match(refusal.kind === 'hold' ? refusal.detail : '', /Local integration base differs from origin/);
  assert.equal(await git(repo, 'rev-parse', 'release/v0.5'), main, 'verification never repairs or advances a ref');
  await assert.rejects(hooks.integrationBase({ ...task, brief: null }), /different branch/);
  assert.equal(await git(repo, 'branch', '--show-current'), 'main');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), main);
  assert.equal(await git(repo, 'worktree', 'list', '--porcelain'), listing);
});

test('selected-base verification rechecks registered main after awaited proof', async t => {
  const { repo } = await makeRepo(t);
  const released = await commit(repo, 'released', { 'base.txt': 'base' }); await git(repo, 'push', 'origin', 'main');
  await git(repo, 'branch', 'release/v0.5', released); await git(repo, 'push', 'origin', 'release/v0.5');
  const task = { repoPath: repo, baseBranch: 'release/v0.5', brief: { text: 'release brief' } } as Task;
  const hooks = new RepositoryHooks({} as Store);
  const internal = hooks as unknown as { verifyCleanSynchronizedBase(root: string, branch: string, head: string): Promise<void> };
  const verify = internal.verifyCleanSynchronizedBase.bind(hooks);
  let concurrent = '';
  internal.verifyCleanSynchronizedBase = async (...args) => {
    await verify(...args);
    concurrent = await commit(repo, 'concurrent main writer', { 'main.txt': 'preserved' });
  };
  await assert.rejects(hooks.integrationBase(task), /dirty or changed registered main/);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), concurrent);
  assert.equal(await git(repo, 'rev-parse', 'release/v0.5'), released);
  assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).split('worktree ').length, 2);
});


test('release forge gates retain clean, owned, origin and closeout publication bounds', async t => {
  const { root, repo } = await makeRepo(t);
  const released = await commit(repo, 'released', { 'base.txt': 'base' }); await git(repo, 'push', 'origin', 'main');
  await git(repo, 'branch', 'release/v0.5', released); await git(repo, 'push', 'origin', 'release/v0.5');
  const main = await commit(repo, 'main sweep', { 'main.txt': 'main' }); await git(repo, 'push', 'origin', 'main');
  const task = { repoPath: repo, baseBranch: 'release/v0.5', directory: repo, brief: { text: 'release brief' },
    resolution: { mergedCommit: released, syncedCommit: released } } as Task;
  const listing = await git(repo, 'worktree', 'list', '--porcelain');
  await writeFile(join(repo, 'dirty.txt'), 'preserve');
  await assert.rejects(integrationBaseGate(task, released), /dirty or changed/);
  await assert.rejects(verifyCloseoutPublication(task), /dirty or changed/);
  await rm(join(repo, 'dirty.txt'));
  const owned = join(root, 'owned'); await git(repo, 'worktree', 'add', owned, 'release/v0.5');
  await assert.rejects(integrationBaseGate(task, released), /already.*(?:checked out|used)/);
  await assert.rejects(verifyCloseoutPublication(task), /already.*(?:checked out|used)/);
  await git(repo, 'worktree', 'remove', owned);
  await git(repo, 'branch', '-f', 'release/v0.5', main);
  await assert.rejects(integrationBaseGate(task, released), /match origin before merge/);
  await assert.rejects(verifyCloseoutPublication(task), /head changed during closeout/);
  await git(repo, 'branch', '-f', 'release/v0.5', released);
  await assert.rejects(integrationBaseGate({...task, brief: null}, released), /different branch/);
  await assert.rejects(integrationBaseGate({...task, directory: null}, released), /no worktree/);
  const writer = join(root, 'writer'); await git(root, 'clone', '--branch', 'release/v0.5', join(root, 'origin.git'), writer);
  await git(writer, 'config', 'user.name', 'Queue test'); await git(writer, 'config', 'user.email', 'queue@example.invalid');
  const published = await commit(writer, 'canonical closeout', { 'docs/logs/closeout.md': 'closed' });
  await git(writer, 'push', 'origin', 'release/v0.5');
  await git(repo, 'fetch', 'origin', 'release/v0.5');
  await git(repo, 'branch', '-f', 'release/v0.5', published);
  const result = { closeoutCommit: published } as Parameters<typeof verifyCloseoutPublication>[1];
  assert.equal(await verifyCloseoutPublication(task, result), published);
  const invalid = await commit(writer, 'non-closeout edit', { 'implementation.txt': 'must refuse' });
  await git(writer, 'push', 'origin', 'release/v0.5'); await git(repo, 'fetch', 'origin', 'release/v0.5');
  await git(repo, 'branch', '-f', 'release/v0.5', invalid);
  await assert.rejects(verifyCloseoutPublication(task, { ...result, closeoutCommit: invalid } as typeof result), /outside canonical closeout/);
  assert.equal(await git(repo, 'branch', '--show-current'), 'main');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), main);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(await git(repo, 'worktree', 'list', '--porcelain'), listing);
});
