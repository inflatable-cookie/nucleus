import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishInterruptedRemoval, removalQuarantinePath, removeTree } from '../core/workspaces/tree-removal';

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
 * An interrupted detach stays recoverable (nucleus#1179 review 5890648389).
 *
 * The detach renames a checkout to a deterministic sibling before its
 * asynchronous walk. If the walk fails or the process dies, the original path is
 * gone and the sibling survives; a retry that only looks at the original path
 * would report the archive complete while that tree still holds the storage.
 */
test('an interrupted detach is finished by the next pass, and anything else at the name is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nucleus-quarantine-'));
  const checkout = join(root, 'checkout');
  const quarantine = removalQuarantinePath(checkout);
  mkdirSync(join(quarantine, 'node_modules'), { recursive: true });
  writeFileSync(join(quarantine, 'node_modules', 'file.js'), 'module.exports = 1;\n');
  assert.equal(existsSync(checkout), false, 'the detach left only the quarantine sibling behind');

  assert.equal(await finishInterruptedRemoval(checkout), true, 'the next pass finds and finishes the leftover');
  assert.equal(existsSync(quarantine), false, 'the leftover tree is gone');
  assert.equal(await finishInterruptedRemoval(checkout), false, 'with nothing left there, the pass does nothing');

  // Anything but a real directory is never followed or removed.
  writeFileSync(quarantine, 'not a directory');
  await assert.rejects(() => finishInterruptedRemoval(checkout), /is not the directory an interrupted removal detached/);
  assert.equal(existsSync(quarantine), true, 'the unexpected entry is left for a human');
  rmSync(quarantine, { force: true });
  mkdirSync(join(root, 'real'), { recursive: true });
  symlinkSync(join(root, 'real'), removalQuarantinePath(join(root, 'link')));
  await assert.rejects(() => finishInterruptedRemoval(join(root, 'link')), /is not the directory an interrupted removal detached/);
  assert.equal(existsSync(join(root, 'real')), true, 'a symlink target is untouched');
  rmSync(root, { recursive: true, force: true });
});
