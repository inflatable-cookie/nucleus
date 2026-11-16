import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostProcessFact } from '../core/host/types';
import type { CwdState } from '../core/workspaces/worktree-validation';
import { dropExitedProcesses, inspectedProcessGone } from '../core/machine/host-process-listing';

test('only a read that proves the process exited drops it from the table', () => {
  assert.equal(inspectedProcessGone({ state: 'gone' }, { state: 'gone' }), true);
  assert.equal(inspectedProcessGone({ state: 'gone' }, { state: 'read', path: '/work' }), true);
  assert.equal(inspectedProcessGone({ state: 'read', line: 'bash' }, { state: 'gone' }), true);
  assert.equal(inspectedProcessGone({ state: 'empty' }, { state: 'gone' }), true,
    'a zombie that fully exited between the listing and its inspection is gone');
  assert.equal(inspectedProcessGone({ state: 'unreadable' }, { state: 'unreadable' }), false,
    'an unreadable inspection stays unknown, never proof of absence');
  assert.equal(inspectedProcessGone({ state: 'empty' }, { state: 'read', path: '/work' }), false,
    'a zombie or kernel thread with no argv but a readable cwd stays in the table for the state filter');
  assert.equal(inspectedProcessGone({ state: 'read', line: 'bash' }, { state: 'read', path: '/work' }), false);
  assert.equal(inspectedProcessGone({ state: 'empty' }, { state: 'unreadable' }), false);
});

test('darwin rows whose lsof pass proves them gone leave the table', () => {
  const fact = (pid: number): HostProcessFact =>
    ({ pid, ppid: 1, state: 'S', pgid: 1, uid: 501, startIdentity: `${pid}@fixture`, command: 'worker', cwd: null });
  // A task child that exited between the ps listing and the lsof read leaves
  // the table, so it cannot block the proof with an unreadable cwd.
  const exitedChild = fact(8);
  const cwds = new Map<number, CwdState>([[7, { state: 'read', path: '/work/task' }], [8, { state: 'gone' }]]);
  assert.deepEqual(dropExitedProcesses([fact(7), exitedChild], cwds).map(entry => entry.pid), [7]);
  assert.equal(dropExitedProcesses([fact(7), exitedChild], null).length, 2,
    'an unusable lsof pass keeps every row unknown instead of proving absence');
});
