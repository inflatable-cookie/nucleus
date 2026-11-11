import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { holdPatch } from '../core/merge/merge-hold';
import { terminalArchiveFixture } from './support/terminal-archive-fixture';

/**
 * An owner stop pauses work. When the task finishes anyway (the stop's dispatch
 * hold does not block a merge), the hold has nothing left to stop, and it used to
 * refuse the archive for good: #456 and Effigy #377 on 2026-10-26 (Tom: "It keeps
 * happening!"). The archive pass now releases it, recorded, and archives. A
 * deliberate dispatch hold still preserves the finished task's workspace.
 */
async function fixture(t: Parameters<typeof terminalArchiveFixture>[0], reason: string) {
  const f = await terminalArchiveFixture(t);
  f.remote.participant.status = 'closed';
  f.updateResolution({ workspaceArchiveRetries: [], cleanupReason: '' });
  f.store.update(f.task().id, holdPatch(f.task(), 'dispatch', 'task-owner', reason));
  const pass = async () => { f.engine.enqueueCleanup(f.task().id); await f.engine.drainCleanup(); };
  return { ...f, pass };
}

test('a finished task\'s owner-stop hold is released and the workspace archives', async t => {
  const f = await fixture(t, 'Owner stop: Paused for another project\'s window');
  assert.equal(f.task().held, true);
  await f.pass();
  assert.equal(f.task().held, false);
  assert.deepEqual(f.task().holds, {});
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, ['ws']);
  assert.equal(existsSync(f.directory), false);
  const released = f.store.events(f.task().id).find(event => event.kind === 'hold_released');
  assert.match(released!.detail, /the task finished, so its owner stop \(Owner stop: Paused/);
});

test('a deliberate dispatch hold still preserves a finished task\'s workspace', async t => {
  const f = await fixture(t, 'Preserve checkout');
  await f.pass();
  assert.equal(f.task().held, true);
  assert.deepEqual(f.task().resolution.archivedWorkspaceIds, []);
  assert.equal(existsSync(f.directory), true);
  assert.match(f.task().resolution.cleanupReason, /held by task identity, ownership or a hold/);
});
