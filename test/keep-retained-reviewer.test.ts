import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { keepRetainedReviewer } from '../core/review/review-continuation';

test('retained reviewer is kept only when no fresh or unavailable condition applies', () => {
  const cases: Array<[boolean, boolean, boolean, boolean]> = [
    [false, false, false, true], [true, false, false, false],
    [false, true, false, false], [false, false, true, false],
    [true, true, true, false],
  ];
  for (const [fresh, closed, unavailable, expected] of cases)
    assert.equal(keepRetainedReviewer(fresh, closed, unavailable), expected);
});
