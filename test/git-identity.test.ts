import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitIdentityError, readGitCheckout, readGitRef } from '../core/git/git-identity';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repoFixture(t: { after: (fn: () => void) => void }, name: string) {
  const root = mkdtempSync(join(tmpdir(), `ns-git-id-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'remote', 'add', 'origin', 'https://example.test/o/r.git');
  writeFileSync(join(repo, 'a'), 'a\n');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-qm', 'a');
  return { root, repo };
}

function expectMatchesGit(directory: string) {
  const identity = readGitCheckout(directory);
  assert.equal(identity.toplevel, realpathSync(git(directory, 'rev-parse', '--show-toplevel')));
  assert.equal(identity.commonDir, realpathSync(git(directory, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
  assert.equal(identity.head, git(directory, 'rev-parse', 'HEAD'));
  assert.equal(identity.branch, git(directory, 'branch', '--show-current'));
  assert.equal(identity.origin, git(directory, 'config', '--get', 'remote.origin.url'));
  return identity;
}

test('filesystem identity matches git for a regular checkout', t => {
  const { repo } = repoFixture(t, 'regular');
  const identity = expectMatchesGit(repo);
  assert.equal(readGitRef(identity, 'refs/heads/main'), identity.head);
});

test('filesystem identity matches git for a linked worktree, including detached HEAD', t => {
  const { root, repo } = repoFixture(t, 'worktree');
  const checkout = join(root, 'checkout');
  git(repo, 'worktree', 'add', '-q', '-b', 'task', checkout);
  const linked = expectMatchesGit(checkout);
  assert.equal(linked.branch, 'task');
  assert.equal(linked.commonDir, readGitCheckout(repo).commonDir);
  git(checkout, 'checkout', '-q', '--detach');
  const detached = expectMatchesGit(checkout);
  assert.equal(detached.branch, '');
  assert.equal(detached.head, linked.head);
});

test('filesystem identity reads packed-refs after a prune', t => {
  const { repo } = repoFixture(t, 'packed');
  git(repo, 'pack-refs', '--all');
  rmSync(join(repo, '.git', 'refs', 'heads', 'main'), { force: true });
  const identity = expectMatchesGit(repo);
  assert.equal(readGitRef(identity, 'refs/heads/main'), identity.head);
  const packed = readFileSync(join(repo, '.git', 'packed-refs'), 'utf8');
  assert.match(packed, /refs\/heads\/main/);
});

test('reftable repositories fail closed', t => {
  const { repo } = repoFixture(t, 'reftable');
  mkdirSync(join(repo, '.git', 'reftable'), { recursive: true });
  assert.throws(() => readGitCheckout(repo), /Reftable backend/, 'a reftable directory is refused even when packed-refs still exist');
});
