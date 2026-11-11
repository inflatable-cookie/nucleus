import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../core/store/store';
import { RepositoryHooks } from '../core/hooks/hooks';
import { command, git } from '../core/git/index';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-warm-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await command('git', ['init', '-b', 'main'], repo);
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'remote', 'add', 'origin', repo);
  await git(repo, 'commit', '--allow-empty', '-m', 'base');
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const path = join(common, 'queue-hooks', 'prospective-merge-warm');
  await mkdir(join(common, 'queue-hooks'));
  await git(repo, 'clone', '--shared', '--no-checkout', '--', repo, path);
  await git(path, 'checkout', '--detach', 'HEAD');
  await git(path, 'config', '--local', 'queue.warmOwner', common);
  const store = new Store(join(root, 'queue.sqlite'));
  // Registered repositories are swept even when no surviving task refers to them.
  store.db.prepare('INSERT INTO repository_settings (key,data) VALUES (?,?)').run('fixture', JSON.stringify({
    repository: { path: repo, origin: null }, updatedAt: new Date().toISOString(),
  }));
  return { root, repo, common, path, store, hooks: new RepositoryHooks(store) };
}

test('the one-time sweep disposes proved owned legacy warm clones and preserves other old content', async () => {
  const f = await fixture();
  try {
    const retained = join(f.common, 'queue-hooks', 'unrelated');
    await writeFile(retained, 'preserved');
    await f.hooks.disposeLegacyWarmCheckouts();
    assert.equal(existsSync(f.path), false);
    assert.equal(existsSync(retained), true);
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), true);
    await f.hooks.disposeLegacyWarmCheckouts();
  } finally { f.store.close(); }
});

test('the sweep preserves a foreign clone and leaves disposal incomplete', async () => {
  const f = await fixture();
  try {
    await git(f.path, 'config', '--local', 'queue.warmOwner', 'foreign');
    await assert.rejects(f.hooks.disposeLegacyWarmCheckouts(), /owner changed/);
    assert.equal(existsSync(f.path), true);
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), undefined);
  } finally { f.store.close(); }
});

test('a failed repository lookup leaves the sweep retryable after the repository returns', async () => {
  const f = await fixture();
  const offline = join(f.root, 'offline');
  try {
    await rename(f.repo, offline);
    await assert.rejects(f.hooks.disposeLegacyWarmCheckouts());
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), undefined);
    assert.equal(existsSync(join(offline, '.git', 'queue-hooks', 'prospective-merge-warm')), true);
    await rename(offline, f.repo);
    await new RepositoryHooks(f.store).disposeLegacyWarmCheckouts();
    assert.equal(existsSync(f.path), false);
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), true);
  } finally { f.store.close(); }
});

test('an inaccessible warm-clone ancestor keeps disposal retryable until access returns', async () => {
  const f = await fixture();
  const ancestor = join(f.common, 'queue-hooks');
  const mode = (await lstat(ancestor)).mode & 0o777;
  try {
    await chmod(ancestor, 0o000);
    await assert.rejects(f.hooks.disposeLegacyWarmCheckouts(), { code: 'EACCES' });
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), undefined);
    await chmod(ancestor, mode);
    assert.equal(existsSync(f.path), true);
    await new RepositoryHooks(f.store).disposeLegacyWarmCheckouts();
    assert.equal(existsSync(f.path), false);
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), true);
  } finally {
    await chmod(ancestor, mode);
    f.store.close();
  }
});

test('a positively absent warm clone allows the one-time sweep to complete', async () => {
  const f = await fixture();
  const retained = join(f.root, 'retained-clone');
  try {
    await rename(f.path, retained);
    await f.hooks.disposeLegacyWarmCheckouts();
    assert.equal(existsSync(retained), true);
    assert.equal(f.store.getMeta('legacyWarmCheckoutsDisposed'), true);
  } finally { f.store.close(); }
});
