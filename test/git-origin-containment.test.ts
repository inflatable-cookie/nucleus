import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, git, originBranchContaining } from '../core/git/index';

async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nucleus-origin-containment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  return { root, origin, repo, head };
}

async function addRefs(origin: string, head: string, names: readonly string[]) {
  const input = names.map(name => `update refs/heads/${name} ${head}`).join('\n') + '\n';
  const result = spawnSync('git', ['--git-dir', origin, 'update-ref', '--stdin'], { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function useGitWrapper(t: import('node:test').TestContext, root: string, origin: string, deleteRef?: string) {
  const bin = join(root, 'bin');
  await mkdir(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(root, 'fetch.log'), mark = join(root, 'deleted');
  const wrapper = join(bin, 'git');
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = fetch ]; then\n  printf '%s\\n' "$@" >> "$FETCH_LOG"\n  if [ -n "${'${DELETE_REF:-}'}" ] && [ ! -e "$DELETE_MARK" ]; then\n    "$REAL_GIT" --git-dir="$ORIGIN" update-ref -d "$DELETE_REF"\n    : > "$DELETE_MARK"\n  fi\nfi\nexec "$REAL_GIT" "$@"\n`);
  await chmod(wrapper, 0o755);
  const previous = { PATH: process.env.PATH, REAL_GIT: process.env.REAL_GIT, ORIGIN: process.env.ORIGIN,
    FETCH_LOG: process.env.FETCH_LOG, DELETE_MARK: process.env.DELETE_MARK, DELETE_REF: process.env.DELETE_REF };
  process.env.PATH = `${bin}:${previous.PATH ?? ''}`;
  process.env.REAL_GIT = realGit;
  process.env.ORIGIN = origin;
  process.env.FETCH_LOG = log;
  process.env.DELETE_MARK = mark;
  if (deleteRef) process.env.DELETE_REF = deleteRef;
  else delete process.env.DELETE_REF;
  t.after(() => {
    process.env.PATH = previous.PATH;
    for (const key of ['REAL_GIT', 'ORIGIN', 'FETCH_LOG', 'DELETE_MARK', 'DELETE_REF'] as const) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return log;
}

test('proves a preferred containing branch after fetching only preferred branches', async t => {
  const { root, origin, repo, head } = await fixture(t);
  await addRefs(origin, head, ['preferred', 'other']);
  const log = await useGitWrapper(t, root, origin);
  assert.equal(await originBranchContaining(repo, head, ['preferred', 'missing']), 'preferred');
  const fetchArgs = (await readFile(log, 'utf8')).trim().split('\n');
  assert.deepEqual(fetchArgs.filter(line => line.startsWith('refs/heads/')), ['refs/heads/preferred']);
  assert.equal(await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin'), '');
  assert.equal(await git(repo, 'rev-parse', '--verify', 'FETCH_HEAD').catch(() => ''), '');
});

test('a branch deleted between advertisement and fetch does not fail the proof', async t => {
  const { root, origin, repo, head } = await fixture(t);
  await addRefs(origin, head, ['a-vanish', 'z-containing']);
  await useGitWrapper(t, root, origin, 'refs/heads/a-vanish');
  assert.equal(await originBranchContaining(repo, head, ['not-advertised']), 'main');
});

test('proves containment in a repository advertising at least 3,000 branches', async t => {
  const { root, origin, repo, head } = await fixture(t);
  const names = Array.from({ length: 3000 }, (_, i) => `branch-${String(i).padStart(4, '0')}`);
  await addRefs(origin, head, names);
  const log = await useGitWrapper(t, root, origin);
  assert.equal(await originBranchContaining(repo, head, ['not-advertised']), names[0]);
  const fetches = (await readFile(log, 'utf8')).trim().split('\n').filter(line => line === 'fetch');
  assert.ok(fetches.length > 1, 'the wider branch set is fetched in bounded batches');
  assert.equal(fetches.length, Math.ceil((names.length + 1) / 64));
});
