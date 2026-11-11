import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absentWorkerStep } from '../core/recovery/creation-recovery';

test('absent worker decisions and map bug 15: the budget uses the supplied recent window', () => {
  const base = { launchRetry: false, retryDue: false, matches: 0, graceElapsed: true };
  for (const [patch, expected] of [[{ launchRetry: true, retryDue: false }, 'wait'], [{ launchRetry: true, retryDue: true }, 'launch_retry'], [{ graceElapsed: false }, 'wait'], [{}, 'read_budget']] as const)
    assert.equal(absentWorkerStep({ ...base, ...patch }), expected);
  const cases = [
    [false, 0, 'replace'],
    [false, 1, 'replace'],
    [false, 2, 'ambiguous'],
    [true, 0, 'escalate'],
    [true, 2, 'escalate'],
  ] as const;
  for (const [spent, matches, expected] of cases)
    assert.equal(absentWorkerStep({ ...base, replacementSpent: spent, matches }), expected);
});
