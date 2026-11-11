import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../service/transport/server';

test('bridge presence cancels the grace and an unknown or active host prevents drain', async () => {
  let now = 0, due = false, stopped = 0;
  const originalNow = Date.now;
  const service = Object.create(QueueService.prototype) as {
    draining: boolean; hostLifecyclePending: boolean; hostPresenceRevision: number;
    connections: Set<{ hostPresence: boolean; closing: boolean }>;
    executor: { callHandler: () => Promise<boolean> }; stop: () => Promise<void>;
    checkHostLifecycle: () => Promise<void>;
  };
  service.draining = false;
  service.hostLifecyclePending = false;
  service.hostPresenceRevision = 0;
  service.connections = new Set();
  service.executor = { callHandler: async () => due };
  service.stop = async () => { stopped++; };
  Date.now = () => now;
  try {
    await service.checkHostLifecycle();
    now = 600_000;
    await service.checkHostLifecycle();
    assert.equal(stopped, 0, 'active or unknown runs refuse shutdown');
    due = true;
    const bridge = { hostPresence: true, closing: false };
    service.connections.add(bridge);
    await service.checkHostLifecycle();
    service.connections.delete(bridge);
    due = false; // The runtime restarts its single grace clock on presence close.
    await service.checkHostLifecycle();
    assert.equal(stopped, 0, 'bridge reconnect restarted the grace');
    now += 600_000;
    due = true;
    await service.checkHostLifecycle();
    assert.equal(stopped, 1);
  } finally { Date.now = originalNow; }
});
