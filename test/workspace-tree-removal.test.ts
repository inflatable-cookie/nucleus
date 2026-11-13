import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachForRemoval, finishInterruptedRemoval, readRemovalDetach, removalDetachMarkerPath, removalQuarantinePath, removeTree } from '../core/workspaces/tree-removal';

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
 * An interrupted detach is finished only for the exact tree it recorded
 * (nucleus#1179 reviews 5891444157 and 5893989674).
 *
 * The detach records the tree's task, workspace, device, inode and canonical
 * parent and fsyncs the record, then renames. A later pass finishes the
 * quarantine only when the directory standing there is that recorded object; an
 * unrecorded sibling, a replacement with a different inode, a symlink or a marker
 * name that already exists is refused and left for a human.
 */
const authority = { taskId: 'task-1', workspaceId: 'ws-1' };
const populate = (path: string) => {
  mkdirSync(join(path, 'node_modules'), { recursive: true });
  writeFileSync(join(path, 'node_modules', 'file.js'), 'module.exports = 1;\n');
};

test('an unrecorded quarantine sibling is refused and left for a human', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const checkout = join(root, 'checkout');
  const quarantine = removalQuarantinePath(checkout);
  populate(quarantine);
  await assert.rejects(() => finishInterruptedRemoval(checkout, authority), /has no detach record naming this task and workspace/);
  assert.equal(existsSync(join(quarantine, 'node_modules', 'file.js')), true, 'the unrelated tree is untouched');
  rmSync(root, { recursive: true, force: true });
});

test('a recorded detach carries the tree identity and is finished only for that tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const checkout = join(root, 'checkout');
  const quarantine = removalQuarantinePath(checkout);
  populate(checkout);
  assert.equal(detachForRemoval(checkout, { ...authority, head: null }), quarantine);
  const record = readRemovalDetach(checkout)!;
  assert.equal(record.taskId, 'task-1');
  assert.equal(record.workspaceId, 'ws-1');
  assert.ok(record.inode > 0 && record.device >= 0, 'the record carries the tree filesystem identity');
  assert.equal(record.parent, root, 'and its canonical parent');

  // A replacement at the quarantine name has a different inode: not this detach.
  rmSync(quarantine, { recursive: true, force: true });
  populate(quarantine);
  await assert.rejects(() => finishInterruptedRemoval(checkout, authority), /is not the directory this task detached/);
  assert.equal(existsSync(quarantine), true, 'a replacement tree is left for a human');
  rmSync(quarantine, { recursive: true, force: true });

  // Finish a freshly recorded detach: the tree and its record both go.
  rmSync(removalDetachMarkerPath(checkout), { force: true });
  populate(checkout);
  detachForRemoval(checkout, { ...authority, head: null });
  assert.equal(await finishInterruptedRemoval(checkout, authority), true, 'the recorded tree is finished');
  assert.equal(existsSync(quarantine), false);
  assert.equal(existsSync(removalDetachMarkerPath(checkout)), false, 'the record goes with the tree');
  assert.equal(await finishInterruptedRemoval(checkout, authority), false, 'nothing detached there now');
  rmSync(root, { recursive: true, force: true });
});

test('the detach record is created exclusively and never follows a symlink', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const checkout = join(root, 'checkout');
  populate(checkout);
  mkdirSync(join(root, 'target'), { recursive: true });
  writeFileSync(join(root, 'target', 'keep.txt'), 'keep');
  symlinkSync(join(root, 'target', 'keep.txt'), removalDetachMarkerPath(checkout));
  assert.throws(() => detachForRemoval(checkout, { ...authority, head: null }), /EEXIST|file already exists/);
  assert.equal(readFileSync(join(root, 'target', 'keep.txt'), 'utf8'), 'keep', 'the symlink target is untouched');
  assert.equal(existsSync(checkout), true, 'and the tree was not renamed');
  assert.equal(existsSync(removalQuarantinePath(checkout)), false);
  rmSync(root, { recursive: true, force: true });
});

test("a record whose tree is already gone is cleaned up only when it is this pass's", async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const settled = join(root, 'settled');
  populate(settled);
  detachForRemoval(settled, { ...authority, head: null });
  rmSync(removalQuarantinePath(settled), { recursive: true, force: true });
  assert.equal(await finishInterruptedRemoval(settled, authority), false);
  assert.equal(existsSync(removalDetachMarkerPath(settled)), false, 'a finished detach leaves no record');

  const foreign = join(root, 'foreign');
  populate(foreign);
  detachForRemoval(foreign, { taskId: 'task-2', workspaceId: 'ws-9', head: null });
  rmSync(removalQuarantinePath(foreign), { recursive: true, force: true });
  assert.equal(await finishInterruptedRemoval(foreign, authority), false);
  assert.equal(existsSync(removalDetachMarkerPath(foreign)), true, "another task's record is not deleted");
  rmSync(root, { recursive: true, force: true });
});
