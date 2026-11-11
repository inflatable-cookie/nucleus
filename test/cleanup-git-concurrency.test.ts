import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, git, originBranchContaining } from '../core/git/index';

test('archive publication proofs coexist with worktree creation and integration fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleanup-git-'));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo');
  await command('git', ['init', '--bare', '--initial-branch=main', origin], root);
  await command('git', ['init', '--initial-branch=main', repo], root);
  await git(repo, 'config', 'user.name', 'test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'base'), 'base');
  await git(repo, 'add', 'base');
  await git(repo, 'commit', '-m', 'base');
  await git(repo, 'remote', 'add', 'origin', origin);
  await git(repo, 'push', 'origin', 'main');
  const head = await git(repo, 'rev-parse', 'HEAD');
  const worktrees = Array.from({ length: 4 }, (_, i) => join(root, `task-${i}`));
  for (let i = 0; i < worktrees.length; i++) await git(repo, 'worktree', 'add', '-b', `task-${i}`, worktrees[i]!);
  await writeFile(join(worktrees[0]!, 'change'), 'change');
  await git(worktrees[0]!, 'add', 'change');
  await git(worktrees[0]!, 'commit', '-m', 'task change');
  const results = await Promise.all([
    ...worktrees.map(dir => originBranchContaining(dir, head, ['main'])),
    git(repo, 'fetch', 'origin', 'main'),
    git(repo, 'worktree', 'add', '-b', 'new-task', join(root, 'new-task')),
    git(repo, 'merge', '--no-ff', '--no-edit', 'task-0'),
  ]);
  assert.deepEqual(results.slice(0, 4), ['main', 'main', 'main', 'main']);
  assert.ok(await git(join(root, 'new-task'), 'rev-parse', 'HEAD'));
  assert.equal(await git(repo, 'show', 'HEAD:change'), 'change');
});
