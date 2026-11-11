/**
 * Task 372 — Git fixture seeds give every fixture independent real repositories.
 *
 * A fixture's refs, config, objects and worktree changes never reach the seed or
 * another fixture, teardown of one fixture leaves the others and the seed whole,
 * and a copy's recorded paths and index belong to its own root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { git } from '../core/git/index';
import { buildConfiguredClone, materializeSeed, seedRoot, type GitSeed } from './support/git-seed';

const published: GitSeed = { name: 'seed-test', build: async root => {
  await buildConfiguredClone(root);
  await writeFile(join(root, 'repo', 'README.md'), '# seed\n');
  await git(join(root, 'repo'), 'add', '-A');
  await git(join(root, 'repo'), 'commit', '-m', 'initial');
  await git(join(root, 'repo'), 'push', 'origin', 'main');
} };

async function files(root: string, from = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const path = join(from, entry.name);
    if (entry.isDirectory()) out.push(...await files(root, path));
    else out.push(relative(root, path));
  }
  return out.sort();
}

/** Every path, mode and byte of a tree. */
async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const path of await files(root)) {
    const full = join(root, path);
    hash.update(`${path}\0${(await stat(full)).mode}\0`).update(await readFile(full)).update('\0');
  }
  return hash.digest('hex');
}

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nsq-git-seed-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await materializeSeed(published, root);
  return { root, repo: join(root, 'repo'), origin: join(root, 'origin.git') };
}

test('a materialized fixture owns real, independent repositories rooted in its own directory', async t => {
  const a = await fixture(t), b = await fixture(t);
  const seed = await seedRoot(published);
  for (const f of [a, b]) {
    assert.equal(await git(f.repo, 'remote', 'get-url', 'origin'), f.origin);
    assert.equal(await git(f.repo, 'status', '--porcelain'), '');
    // Plumbing does not refresh stat data: the copied index already matches.
    await git(f.repo, 'diff-files', '--quiet');
    assert.equal(await git(f.repo, 'rev-parse', 'HEAD'), await git(f.origin, 'rev-parse', 'refs/heads/main'));
    assert.equal(await git(f.repo, 'rev-parse', '@{upstream}'), await git(f.repo, 'rev-parse', 'HEAD'));
    await git(f.repo, 'fsck', '--strict');
    await git(f.origin, 'fsck', '--strict');
    for (const path of await files(f.root)) {
      const copy = join(f.root, path), info = await stat(copy);
      assert.equal(info.nlink, 1, `${path} is not a hard link`);
      assert.notEqual(info.ino, (await stat(join(seed, path))).ino, `${path} has its own inode`);
      assert.equal(info.mode, (await stat(join(seed, path))).mode, `${path} keeps its mode`);
      if (!path.split('/').includes('objects')) assert.ok(!(await readFile(copy, 'utf8')).includes(seed), `${path} names no seed path`);
    }
  }
});

test('mutating or removing one fixture never reaches the seed or another fixture', async t => {
  const a = await fixture(t), b = await fixture(t);
  const seed = await seedRoot(published);
  const seedBefore = await fingerprint(seed), bBefore = await fingerprint(b.root);
  const base = await git(b.repo, 'rev-parse', 'HEAD');

  // Config, objects, refs, origin refs, worktree state and a linked worktree.
  await git(a.repo, 'config', 'user.name', 'Mutated');
  await writeFile(join(a.repo, 'README.md'), '# changed\n');
  await git(a.repo, 'commit', '-am', 'mutation');
  const mutated = await git(a.repo, 'rev-parse', 'HEAD');
  await git(a.repo, 'push', 'origin', 'main');
  await git(a.repo, 'branch', 'side', base);
  await git(a.repo, 'update-ref', 'refs/heads/main', base);
  await git(a.repo, 'worktree', 'add', join(a.root, 'linked'), 'side');
  await writeFile(join(a.repo, 'dirty.txt'), 'dirty\n');
  await git(a.repo, 'gc', '--prune=now', '--quiet');

  assert.equal(await git(a.origin, 'rev-parse', 'refs/heads/main'), mutated);
  assert.equal(await fingerprint(seed), seedBefore, 'the seed is unchanged');
  assert.equal(await fingerprint(b.root), bBefore, 'the sibling fixture is unchanged');
  assert.equal(await git(b.origin, 'rev-parse', 'refs/heads/main'), base);
  await assert.rejects(git(b.repo, 'cat-file', '-e', mutated), 'a sibling never sees another fixture\'s objects');
  await assert.rejects(git(b.origin, 'cat-file', '-e', mutated));
  assert.equal(await git(b.repo, 'config', 'user.name'), 'Queue test');
  assert.equal(await git(b.repo, 'worktree', 'list', '--porcelain').then(list => list.split('\n').filter(line => line.startsWith('worktree ')).length), 1);

  await rm(a.root, { recursive: true, force: true });
  assert.equal(await fingerprint(seed), seedBefore, 'teardown leaves the seed whole');
  assert.equal(await fingerprint(b.root), bBefore, 'teardown leaves the sibling whole');
  const c = await fixture(t);
  assert.equal(await git(c.repo, 'rev-parse', 'HEAD'), base, 'a later fixture starts from the unchanged seed');
  assert.equal(await git(c.repo, 'status', '--porcelain'), '');
});
