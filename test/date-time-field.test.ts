import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLocalDateTime, monthGrid } from '../shared/date-time';

test('the date field formats an instant in local time and lays a month out Monday first', () => {
  const instant = new Date(2026, 9, 22, 7, 5).toISOString();
  assert.equal(formatLocalDateTime(instant), 'Thu 22 Oct 2026, 07:05');
  assert.equal(formatLocalDateTime('not a date'), 'not a date');
  const october = monthGrid(2026, 9);
  assert.deepEqual(october[0], [null, null, null, 1, 2, 3, 4], '1 October 2026 is a Thursday');
  assert.equal(october.flat().filter(day => day !== null).length, 31);
  assert.ok(october.every(week => week.length === 7));
  assert.deepEqual(monthGrid(2027, 1).flat().filter(Boolean).length, 28, 'February 2027 has 28 days');
});
