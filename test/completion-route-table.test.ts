import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Completion, Run } from '../shared/contracts';
import { completionRoute } from '../core/intake/callback-intake';

test('completion routes checkpoints and run roles', () => {
  const cases: Array<[Completion['status'], Run | null, string]> = [
    ['progress_checkpoint', null, 'checkpoint'],
    ['review_in_progress', {role: 'reviewer'} as Run, 'review_progress'],
    ['ready_to_merge', {role: 'reviewer'} as Run, 'reviewer'],
    ['blocked', {role: 'revision'} as Run, 'run'],
    ['ready_for_review', null, 'worker'],
  ];
  for (const [status, run, expected] of cases) assert.equal(completionRoute(status, run), expected);
});
