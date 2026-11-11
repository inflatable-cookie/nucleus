import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOrdinaryReviewIdentity, ordinaryReviewSource } from '../core/review/ordinary-review';
import type { Task } from '../shared/contracts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'ns-ordinary-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), checkout = join(root, 'checkout');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'remote', 'add', 'origin', 'https://example.test/o/r.git');
  writeFileSync(join(repo, 'a'), 'a'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'task', checkout);
  const task = { workspaceIntent: { id: 'w' }, directory: checkout, branch: 'task', baseBranch: 'main', repoPath: repo } as unknown as Task;
  return { checkout, task, git, head: git(checkout, 'rev-parse', 'HEAD') };
}

test('a dirty tree refuses with no window', async t => {
  const f = fixture(t);
  await ordinaryReviewSource(f.task, f.head, false);
  writeFileSync(join(f.checkout, 'dirt'), 'x');
  await assert.rejects(() => ordinaryReviewSource(f.task, f.head, false), /checkout is dirty.*expected an empty porcelain status/, 'a dirty result names the observed checkout state');
  assert.doesNotThrow(() => assertOrdinaryReviewIdentity(f.task, f.head, false), 'identity stays exact-head while the tree is dirty');
});

test('a moved head or branch refuses at once', async t => {
  const f = fixture(t);
  await ordinaryReviewSource(f.task, f.head, false);
  f.git(f.checkout, 'checkout', '-q', '--detach');
  await assert.rejects(() => ordinaryReviewSource(f.task, f.head, false), /checkout identity mismatch.*expected HEAD/, 'the branch and head mismatch are named');
  await ordinaryReviewSource(f.task, f.head, true);
  writeFileSync(join(f.checkout, 'b'), 'b'); f.git(f.checkout, 'checkout', '-q', 'task'); f.git(f.checkout, 'add', 'b'); f.git(f.checkout, 'commit', '-qm', 'b');
  const head = f.git(f.checkout, 'rev-parse', 'HEAD');
  await assert.rejects(() => ordinaryReviewSource(f.task, f.head, false), /checkout identity mismatch.*expected HEAD/, 'the recorded head mismatch is named');
  await ordinaryReviewSource(f.task, head, false);
});
