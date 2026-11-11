import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaseoAdapter } from '../service/paseo-composition';
import type { Task } from '../shared/contracts';

/**
 * Spec 017 (task 494): one folder can carry several Paseo catalog registrations.
 *
 * Consumer-B #794 showed two entries naming one checkout — a human's own "Video
 * template review" entry in one project and the task's source in another — beside
 * the review rounds' pinned views. The duplicate arrived before Queue intake and
 * Queue never merges or reparents a registration it did not make. What Queue owns
 * is its own boundary: it binds the exact existing registration, titles only that
 * one, accounts for every alias at the folder, and never adds a second
 * registration for a folder that already has one.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * A real repository for creation tests. Task 634 (PR 881) proves the owned path
 * on every create by spawning git in the task's repository, so a fixture that
 * exercises creation binds a real repository, not a placeholder path.
 */
function realRepository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-source-repo-')));
  git(root, 'init', '--initial-branch=main', root);
  return root;
}

const registration = (id: string, directory: string, title: string, projectId: string) => ({
  id, workspaceDirectory: directory, workspaceKind: 'worktree', title, projectId,
  project: { checkout: { cwd: directory, isPaseoOwnedWorktree: true, mainRepoRoot: '/repo' } },
  gitRuntime: { isPaseoOwnedWorktree: true },
});

/** The default adapter over a fake daemon listing exactly these registrations. */
function platform(entries: () => unknown[], options: { unreadable?: boolean } = {}) {
  const adapter = new PaseoAdapter('ws://127.0.0.1:1', '/unused/callback.sock', '/unused/worker-report.mjs');
  const creates: Array<{ source: { path?: string } }> = [];
  const titles: Array<{ id: string; title: string }> = [];
  const refs = new Map<string, { name: string; setTitle: (title: string) => Promise<{ title: string }> }>();
  Object.defineProperty(adapter, 'api', { value: {
    workspaces: {
      list: async () => {
        if (options.unreadable) throw Error('catalog read timed out');
        return { entries: entries(), pageInfo: { hasMore: false } };
      },
      create: async (input: { source: { path?: string } }) => {
        creates.push(input);
        return { id: 'wks_created493', directory: input.source.path ?? '/created' };
      },
      ref: (id: string) => {
        const entry = (entries() as Array<{ id: string; title: string }>).find(candidate => candidate.id === id);
        const handle = refs.get(id) ?? {
          name: entry?.title ?? '',
          setTitle: async (title: string) => { titles.push({ id, title }); handle.name = title; return { title }; },
        };
        refs.set(id, handle);
        return { refresh: async () => entry, current: () => entry ?? null, get name() { return handle.name; }, setTitle: handle.setTitle };
      },
    },
    projects: { list: async () => ({ projects: [] }) },
  } });
  return { adapter, creates, titles };
}

const task = {
  id: 'task-494', title: 'Keep external review workspaces bounded', repoPath: '/repo',
  branch: 'ns-task-494', baseBranch: 'main', workspaceId: null, directory: null,
} as unknown as Task;

test('a folder that already lists another registration never receives a second one', async () => {
  const repo = realRepository();
  try {
    const directory = '/worktrees/ns-task-494';
    const { adapter, creates } = platform(() => [registration('wks_fab9d91e45c326d9', directory, 'Video template review', 'prj_5f6e41c54289b4d9')]);
    adapter.findWorkspaces = async () => [];
    adapter.inspectWorkspaceCreation = async () => ({ kind: 'found_done', directory });
    await assert.rejects(adapter.createWorkspace({ ...task, repoPath: repo } as unknown as Task),
      /the folder already has workspace registration wks_fab9d91e45c326d9, which is not this task's/);
    assert.equal(creates.length, 0, 'nothing was sent to Paseo');
    // Every alias at the folder is still accounted for, and nothing was removed.
    const catalog = await adapter.externalWorkspaceCatalog(directory);
    assert.equal(catalog.ok, true);
    assert.deepEqual(catalog.ok && catalog.entries.map(entry => entry.workspaceId), ['wks_fab9d91e45c326d9']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('an empty folder and an unreadable inventory keep ordinary creation unchanged', async () => {
  const repo = realRepository();
  try {
    const directory = '/worktrees/ns-task-494';
    const empty = platform(() => []);
    empty.adapter.findWorkspaces = async () => [];
    empty.adapter.inspectWorkspaceCreation = async () => ({ kind: 'found_done', directory });
    assert.deepEqual(await empty.adapter.createWorkspace({ ...task, repoPath: repo } as unknown as Task), { id: 'wks_created493', directory });
    assert.equal(empty.creates.length, 1);
    // A daemon read failure is not proof of a duplicate: creation is not blocked on
    // a guess, exactly as before this change.
    const unreadable = platform(() => [], { unreadable: true });
    unreadable.adapter.findWorkspaces = async () => [];
    unreadable.adapter.inspectWorkspaceCreation = async () => ({ kind: 'found_done', directory });
    assert.deepEqual(await unreadable.adapter.createWorkspace({ ...task, repoPath: repo } as unknown as Task), { id: 'wks_created493', directory });
    assert.equal(unreadable.creates.length, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('recovery reuses the task\'s own registration at the folder instead of registering a twin', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ns-source-registration-')));
  try {
    const origin = join(root, 'origin.git'), repo = join(root, 'repo'), worktree = join(root, 'task-worktree');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', origin, repo);
    git(repo, 'config', 'user.name', 'Queue Fixture'); git(repo, 'config', 'user.email', 'queue@example.test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'base'); git(repo, 'push', 'origin', 'main');
    git(repo, 'worktree', 'add', '-b', 'ns-task-494', worktree, 'main');
    const head = git(worktree, 'rev-parse', 'HEAD');
    const { adapter, creates } = platform(() => [registration('wks_0eafc799a5266b00', worktree, 'Reviewing: 494', 'prj_1c4fcaf11decd914')]);
    adapter.findWorkspaces = async () => [];
    adapter.inspectWorkspaceCreation = async () => ({ kind: 'found_done', directory: worktree });
    const recovered = await adapter.recoverTaskWorkspace({ ...task, repoPath: repo, workspaceId: 'wks_0eafc799a5266b00',
      directory: worktree, prHead: head, phase: 'blocked' } as unknown as Task);
    assert.deepEqual(recovered, { id: 'wks_0eafc799a5266b00', directory: worktree });
    assert.equal(creates.length, 0, 'the existing registration is reused, not duplicated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the display boundary titles only the task\'s own registration', async () => {
  const directory = '/scratch/consumer-b/cover-sticker-feedback';
  const { adapter, titles } = platform(() => [
    registration('wks_fab9d91e45c326d9', directory, 'Video template review', 'prj_5f6e41c54289b4d9'),
    registration('wks_0eafc799a5266b00', directory, 'Reviewing: 794 Review and integrate the reviewed video template batch', 'prj_1c4fcaf11decd914'),
  ]);
  const own = { ...task, workspaceId: 'wks_0eafc799a5266b00', directory } as unknown as Task;
  await adapter.setTaskWorkspaceTitle(own, 'Reviewing: 794 Review and integrate the reviewed video template batch', 'ns-title-494', false);
  assert.equal(titles.some(entry => entry.id === 'wks_fab9d91e45c326d9'), false, 'a foreign registration is never retitled');
  // One truthful source relationship: both entries stay listed, each with its own
  // name and project, and Queue renames only the one it bound.
  const catalog = await adapter.externalWorkspaceCatalog(directory);
  assert.deepEqual(catalog.ok && catalog.entries.map(entry => entry.workspaceId),
    ['wks_fab9d91e45c326d9', 'wks_0eafc799a5266b00']);
});
