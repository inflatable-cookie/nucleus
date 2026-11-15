import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskControlInputSchema, taskControlRequestSchema } from '../shared/schema/task-control';

test('an unknown key on a control write is refused, never silently stripped', () => {
  const result = taskControlRequestSchema.safeParse({ taskId: 'task-1', version: 1, action: 'note', message: 'hello', unknownField: true });
  assert.equal(result.success, false);
});

test('the persisted control schema refuses unknown keys too', () => {
  const result = taskControlInputSchema.safeParse({ taskId: 'task-1', version: 1, action: 'note', message: 'hello', unknownField: true });
  assert.equal(result.success, false);
});

test('the reference spelling is still accepted and read as the task ID', () => {
  const result = taskControlRequestSchema.safeParse({ reference: 'nucleus#1', version: 1, action: 'note', message: 'hello' });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.taskId, 'nucleus#1');
    assert.equal('reference' in result.data, false);
  }
});

test('a control named with both taskId and reference is refused', () => {
  assert.throws(() => taskControlRequestSchema.parse({ taskId: 'task-1', reference: 'nucleus#1', version: 1, action: 'note', message: 'hello' }), /exactly one of taskId or reference/);
});

test('a complete restart still parses with its required reason', () => {
  assert.equal(taskControlInputSchema.safeParse({ taskId: 'task-1', version: 2, action: 'restart', reason: 'owner restart' }).success, true);
  assert.equal(taskControlInputSchema.safeParse({ taskId: 'task-1', version: 2, action: 'restart' }).success, false);
});
