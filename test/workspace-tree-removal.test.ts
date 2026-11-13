import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishInterruptedRemoval, recordRemovalDetach, removalDetachMarkerPath, removalQuarantinePath, removeTree } from '../core/workspaces/tree-removal';

/**
 * Removing a checkout must not hold the thread that serves reads (nucleus#1179).
 *
 * The 2026-11-13 09:55Z wedge was one persistence-executor thread sampled for the
 * whole window inside node's synchronous `rm` recursion (`lstat`, `unlink`,
 * `rmdir` builtins): a recursive `rmSync` of a large directory. Every board,
 * `task.next` and `queue.detail` read queued behind it. `removeTree` is the same
 * walk on libuv's pool, so the event loop keeps turning while the tree goes.
 */
test('removing a populated tree yields the thread instead of blocking it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-tree-removal-'));
  for (let directory = 0; directory < 40; directory++) {
    const path = join(root, `checkout-${directory}`, 'node_modules', 'fixture');
    mkdirSync(path, { recursive: true });
    for (let file = 0; file < 60; file++) writeFileSync(join(path, `file-${file}.js`), 'module.exports = 1;\n');
  }
  assert.ok(existsSync(join(root, 'checkout-0')), 'the fixture tree exists before removal');

  // A one-millisecond timer is the read this thread also serves: it can only fire
  // while the removal is not holding the loop.
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const startedAt = Date.now();
  await removeTree(root);
  const elapsedMs = Date.now() - startedAt;
  clearInterval(timer);

  assert.equal(existsSync(root), false, 'the tree is gone');
  assert.ok(ticks > 0, `the event loop kept turning during a ${elapsedMs} ms removal (ticks ${ticks}); a recursive rmSync would report zero`);
});

/**
 * An interrupted detach stays recoverable, and only under the authority that
 * detached it (nucleus#1179 reviews 5890648389 and 5891444157).
 *
 * The detach records what it is about to detach, renames the checkout to a
 * deterministic sibling, then walks it. A walk that fails or a process that dies
 * leaves the sibling with the original path gone; the next pass finds it by name,
 * but the name and the type are not authority: the record must name this task and
 * workspace, or nothing is deleted.
 */
test('an interrupted detach is finished by the next pass, and a tree that is not this task\'s detach is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const checkout = join(root, 'checkout');
  const quarantine = removalQuarantinePath(checkout);
  const detach = (record: { taskId: string; workspaceId: string }) => recordRemovalDetach(checkout, { ...record, head: null, at: new Date().toISOString() });
  const populate = () => {
    mkdirSync(join(quarantine, 'node_modules'), { recursive: true });
    writeFileSync(join(quarantine, 'node_modules', 'file.js'), 'module.exports = 1;\n');
  };
  const authority = { taskId: 'task-1', workspaceId: 'ws-1' };

  // No detach record: the name alone proves nothing, so nothing is removed.
  populate();
  await assert.rejects(() => finishInterruptedRemoval(checkout, authority), /has no detach record naming this task and workspace/);
  assert.equal(existsSync(quarantine), true, 'a tree with no detach record is left for a human');

  // A record for another task or workspace is equally no authority.
  detach({ taskId: 'task-1', workspaceId: 'other-workspace' });
  await assert.rejects(() => finishInterruptedRemoval(checkout, authority), /has no detach record naming this task and workspace/);
  assert.equal(existsSync(quarantine), true, 'another workspace\'s detach is not this pass\'s to delete');

  // This task's own detach is finished, and its record goes with it.
  detach(authority);
  assert.equal(await finishInterruptedRemoval(checkout, authority), true, 'the next pass finishes its own detach');
  assert.equal(existsSync(quarantine), false, 'the detached tree is gone');
  assert.equal(existsSync(removalDetachMarkerPath(checkout)), false, 'the detach record is gone with it');
  assert.equal(await finishInterruptedRemoval(checkout, authority), false, 'with nothing detached there, the pass does nothing');

  // Anything but a real directory is never followed or removed, even with a record.
  detach(authority);
  writeFileSync(quarantine, 'not a directory');
  await assert.rejects(() => finishInterruptedRemoval(checkout, authority), /is not a directory this Queue removal could have detached/);
  assert.equal(existsSync(quarantine), true, 'the unexpected entry is left for a human');
  rmSync(quarantine, { force: true });
  mkdirSync(join(root, 'real'), { recursive: true });
  symlinkSync(join(root, 'real'), removalQuarantinePath(join(root, 'link')));
  recordRemovalDetach(join(root, 'link'), { taskId: 'task-1', workspaceId: 'ws-1', head: null, at: new Date().toISOString() });
  await assert.rejects(() => finishInterruptedRemoval(join(root, 'link'), authority), /is not a directory this Queue removal could have detached/);
  assert.equal(existsSync(join(root, 'real')), true, 'a symlink target is untouched');

  // A record whose tree is already gone is cleaned up only when it is this pass's.
  recordRemovalDetach(join(root, 'settled'), { taskId: 'task-1', workspaceId: 'ws-1', head: null, at: new Date().toISOString() });
  assert.equal(await finishInterruptedRemoval(join(root, 'settled'), authority), false);
  assert.equal(existsSync(removalDetachMarkerPath(join(root, 'settled'))), false, 'a finished detach leaves no record');
  recordRemovalDetach(join(root, 'foreign'), { taskId: 'task-2', workspaceId: 'ws-9', head: null, at: new Date().toISOString() });
  assert.equal(await finishInterruptedRemoval(join(root, 'foreign'), authority), false);
  assert.equal(existsSync(removalDetachMarkerPath(join(root, 'foreign'))), true, 'another task\'s record is not deleted');
  rmSync(root, { recursive: true, force: true });
});
