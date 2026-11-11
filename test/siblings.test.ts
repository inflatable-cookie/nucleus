import { fakeAdapter, createTaskAgent } from './support/fakes';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../core/store/store';
import { Engine } from '../core/engine';
import { workerPrompt } from '../core/dispatch/prompts';
import { runPrompt } from '../core/dispatch/prompts';
import { git, command } from '../core/git/index';
import { createSiblingWorktrees, findingFor, inspectSiblingWorktrees, removeSiblingWorktrees, siblingMembers, siblingPathFor, siblingsEnabled } from '../core/workspaces/siblings';
import { buildOutcomeRecord } from '../core/store/store';
import { parseNorthstarDocument } from '../core/planning/handoff';
import { submissionSchema, type Profile, type Run, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { HOOK_TEST_TIMEOUT_MS } from './support/budgets';

const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: ['low'] };

async function commit(repo: string, message: string, files: Record<string, string> = {}) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Two pushed repositories: alpha holds the task, beta is its sibling checkout. */
async function twoRepos(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-siblings-')));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (const name of ['alpha', 'beta']) {
    await command('git', ['init', '--bare', '--initial-branch=main', join(root, `${name}.git`)], root);
    await command('git', ['clone', join(root, `${name}.git`), join(root, name)], root);
    const repo = join(root, name);
    await git(repo, 'config', 'user.name', 'Queue test');
    await git(repo, 'config', 'user.email', 'queue@example.invalid');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await commit(repo, `init ${name}`, { 'README.md': `${name}\n` });
    await git(repo, 'push', 'origin', 'main');
    if (name === 'alpha') {
      await commit(repo, 'plan', { 'docs/handoffs/plan.md': '# plan\n' });
      await git(repo, 'push', 'origin', 'main');
    }
  }
  const planningCommit = await git(join(root, 'alpha'), 'rev-parse', 'HEAD');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'nsq-siblingstore-')));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'queue.sqlite'));
  t.after(() => store.close());
  const alpha = { origin: 'acme/alpha', path: join(root, 'alpha') };
  const beta = { origin: 'acme/beta', path: join(root, 'beta') };
  return { root, dir, store, alpha, beta, planningCommit };
}

function engineFor(t: TestContext, store: Store, dir: string) {
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile],
    validate: async task => task.planningCommit,
    createWorkspace: async task => ({ id: `ws-${task.id}`, directory: join(dir, `work-${task.id}`) }),
    verifyWorkspace: async task => task.branch,
    createAgent: createTaskAgent,
    observe: async id => ({ id, workspaceId: store.tasks().find(task => task.agentId === id)?.workspaceId ?? null, status: 'idle', active: false, permissions: false, error: '' }),
    archiveTaskWorkspace: async () => true,
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'b'.repeat(40) }),
    findOpenBranchPr: async () => [],
  });
  const engine = new Engine(store, adapter, 0);
  engine.profiles = [profile];
  engine.siblingDataDir = dir;
  t.after(() => engine.stop());
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  store.setMeta('paused', false);
  return engine;
}

function submit(store: Store, repoPath: string, origin: string, title = 'Sibling task', extra: Record<string, unknown> = {}, planning?: { commit: string; handoff: string; base: string }) {
  const commit = planning?.commit ?? 'a'.repeat(40);
  const handoff = planning?.handoff ?? 'handoff.md';
  const base = planning?.base ?? 'a'.repeat(40);
  return store.insert(submissionSchema.parse({ submissionId: randomUUID(), title, repoPath, planningCommit: commit, handoffPath: handoff, originAgentId: 'origin', ...extra }), 'host', 'handoff', base, {}, undefined, origin);
}

test('Spec 027 #6 task in a two-repository project gets a pinned detached sibling worktree', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  const members = siblingMembers(task, f.store.projectFor(task.repoPath, task.repository));
  assert.deepEqual(members, [f.beta]);
  const { pins, skipped } = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members });
  assert.deepEqual(skipped, []);
  assert.equal(pins.length, 1);
  const pin = pins[0];
  assert.equal(pin.repository, 'acme/beta');
  assert.equal(pin.path, siblingPathFor(f.dir, task.id, 'beta'));
  assert.ok(existsSync(pin.path));
  // Detached at the fetched origin/main: no branch, exact commit.
  assert.equal(await git(pin.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  assert.equal(await git(pin.path, 'rev-parse', 'HEAD'), await git(f.beta.path, 'rev-parse', 'refs/remotes/origin/main'));
  assert.equal(pin.commit, await git(f.beta.path, 'rev-parse', 'refs/remotes/origin/main'));
  // The path is in the worker prompt and the commit is recorded on the task and the outcome row.
  const pinned = f.store.update(task.id, { siblingPins: pins });
  assert.match(workerPrompt(pinned, true), new RegExp(pin.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(workerPrompt(pinned, true), /read-only by rule/);
  const run: Run = { id: randomUUID(), taskId: task.id, role: 'reviewer', generation: 1, head: 'a'.repeat(40), base: 'a'.repeat(40), agentId: null, workspaceId: 'ws', profile: null, status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: null, idleSince: null, completion: null, released: false, siblings: pins };
  f.store.putRun(run);
  assert.deepEqual(f.store.run(run.id)!.siblings, pins);
  const outcome = buildOutcomeRecord(f.store.task(task.id), f.store.runs(task.id), [], false);
  assert.deepEqual(outcome.siblings, [{ repository: 'acme/beta', commit: pin.commit }]);
});

test('Spec 027 #6 dispatch records sibling intent before pins and clears it after', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const engine = engineFor(t, f.store, f.dir);
  const task = submit(f.store, f.alpha.path, f.alpha.origin, 'Sibling task', {}, { commit: f.planningCommit, handoff: 'docs/handoffs/plan.md', base: f.planningCommit });
  await engine.wake();
  const dispatched = f.store.task(task.id);
  assert.equal(dispatched.siblingIntent, false);
  assert.equal(dispatched.siblingPins.length, 1);
  assert.ok(f.store.events(task.id).some(event => event.kind === 'sibling_worktrees_intent'));
  assert.ok(f.store.events(task.id).some(event => event.kind === 'sibling_worktrees_created'));
});

test('Spec 027 #7 queue.siblings false creates no worktree and leaves prompts unchanged', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const parsed = submissionSchema.parse({ submissionId: randomUUID(), title: 'Opt out', repoPath: f.alpha.path, planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin', siblings: false });
  assert.equal(parsed.siblings, false);
  const doc = `---\ntitle: Opt out\nkind: northstar-handoff\nhandoff_mode: worker-pr-loop\nworker_mode: implementation\ndispatch_authority: orchestrator\nstatus: ready-to-launch\nqueue_dispatch: northstar-queue\nqueue_approval: test\nbase_required: pushed-main\nqueue:\n  siblings: false\n---\n## What This Thread Was Doing\n\nBody.\n\n## Why It Matters\n\nBody.\n\n## Current State\n\nBody.\n\n## Boundaries\n\nBody.\n\n## Important Context\n\nBody.\n\n## Suggested Next Move\n\nBody.\n\n## Completion Protocol\n\nBody.\n`;
  assert.equal(parseNorthstarDocument(doc, 'handoff').queue.siblings, false);
  const engine = engineFor(t, f.store, f.dir);
  const task = submit(f.store, f.alpha.path, f.alpha.origin, 'Opt out', { siblings: false }, { commit: f.planningCommit, handoff: 'docs/handoffs/plan.md', base: f.planningCommit });
  assert.equal(siblingsEnabled(task), false);
  await engine.wake();
  const dispatched = f.store.task(task.id);
  assert.deepEqual(dispatched.siblingPins, []);
  assert.ok(!existsSync(join(f.dir, 'siblings', task.id)));
  assert.doesNotMatch(workerPrompt(dispatched, true), /Sibling repositories/);
  const run = { id: randomUUID(), role: 'reviewer', generation: 1, head: 'a'.repeat(40) } as Run;
  assert.doesNotMatch(runPrompt(dispatched as Task, run, '/helper', '/ticket', true), /Sibling repositories/);
});

test('Spec 027 #8 a dirty, committed or moved sibling becomes a finding and nothing is merged or pushed', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  const before = await git(join(f.root, 'beta.git'), 'rev-parse', 'refs/heads/main');
  const { pins } = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members: [f.beta] });
  const pinned = f.store.update(task.id, { siblingPins: pins });
  // A dirty file plus a local commit on the detached head.
  await writeFile(join(pins[0].path, 'local.txt'), 'worker edit\n');
  await git(pins[0].path, 'commit', '-m', 'sibling commit', '--', 'local.txt').catch(() => {});
  const inspections = await inspectSiblingWorktrees(pins);
  assert.equal(inspections.length, 1);
  assert.equal(inspections[0].changed, true);
  const finding = findingFor(inspections[0], new Date().toISOString());
  assert.ok(finding);
  const withFinding = f.store.update(task.id, { siblingFindings: [finding!] });
  assert.equal(withFinding.siblingFindings.length, 1);
  // The finding reaches task detail and the reviewer input.
  const detail = f.store.task(task.id);
  assert.deepEqual(detail.siblingFindings, [finding!]);
  const run = { id: randomUUID(), role: 'reviewer', generation: 1, head: 'a'.repeat(40) } as Run;
  const prompt = runPrompt(detail, run, '/helper', '/ticket', true);
  assert.match(prompt, /Sibling repositories \(read-only by rule/);
  assert.match(prompt, new RegExp(finding!.expected.slice(0, 12)));
  // Nothing from the sibling is merged or pushed: the sibling origin and the task repository are untouched.
  assert.equal(await git(join(f.root, 'beta.git'), 'rev-parse', 'refs/heads/main'), before);
  assert.equal(await git(f.alpha.path, 'status', '--porcelain'), '');
  assert.equal(pinned.branch, `ns-${task.id}`);
});

test('Spec 027 #8 a worker completion records the sibling comparison once', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const engine = engineFor(t, f.store, f.dir);
  const task = submit(f.store, f.alpha.path, f.alpha.origin, 'Sibling task', {}, { commit: f.planningCommit, handoff: 'docs/handoffs/plan.md', base: f.planningCommit });
  await engine.wake();
  let current = f.store.task(task.id);
  assert.equal(current.phase, 'working');
  assert.equal(current.siblingPins.length, 1);
  await writeFile(join(current.siblingPins[0].path, 'dirty.txt'), 'dirty\n');
  const token = randomUUID();
  f.store.db.prepare("DELETE FROM credentials WHERE run=?").run(current.runId!);
  f.store.setCredential(current.runId!, token);
  await engine.complete({ eventId: randomUUID(), taskId: current.id, runId: current.runId!, status: 'blocked', summary: 'Waiting on review' }, token);
  await engine.wake();
  current = f.store.task(task.id);
  assert.equal(current.siblingFindings.length, 1);
  assert.equal(current.siblingFindings[0].repository, 'acme/beta');
  assert.equal(current.siblingFindings[0].dirty, true);
  const events = f.store.events(current.id).filter(event => event.kind.startsWith('sibling_compared:'));
  assert.equal(events.length, 1);
  await engine.wake();
  assert.equal(f.store.task(task.id).siblingFindings.length, 1);
});

test('Spec 027 #9 cleanup removes sibling worktrees and never touches operator checkouts', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const engine = engineFor(t, f.store, f.dir);
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  const { pins } = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members: [f.beta] });
  f.store.update(task.id, { siblingPins: pins });
  const betaHead = await git(f.beta.path, 'rev-parse', 'HEAD');
  await engine.removeSiblings(task.id);
  assert.ok(!existsSync(join(f.dir, 'siblings', task.id)));
  assert.ok(!existsSync(pins[0].path));
  // The operator checkout is intact and still registered as a worktree of its own repository.
  assert.ok(existsSync(join(f.beta.path, 'README.md')));
  assert.equal(await git(f.beta.path, 'rev-parse', 'HEAD'), betaHead);
  assert.equal(await git(f.beta.path, 'status', '--porcelain'), '');
  await engine.removeSiblings(task.id);
});

test('Spec 027 #10 an uncertain sibling creation reconciles by path and commit, never duplicated', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  const members = siblingMembers(task, f.store.projectFor(task.repoPath, task.repository));
  const first = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members });
  // A restart after intent but before pins: the same creation runs again.
  const second = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members });
  assert.deepEqual(second.pins, first.pins);
  const entries = readdirSync(join(f.dir, 'siblings', task.id));
  assert.deepEqual(entries, [basename(first.pins[0].path)]);
  const list = await git(f.beta.path, 'worktree', 'list', '--porcelain');
  assert.equal(list.split('\n').filter(line => line === `worktree ${first.pins[0].path}`).length, 1);
});

test('Spec 027 #6 revision prompts receive sibling paths and the read-only rule', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  const { pins } = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members: [f.beta] });
  const pinned = f.store.update(task.id, { siblingPins: pins }) as Task;
  const escaped = pins[0].path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const revision = { id: 'rev', role: 'revision', generation: 1, head: 'a'.repeat(40) } as Run;
  assert.match(runPrompt(pinned, revision, '/helper', '/ticket', true), new RegExp(escaped));
  assert.match(runPrompt(pinned, revision, '/helper', '/ticket', true), /read-only by rule/);
  const prePr = runPrompt({ ...pinned, completion: null, resumePrNumber: null } as Task, revision, '/helper', '/ticket', false);
  assert.match(prePr, new RegExp(escaped));
});

test('Spec 027 #10 a conflicting sibling path skips that member instead of parking dispatch', { timeout: HOOK_TEST_TIMEOUT_MS }, async (t: TestContext) => {
  const f = await twoRepos(t);
  f.store.upsertProject({ key: 'suite', name: 'Suite', repositories: [f.alpha, f.beta], primary: f.alpha });
  const task = submit(f.store, f.alpha.path, f.alpha.origin);
  // A foreign file occupies beta's worktree path; alpha's member row still pins.
  await mkdir(join(f.dir, 'siblings', task.id), { recursive: true });
  await writeFile(siblingPathFor(f.dir, task.id, 'beta'), 'foreign file\n');
  const { pins, skipped } = await createSiblingWorktrees({ dataDir: f.dir, taskId: task.id, baseBranch: 'main', members: [f.beta, f.alpha] });
  assert.equal(pins.length, 1);
  assert.equal(pins[0].repository, 'acme/alpha');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].repository, 'acme/beta');
  assert.match(skipped[0].reason, /unusable/);
});
