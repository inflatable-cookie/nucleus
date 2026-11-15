import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskIdFromLaneKey, TASK_LANE_PREFIX, RUNTIME_RETIREMENT_LANE_PREFIX } from '../core/host/lane-host';

test('task and runtime-retirement lane keys name their task id; other keys do not', () => {
  assert.equal(taskIdFromLaneKey(`${TASK_LANE_PREFIX}abc`), 'abc');
  assert.equal(taskIdFromLaneKey(`${RUNTIME_RETIREMENT_LANE_PREFIX}abc`), 'abc');
  assert.equal(taskIdFromLaneKey(`${TASK_LANE_PREFIX}abc:extra`), 'abc:extra');
  assert.equal(taskIdFromLaneKey(TASK_LANE_PREFIX), undefined);
  assert.equal(taskIdFromLaneKey(RUNTIME_RETIREMENT_LANE_PREFIX), undefined);
  assert.equal(taskIdFromLaneKey('tasking:abc'), undefined);
  assert.equal(taskIdFromLaneKey('operation:abc'), undefined);
  assert.equal(taskIdFromLaneKey(''), undefined);
});
