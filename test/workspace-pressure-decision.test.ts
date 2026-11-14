import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideWorkspacePressureWait } from '../core/dispatch/dispatch-decisions';

test('workspace pressure admission decisions', () => {
  const task = { workspaceId: null, queuePriority: 0 };
  const host = { load: 4.25, cpus: 4 };
  const wait = 'Workspace creation paced under host pressure (4.3 load / 4 CPUs); waiting for the admission gap to pass';
  const cases = [
    [task, host, 101, 100, wait],
    [{ ...task, workspaceId: 'existing' }, host, 101, 100, ''],
    [{ ...task, queuePriority: 1 }, host, 101, 100, ''],
    [task, undefined, 101, 100, ''],
    [task, { load: 4, cpus: 4 }, 101, 100, ''],
    [task, host, 100, 100, ''],
  ] as const;
  for (const [candidate, load, next, now, expected] of cases) {
    assert.equal(decideWorkspacePressureWait(candidate, load, next, now), expected);
  }
});
