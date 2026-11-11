import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, currentWorkerBranch } from '../core/git/index';

// 2026-11-02: ordinary review left worker checkouts detached at their own published branch head
// (effigy#528, project-c#233/#244, project-f#42, queue#566/#567/#569), and every branch check except
// verifyResume refused with "Worker must remain on queue-owned branch". All checks now reattach.
async function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ns-reattach-')));
  const origin = join(dir, 'origin.git'), work = join(dir, 'work');
  await git(dir, 'init', '--bare', origin);
  await git(dir, 'init', '-b', 'main', work);
  await git(work, 'config', 'user.email', 't@example.com');
  await git(work, 'config', 'user.name', 'T');
  writeFileSync(join(work, 'a'), 'a\n');
  await git(work, 'add', '.'); await git(work, 'commit', '-m', 'a');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', 'origin', 'main');
  await git(work, 'switch', '-c', 'ns-task');
  writeFileSync(join(work, 'b'), 'b\n');
  await git(work, 'add', '.'); await git(work, 'commit', '-m', 'b');
  await git(work, 'push', 'origin', 'ns-task');
  return { dir, work };
}
const task = { branch: 'ns-task', baseBranch: 'main' };

test('a clean checkout detached at the published branch head is reattached', async () => {
  const { dir, work } = await repo();
  try {
    await git(work, 'checkout', '--detach', 'HEAD');
    assert.equal(await git(work, 'branch', '--show-current'), '');
    assert.equal(await currentWorkerBranch(task, work), 'ns-task');
    assert.equal(await git(work, 'branch', '--show-current'), 'ns-task');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dirty or different-head detached checkout is left for the caller to refuse', async () => {
  const { dir, work } = await repo();
  try {
    await git(work, 'checkout', '--detach', 'HEAD~1');
    assert.equal(await currentWorkerBranch(task, work), '');
    await git(work, 'checkout', '--detach', 'ns-task');
    writeFileSync(join(work, 'c'), 'dirty\n');
    assert.equal(await currentWorkerBranch(task, work), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
