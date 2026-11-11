// Runs in its own process so the time zone applies before any Date is made.
process.env.TZ = 'Europe/London';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDay, withMinute } from '../shared/date-time';

test('choosing a minute keeps the repeated DST hour the picker is showing', () => {
  // 25 Oct 2026: London clocks go back at 02:00 BST, so 01:00–01:59 happens twice.
  const second = new Date('2026-10-25T01:30:00Z'); // the second 01:30 (GMT)
  assert.equal(second.getHours(), 1);
  assert.equal(withMinute(second, 45).toISOString(), '2026-10-25T01:45:00.000Z');
  const first = new Date('2026-10-25T00:30:00Z'); // the first 01:30 (BST)
  assert.equal(withMinute(first, 45).toISOString(), '2026-10-25T00:45:00.000Z');
  // Seconds and milliseconds are dropped.
  assert.equal(withMinute(new Date('2026-10-20T09:07:31.500Z'), 15).toISOString(), '2026-10-20T09:15:00.000Z');
});

test('re-selecting the day shown keeps the repeated DST hour; another day keeps the wall time', () => {
  const second = new Date('2026-10-25T01:30:00Z'); // the second 01:30 (GMT)
  assert.equal(withDay(second, 2026, 9, 25).toISOString(), '2026-10-25T01:30:00.000Z');
  const next = withDay(second, 2026, 9, 26);
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [26, 1, 30]);
});
