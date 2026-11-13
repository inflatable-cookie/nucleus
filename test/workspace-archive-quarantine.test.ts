import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';
import { recordRemovalDetach, removalDetachMarkerPath, removalQuarantinePath } from '../core/workspaces/tree-removal';

/**
 * A recovered removal finishes only a detach it recorded durably (nucleus#1179
 * acceptance 2b, planner ruling 2026-11-13).
 *
 * The archive detaches an orphaned checkout by renaming it and then walks it
 * asynchronously. When a walk fails or the process dies, the sibling survives
 * with the recorded path gone. The next archive pass must finish that removal —
 * but the quarantine name and type are not authority: only a detach record naming
 * this task and workspace is, and an unrecorded sibling is left alone so the
 * archive fails closed instead of deleting someone else's directory.
 */
const detach = (fixture: Awaited<ReturnType<typeof terminalArchiveFixture>>) => {
  renameSync(fixture.directory, removalQuarantinePath(fixture.directory));
};

test('an archive finishes an interrupted detach that recorded this task and workspace', async t => {
  const fixture = await terminalArchiveFixture(t);
  const task = fixture.task();
  detach(fixture);
  recordRemovalDetach(fixture.directory, { taskId: task.id, workspaceId: 'ws', head: fixture.head, at: new Date().toISOString() });
  assert.equal(existsSync(fixture.directory), false, 'the checkout is detached under the quarantine name');

  await fixture.retry();

  assert.equal(existsSync(removalQuarantinePath(fixture.directory)), false, 'the interrupted detach was finished');
  assert.equal(existsSync(removalDetachMarkerPath(fixture.directory)), false, 'and its detach record went with it');
});

test('an archive leaves an unrecorded quarantine sibling alone and fails closed', async t => {
  const fixture = await terminalArchiveFixture(t);
  detach(fixture);
  assert.equal(existsSync(removalQuarantinePath(fixture.directory)), true);

  await assert.rejects(() => fixture.retry(), /has no detach record naming this task and workspace/);

  assert.equal(existsSync(removalQuarantinePath(fixture.directory)), true, 'a directory this pass did not detach is never removed');
  assert.equal(existsSync(removalDetachMarkerPath(fixture.directory)), false, 'and no record is invented for it');
});
