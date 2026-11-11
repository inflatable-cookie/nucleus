import type { TestContext } from 'node:test';
import { test, weighted } from './support/sharded-test';
/**
 * Shard inventory (measured 2026-11-01, assertion-preserving split only — every
 * scenario below is the same code, setup precondition and cleanup obligation as
 * the former `workspace-archive-discard.test.ts`):
 *
 *  - the 16 scenarios registered here are handed to 4 physical shards by
 *    `test/support/sharded-test.ts`; the registration order is replayed
 *    identically in each shard and each scenario registers in exactly one, so
 *    no scenario is skipped, filtered or duplicated;
 *  - the measured per-scenario cost of the whole file was 85.7 s (worst case
 *    24.2 s) against the parallel lane's 120 s per-file budget, and the same
 *    file times out under host load; `weighted` only steers the assignment so
 *    the heavy scenarios do not stack on one shard. It never changes a case.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { git } from '../core/git/index';
import { repoCommonDir } from '../core/workspaces/workspace-allocation';
import { normalizeOwnedDirectoryPermissions, workspaceDiscardKey } from '../core/workspaces/orphan-worktree';
import { runSchema, taskControlInputSchema } from '../shared/contracts';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';

/**
 * Papercut c7643943 (Tom, 2026-10-22, after the content-loss disclosure:
 * "Retire the stuck workspaces"). A done task whose worktree record Git lost
 * retried its archive hourly forever. `retry_effect` with `discard: true`
 * records the owner's durable decision to lose the unproven contents; the
 * archive then waives only its content proofs. A worktree Git no longer knows
 * is deleted only after the orphan is proved positively at the exact owned
 * path, and every identity, custody and fence check stays.
 */

const RULING = 'Tom 2026-10-22: "Retire the stuck workspaces" (contents may be lost)';

async function fixture(t: TestContext) {
  const f = await terminalArchiveFixture(t);
  const commonDir = await repoCommonDir(f.primary);
  const adminDir = join(commonDir, 'worktrees', basename(f.directory));
  const orphan = async () => {
    await writeFile(join(f.directory, 'unsaved.txt'), 'never committed\n');
    await rm(adminDir, { recursive: true, force: true });
  };
  const discard = (extra: Record<string, unknown> = {}) => f.engine.performTaskControl(taskControlInputSchema.parse({
    action: 'retry_effect', taskId: f.task().id, version: f.task().version, effect: 'workspace_archive.ws',
    caller: 'operator (board)', reason: RULING, discard: true, ...extra }));
  const events = (kind: string) => f.store.eventsAll(f.task().id).filter(event => event.kind === kind);
  return { ...f, commonDir, adminDir, orphan, discard, events };
}

weighted(12)('an orphaned worktree is retired only with an owner discard, which records the decision and removes nothing else', async t => {
  const f = await fixture(t);
  await f.orphan();
  await assert.rejects(f.retry(), /gitfile does not point to a valid repository|not a git repository/i, 'without discard the content proofs still refuse');
  assert.equal(existsSync(f.directory), true);
  assert.equal(f.remote.archives.length, 0);
  const archived = await f.discard();
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(existsSync(f.directory), false, 'exactly the owned directory is deleted');
  assert.equal(f.remote.archives.length, 1);
  const record = f.store.getMeta<Record<string, unknown>>(workspaceDiscardKey(f.task().id, 'ws'))!;
  assert.deepEqual({ ...record, at: undefined }, { workspaceId: 'ws', directory: f.directory, caller: 'operator (board)', authority: 'operator', note: null, reason: RULING, at: undefined });
  assert.equal(f.events('workspace_discard_authorized').length, 1);
  const discarded = JSON.parse(f.events('workspace_contents_discarded')[0]!.detail);
  assert.equal(discarded.detail, 'Unproven contents discarded: no clean or published source is claimed');
  // The main repository, its common dir and the task branch are untouched.
  assert.equal(await git(f.primary, 'status', '--porcelain'), '');
  assert.match(await git(f.primary, 'branch', '--list', f.task().branch), new RegExp(f.task().branch));
  assert.equal(existsSync(f.commonDir), true);
});

weighted(3)('a discard needs owner authority, and a refusal records nothing and deletes nothing', async t => {
  const f = await fixture(t);
  await f.orphan();
  await assert.rejects(f.discard({ caller: 'someone-else' }), /someone-else has none/);
  await assert.rejects(f.discard({ caller: 'relay', relayed: true }), /requires the recorded operator authorization note|authorization note/);
  assert.equal(f.store.getMeta(workspaceDiscardKey(f.task().id, 'ws')), undefined);
  assert.equal(f.events('workspace_discard_authorized').length, 0);
  assert.equal(existsSync(f.directory), true);
  assert.equal(f.remote.archives.length, 0);
  const relayed = await f.discard({ caller: 'queue-root', relayed: true, note: RULING });
  assert.deepEqual(relayed.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(f.store.getMeta<{ authority: string }>(workspaceDiscardKey(f.task().id, 'ws'))!.authority, 'relayed_note');
});

weighted(9)('a foreign .git record, a symlinked directory or an unreadable worktree record never reaches the delete', async t => {
  for (const shape of ['foreign', 'symlink', 'unreadable'] as const) {
    const f = await fixture(t);
    await f.orphan();
    let restore = async () => {};
    if (shape === 'foreign') await writeFile(join(f.directory, '.git'), `gitdir: ${join(f.root, 'elsewhere', '.git', 'worktrees', basename(f.directory))}\n`);
    if (shape === 'symlink') {
      const moved = join(f.root, 'moved');
      await rename(f.directory, moved);
      await symlink(moved, f.directory);
    }
    if (shape === 'unreadable') {
      const worktrees = join(f.commonDir, 'worktrees');
      await mkdir(worktrees, { recursive: true });
      await chmod(worktrees, 0o000);
      restore = async () => { await chmod(worktrees, 0o755); };
    }
    try {
      const reason = { foreign: /its \.git does not name this repository's worktree record for it/, symlink: /the directory is not a real directory/,
        unreadable: /its worktree record could not be read: EACCES/ }[shape];
      await assert.rejects(f.discard(), reason, shape);
    } finally { await restore(); }
    assert.equal(existsSync(f.directory), true, `${shape}: nothing was deleted`);
    if (shape === 'symlink') assert.equal(existsSync(join(f.root, 'moved', 'unsaved.txt')), true, 'the link target is untouched');
    assert.deepEqual(f.task().resolution.archivedWorkspaceIds, [], shape);
  }
});

weighted(4)('every fence still holds under a discard: a live unreleased run keeps the workspace', async t => {
  const f = await fixture(t);
  await f.orphan();
  f.store.putRun(runSchema.parse({ id: 'live-run', taskId: f.task().id, role: 'recovery', generation: 1, head: f.head, base: f.head,
    agentId: 'coordinator', workspaceId: 'ws', profile: { id: 'p', name: 'p', provider: 'test', model: 'test/p', notes: '', available: true, problem: '', supportedThinking: [] },
    status: 'running', createdAt: new Date().toISOString(), lastObservedAt: null, active: true, idleSince: null, completion: null, released: false }));
  // The run's agent is genuinely live, so no settlement can release it.
  f.remote.participant = { ...f.remote.participant, status: 'running', active: true };
  await assert.rejects(f.discard());
  assert.equal(existsSync(f.directory), true);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(f.store.run('live-run')?.released, false);
});

weighted(3)('a worktree Git still knows keeps its identity checks under a discard and is removed with its unsaved contents', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'unsaved.txt'), 'never committed\n');
  await assert.rejects(f.retry(), /uncommitted/);
  const archived = await f.discard();
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(existsSync(f.directory), false);
  assert.equal(await git(f.primary, 'worktree', 'list', '--porcelain').then(out => out.includes(f.directory)), false);
});

/** Act inside the n-th orphan proof (the 4th is the one at the delete boundary). */
function duringProof(f: Awaited<ReturnType<typeof fixture>>, call: number, act: { before?: () => Promise<void>; after?: () => Promise<void> }) {
  const original = f.adapter.classifyOrphan;
  let calls = 0;
  f.adapter.classifyOrphan = async input => {
    calls++;
    if (calls === call) await act.before?.();
    const result = await original(input);
    if (calls === call) await act.after?.();
    return result;
  };
  return () => calls;
}

weighted(25)('Sol #608 P1: an ancestor redirect of the owned root refuses, statically or introduced at the delete boundary', async t => {
  const redirect = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const ownedRoot = join(f.directory, '..');
    const moved = join(f.root, 'moved-root');
    await rename(ownedRoot, moved);
    await symlink(moved, ownedRoot);
    return join(moved, basename(f.directory));
  };
  for (const when of ['before-archive', 'during-final-proof', 'after-final-proof'] as const) {
    for (const orphaned of [true, false]) {
      const f = await fixture(t);
      if (orphaned) await f.orphan(); else await writeFile(join(f.directory, 'unsaved.txt'), 'never committed\n');
      let target = f.directory;
      if (when === 'before-archive') target = await redirect(f);
      // The orphan path re-proves at the delete (4th proof); a Git-known worktree's last proof is the 3rd,
      // after which only the synchronous canonical-path check stands before removal.
      else duringProof(f, orphaned ? 4 : 3, when === 'during-final-proof' ? { before: async () => { target = await redirect(f); } } : { after: async () => { target = await redirect(f); } });
      await f.discard().catch(() => {});
      assert.equal(existsSync(join(target, 'unsaved.txt')), true, `${when}/${orphaned ? 'orphan' : 'git-known'}: nothing was deleted through the redirect`);
      assert.deepEqual(f.task().resolution.archivedWorkspaceIds, [], `${when}/${orphaned ? 'orphan' : 'git-known'}`);
    }
  }
});

weighted(3)('Sol #608 P1: a fence that lands during the final orphan proof stops the delete', async t => {
  const f = await fixture(t);
  await f.orphan();
  const calls = duringProof(f, 4, { after: async () => { f.store.setMeta('paused', true); } });
  await f.discard().catch(() => {});
  assert.ok(calls() >= 4, 'the final proof ran');
  assert.equal(existsSync(join(f.directory, 'unsaved.txt')), true, 'paused during the proof: nothing deleted');
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
});

weighted(14)('Sol #608 P2: a .git swapped for a symlink during the final proof is never read through', async t => {
  const f = await fixture(t);
  await f.orphan();
  duringProof(f, 4, { before: async () => {
    const decoy = join(f.root, 'decoy-git');
    await writeFile(decoy, `gitdir: ${f.adminDir}\n`);
    await rm(join(f.directory, '.git'));
    await symlink(decoy, join(f.directory, '.git'));
  } });
  await f.discard().catch(() => {});
  assert.equal(existsSync(join(f.directory, 'unsaved.txt')), true);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
});

weighted(8)('Sol #608 P2: a report-only workspace keeps its identity proofs but not its clean-state proof under a discard', async t => {
  for (const orphaned of [false, true]) {
    const base = await terminalArchiveFixture(t, { unfinished: true });
    base.adapter.findAnyOpenBranchPr = async () => [];
    // A pause holds the first archive (verbs still apply), so the workspace is still there to dirty.
    base.store.setMeta('paused', true);
    await base.engine.performTaskControl({ action: 'complete', taskId: base.task().id, version: base.task().version, caller: 'operator',
      reason: 'Report accepted; source stays on its branch' });
    await base.engine.drainCleanup();
    base.store.setMeta('paused', false);
    assert.equal(base.task().reportAcceptance?.kind, 'owner_completed', 'a report-only done task');
    assert.deepEqual(base.task().resolution.archivedWorkspaceIds, [], 'not yet archived, so the discard path is exercised');
    await writeFile(join(base.directory, 'unsaved.txt'), 'never committed\n');
    if (orphaned) await rm(join(await repoCommonDir(base.primary), 'worktrees', basename(base.directory)), { recursive: true, force: true });
    // One ordinary cleanup pass fails on the unprovable contents and records the owed archive.
    base.engine.enqueueCleanup(base.task().id);
    await base.engine.drainCleanup();
    assert.equal(base.task().resolution.workspaceArchiveRetries.length, 1, 'the ordinary archive failed and is owed');
    await assert.rejects(base.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: base.task().id, version: base.task().version,
      effect: 'workspace_archive.ws', caller: 'operator (board)', reason: 'Retry without discard' })));
    const archived = await base.engine.performTaskControl(taskControlInputSchema.parse({ action: 'retry_effect', taskId: base.task().id, version: base.task().version,
      effect: 'workspace_archive.ws', caller: 'operator (board)', reason: RULING, discard: true }));
    assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws'], orphaned ? 'orphaned report-only' : 'dirty report-only');
    assert.equal(existsSync(base.directory), false);
  }
});

/** Sealed, Effigy-style fixture objects: read-only directories with files in them. */
async function sealedFixture(directory: string) {
  const objects = join(directory, 'crates', 'fixture', 'home', '.effigy', 'state', 'objects', 'abc', 'inputs');
  await mkdir(join(objects, 'declarations'), { recursive: true });
  await writeFile(join(objects, 'manifest.toml'), 'sealed\n');
  await writeFile(join(objects, 'declarations', 'one.json'), '{}\n');
  for (const dir of [join(objects, 'declarations'), objects, join(objects, '..')]) await chmod(dir, 0o500);
  return objects;
}

weighted(12)('read-only directories inside the owned root are opened for removal only under a discard, on both removal paths', async t => {
  for (const orphaned of [true, false]) {
    const f = await fixture(t);
    await writeFile(join(f.directory, 'unsaved.txt'), 'never committed\n');
    const sealed = await sealedFixture(f.directory);
    if (orphaned) await rm(f.adminDir, { recursive: true, force: true });
    await assert.rejects(f.retry());
    assert.equal((await stat(sealed)).mode & 0o777, 0o500, 'without a discard no mode is changed');
    const archived = await f.discard();
    assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws'], orphaned ? 'orphan path' : 'git-known path');
    assert.equal(existsSync(f.directory), false, 'the sealed objects went with the workspace');
  }
});

weighted(12)('the permission walk never follows a link: a directory outside the root keeps its mode and contents', async t => {
  const f = await fixture(t);
  await f.orphan();
  const outside = join(f.root, 'outside-sealed');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'outside\n');
  await chmod(outside, 0o500);
  await symlink(outside, join(f.directory, 'link-to-outside'));
  await sealedFixture(f.directory);
  try {
    const archived = await f.discard();
    assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
    assert.equal((await stat(outside)).mode & 0o777, 0o500, 'the link target was not chmodded');
    assert.equal(existsSync(join(outside, 'keep.txt')), true, 'nothing outside the root was removed');
  } finally { await chmod(outside, 0o755); }
});

weighted(2)('a removal its own discard left partial continues only under the recorded archive intent', async t => {
  const f = await fixture(t);
  await f.orphan();
  await rm(join(f.directory, '.git')); // the earlier attempt already removed the marker
  await assert.rejects(f.discard(), /could not be opened|no such file|ENOENT/i, 'without its archive intent a missing .git is not inferred');
  assert.equal(existsSync(join(f.directory, 'unsaved.txt')), true);
  f.updateResolution({ archiveIntentWorkspaceId: 'ws', archiveIntentHead: f.head });
  f.remote.catalogued = false; // the native archive of the earlier attempt landed
  const archived = await f.discard();
  assert.deepEqual(archived.resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(existsSync(f.directory), false);
});

weighted(1)('a permission walk that fails part-way says how far it got and that removal did not start', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-perm-walk-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'a', 'unreadable', 'deep'), { recursive: true });
  await chmod(join(root, 'a'), 0o500);
  await chmod(join(root, 'a', 'unreadable'), 0o300); // no read: it cannot be listed
  try {
    assert.throws(() => normalizeOwnedDirectoryPermissions(root),
      /Directory permission normalization stopped after normalizing 1 directory; removal was not started: .*Permission denied/);
    assert.equal((await stat(join(root, 'a'))).mode & 0o777, 0o700, 'the earlier change is real and reported, not hidden');
  } finally { await chmod(join(root, 'a', 'unreadable'), 0o700); }
});

weighted(1)('Sol #610 P1: a walk that lands anywhere but the owned root inode, through a swapped root or ancestor, changes nothing', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ns-perm-swap-')));
  t.after(async () => { await chmod(join(base, 'outside', 'sealed'), 0o755).catch(() => {}); await rm(base, { recursive: true, force: true }); });
  const owned = join(base, 'owned'), outside = join(base, 'outside');
  await mkdir(join(owned, 'sealed'), { recursive: true });
  await mkdir(join(outside, 'sealed'), { recursive: true });
  await chmod(join(outside, 'sealed'), 0o500);
  const ownedIdentity = await stat(owned);
  const identity = { dev: ownedIdentity.dev, ino: ownedIdentity.ino };
  // The root path now resolves elsewhere (a swap that a later restore would hide).
  const swapped = join(base, 'swapped-root');
  await symlink(outside, swapped);
  assert.throws(() => normalizeOwnedDirectoryPermissions(swapped, identity), /changed identity before the walk/);
  assert.equal((await stat(join(outside, 'sealed'))).mode & 0o777, 0o500, 'nothing outside the owned root inode was changed');
  // An ancestor swapped for a link: the walk starts at the wrong inode and refuses.
  const parent = join(base, 'parent');
  await mkdir(parent);
  await symlink(outside, join(parent, 'via-link'));
  assert.throws(() => normalizeOwnedDirectoryPermissions(join(parent, 'via-link'), identity));
  assert.equal((await stat(join(outside, 'sealed'))).mode & 0o777, 0o500);
  // At its own inode the walk proceeds.
  await chmod(join(owned, 'sealed'), 0o500);
  assert.equal(normalizeOwnedDirectoryPermissions(owned, identity), 1);
  assert.equal((await stat(join(owned, 'sealed'))).mode & 0o777, 0o700);
});

weighted(1)('Sol #610 P1: the helper changes only a directory it opened no-follow, never a file or link put in an entry\'s place', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ns-perm-helper-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outsideFile = join(base, 'outside-file');
  await writeFile(outsideFile, 'outside\n');
  await chmod(outsideFile, 0o400);
  const dir = join(base, 'dir');
  await mkdir(dir);
  // Entries as `find -execdir` passes them: a hard link to an outside file and a symlink, where directories were.
  await link(outsideFile, join(dir, 'was-a-directory'));
  await symlink(base, join(dir, 'was-also-a-directory'));
  await mkdir(join(dir, 'real'), { mode: 0o500 });
  const helper = join(process.cwd(), 'core', 'workspaces', 'normalize-directory-helper.mjs');
  const run = spawnSync(process.execPath, [helper, './was-a-directory', './was-also-a-directory', './real'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  const lines = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.ok ?? `fail:${line.fail}`), ['fail:./was-a-directory', 'fail:./was-also-a-directory', './real']);
  assert.equal((await stat(outsideFile)).mode & 0o777, 0o400, 'the hard-linked outside file keeps its mode');
  assert.equal((await stat(join(dir, 'real'))).mode & 0o777, 0o700);
});

weighted(1)('Sol #610 P2/P3: a failed change stops the walk and removal, and progress counts are newline-safe', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ns-perm-fail-')));
  const locked = join(root, 'locked');
  t.after(async () => { spawnSync('/usr/bin/chflags', ['nouchg', locked]); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'one\nextra'), { mode: 0o500 });
  await mkdir(locked, { mode: 0o500 });
  assert.equal(spawnSync('/usr/bin/chflags', ['uchg', locked]).status, 0);
  assert.throws(() => normalizeOwnedDirectoryPermissions(root),
    /Directory permission normalization stopped after normalizing 1 directory; removal was not started: locked: EPERM/);
  assert.equal((await stat(locked)).mode & 0o777, 0o500, 'the immutable directory is reported, not bypassed');
});
