import { fakeAdapter, createTaskAgent } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, readStash, stashFindings, verifyCheckpoint } from '../core/git/index';
import { Engine } from '../core/engine';
import { Store } from '../core/store/store';
import { submissionSchema, type Profile, type Task } from '../shared/contracts';
import type { Adapter } from '../core/host';
import { runtimeSourceRoots } from './support/runtime-source-roots';

/** A repository with two Queue worktrees sharing one stash list. */
async function worktrees() {
  const dir = mkdtempSync(join(tmpdir(), 'ns-stash-'));
  const repo = join(dir, 'repo');
  await git(dir, 'init', '-q', '-b', 'main', repo);
  await git(repo, 'config', 'user.email', 'queue@example.com');
  await git(repo, 'config', 'user.name', 'Queue');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  await git(repo, 'add', 'file.txt');
  await git(repo, 'commit', '-q', '-m', 'base');
  const other = `ns-${randomUUID()}`, own = `ns-${randomUUID()}`;
  await git(repo, 'worktree', 'add', '-q', '-b', other, join(dir, 'other'));
  await git(repo, 'worktree', 'add', '-q', '-b', own, join(dir, 'own'));
  const task = { directory: join(dir, 'own'), branch: own, baseBranch: 'main', planningBase: '', runId: 'run', resolution: { currentRunId: null }, stashBaseline: null } as unknown as Task;
  return { dir, repo, other, own, otherDir: join(dir, 'other'), task, close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** Stash another task's dirty worktree, as a Chatterbox did in the recorded incident. */
async function stashOtherTask(f: Awaited<ReturnType<typeof worktrees>>) {
  writeFileSync(join(f.otherDir, 'file.txt'), 'other task work\n');
  await git(f.otherDir, 'stash', 'push', '-q', '-m', 'other task in progress');
  return (await readStash(f.otherDir))[0];
}

test('a worktree that pops another worktree\'s stash produces a finding naming the entry', async () => {
  const f = await worktrees(); try {
    const entry = await stashOtherTask(f);
    f.task.stashBaseline = { runId: 'run', entries: await readStash(f.task.directory!) };
    await git(f.task.directory!, 'stash', 'pop', '-q');
    const head = await git(f.task.directory!, 'rev-parse', 'HEAD');
    await assert.rejects(verifyCheckpoint(f.task, head), (error: Error) => {
      assert.match(error.message, /^Bounded checkpoint requires a clean worktree/);
      assert.ok(error.message.includes(`stash entry ${entry.sha.slice(0, 12)} "On ${f.other}: other task in progress" was popped or dropped during this run`), error.message);
      assert.ok(error.message.includes(`taken on ${f.other}, not ${f.own}`), error.message);
      return true;
    });
  } finally { f.close(); }
});

test('a run that never touches the stash produces no stash finding', async () => {
  const f = await worktrees(); try {
    await stashOtherTask(f);
    f.task.stashBaseline = { runId: 'run', entries: await readStash(f.task.directory!) };
    writeFileSync(join(f.task.directory!, 'file.txt'), 'own uncommitted work\n');
    const head = await git(f.task.directory!, 'rev-parse', 'HEAD');
    await assert.rejects(verifyCheckpoint(f.task, head), (error: Error) => {
      assert.equal(error.message, 'Bounded checkpoint requires a clean worktree; commit or report blocked instead');
      return true;
    });
  } finally { f.close(); }
});

test('stash comparison ignores the task\'s own entries and names new stashes of other Queue branches', () => {
  const own = `ns-${randomUUID()}`, other = `ns-${randomUUID()}`;
  const ownEntry = { sha: '1'.repeat(40), subject: `WIP on ${own}: abc own` };
  const otherEntry = { sha: '2'.repeat(40), subject: `On ${other}: parked` };
  const mainEntry = { sha: '3'.repeat(40), subject: 'WIP on main: abc operator' };
  assert.deepEqual(stashFindings(own, [ownEntry], []), []);
  assert.deepEqual(stashFindings(own, [ownEntry, otherEntry, mainEntry], [ownEntry, otherEntry, mainEntry]), []);
  assert.deepEqual(stashFindings(own, [], [mainEntry]), []);
  assert.deepEqual(stashFindings(own, [mainEntry], []), [`stash entry ${'3'.repeat(12)} "WIP on main: abc operator" was popped or dropped during this run; it was taken on main, not ${own}`]);
  assert.deepEqual(stashFindings(own, [], [otherEntry]), [`stash entry ${'2'.repeat(12)} "On ${other}: parked" names another Queue branch ${other}`]);
});

test('an absent stash reads as an empty list', async () => {
  const f = await worktrees(); try {
    assert.deepEqual(await readStash(f.task.directory!), []);
  } finally { f.close(); }
});

test('the worker launch records the shared stash list for the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns-stash-engine-')), store = new Store(join(dir, 'queue.sqlite'));
  const profile: Profile = { id: 'worker', name: 'Worker', provider: 'test', model: 'test', notes: '', available: true, problem: '', supportedThinking: [] };
  const entries = [{ sha: '4'.repeat(40), subject: 'On main: operator' }];
  const reads: string[] = [];
  const adapter: Adapter = fakeAdapter({
    profiles: async () => [profile], validate: async t => t.planningCommit,
    createWorkspace: async t => ({ id: `ws-${t.id}`, directory: '/fixture' }),
     verifyWorkspace: async t => t.branch,
    createAgent: createTaskAgent,
    observe: async id => ({ id, workspaceId: `ws-${id.slice(6)}`, status: 'running', active: true, permissions: false, error: '' }),
    verifyPr: async () => ({ url: 'https://github.com/example/repo/pull/1', head: 'abc' }),
    readStash: async directory => { reads.push(directory); return entries; },
  });
  const engine = new Engine(store, adapter, 0); engine.profiles = [profile];
  store.setMeta('pool', [{ profileId: profile.id, enabled: true, group: 'test', weight: 1, scopes: ['general'] }]);
  store.setMeta('paused', false);
  try {
    const task = store.insert(submissionSchema.parse({ submissionId: randomUUID(), title: 'Task', repoPath: '/project', planningCommit: 'a'.repeat(40), handoffPath: 'handoff.md', originAgentId: 'origin' }), 'host', 'handoff', 'a'.repeat(40));
    await engine.wake();
    const current = store.task(task.id);
    assert.equal(current.phase, 'working');
    assert.deepEqual(reads, ['/fixture']);
    assert.deepEqual(current.stashBaseline, { runId: current.runId, entries });
  } finally { await engine.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Queue code paths never invoke git stash', () => {
  const root = join(import.meta.dirname, '..');
  const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [join(dir, entry.name)] : []);
  const files = [...runtimeSourceRoots(root).flatMap(sources), 'index.server.ts', 'mcp-report.mjs'];
  assert.ok(files.includes(join('core', 'git', 'index.ts')));
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.doesNotMatch(text, /(["'`])stash\1/, `${file} passes stash as a git argument`);
  }
});
