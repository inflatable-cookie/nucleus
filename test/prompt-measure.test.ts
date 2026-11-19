import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePrompt } from '../core/dispatch/prompt-text/measure';

test('prompt size records account for repeated and overlapping sections without retaining text', () => {
  const result = measurePrompt('brief rules brief!', [
    ['brief', 'brief'], ['overlap', 'brief rules'], ['missing', 'absent'],
  ]);
  assert.deepEqual(result, { total: 18, sections: { brief: 10, overlap: 6, other: 2 } });
  assert.equal(Object.values(result.sections).reduce((sum, value) => sum + value, 0), result.total);
  assert.doesNotMatch(JSON.stringify(result), /brief rules/);
});
