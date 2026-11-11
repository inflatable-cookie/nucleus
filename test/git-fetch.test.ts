import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFetchRefContention, queueGitFetch } from '../core/git/git-fetch';

const casFailure = () => new Error(`fatal: cannot lock ref 'refs/remotes/origin/main': is at ${'a'.repeat(40)} but expected ${'b'.repeat(40)}`);

test('fetches sharing a common Git directory serialize across linked worktrees', async () => {
  let release!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const first = queueGitFetch('/repo/.git', async () => { calls++; started(); await gate; return 'first'; });
  await firstStarted;
  const second = queueGitFetch('/repo/.git', async () => { calls++; return 'second'; });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(calls, 2);
});

test('fetches for independent common Git directories do not serialize globally', async () => {
  let release!: () => void, bothStarted!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { bothStarted = resolve; });
  const run = (commonDir: string) => queueGitFetch(commonDir, async () => {
    if (++calls === 2) bothStarted();
    await gate;
  });
  const first = run('/repo-one/.git');
  const second = run('/repo-two/.git');
  await bothStarted;
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second]);
});

test('a definite remote-ref compare-and-swap failure retries and can succeed', async () => {
  let attempts = 0;
  const head = 'c'.repeat(40);
  const result = await queueGitFetch('/repo/.git', async () => {
    if (++attempts === 1) throw casFailure();
    return head;
  });
  assert.equal(result, head);
  assert.equal(attempts, 2);
  assert.equal(isFetchRefContention(casFailure()), true);
});

test('ref contention exhaustion stops after three total attempts', async () => {
  let attempts = 0;
  const finalFailure = casFailure();
  await assert.rejects(queueGitFetch('/repo/.git', async () => {
    if (++attempts < 3) throw casFailure();
    throw finalFailure;
  }), error => error === finalFailure);
  assert.equal(attempts, 3);
  assert.equal(isFetchRefContention(finalFailure), true);
});

test('unrelated fetch failures pass through without retry', async () => {
  let attempts = 0;
  const failure = new Error('fatal: authentication failed');
  assert.equal(isFetchRefContention(failure), false);
  await assert.rejects(queueGitFetch('/repo/.git', async () => {
    attempts++;
    throw failure;
  }), error => error === failure);
  assert.equal(attempts, 1);
});

test('command and raw hook fetch paths recover from definite ref contention', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { git } = await import('../core/git/index');
  const { gitRaw } = await import('../core/hooks/hooks');
  const dir = await mkdtemp(join(tmpdir(), 'queue-fetch-contention-'));
  const originalPath = process.env.PATH;
  const counter = join(dir, 'calls');
  t.after(async () => { process.env.PATH = originalPath; await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') { process.stdout.write(${JSON.stringify(dir)}); process.exit(0); }
if (args[0] === 'fetch') {
  const count = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(counter)}, String(count + 1));
  if (count === 0) { process.stderr.write("fatal: cannot lock ref 'refs/remotes/origin/main': is at ${'a'.repeat(40)} but expected ${'b'.repeat(40)}"); process.exit(1); }
  process.stdout.write('fetched'); process.exit(0);
}
process.exit(0);`, { mode: 0o755 });
  process.env.PATH = `${dir}:${originalPath}`;
  assert.equal(await git(dir, 'fetch', 'origin', 'main'), 'fetched');
  assert.equal(await readFile(counter, 'utf8'), '2');
  await rm(counter);
  const raw = await gitRaw(dir, ['fetch', 'origin', 'main']);
  assert.equal(raw.code, 0);
  assert.equal(raw.stdout.toString(), 'fetched');
  assert.equal(await readFile(counter, 'utf8'), '2');
});
