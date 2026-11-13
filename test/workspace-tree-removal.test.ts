import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../core/workspaces/tree-removal';

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
