import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueService } from '../service/transport/server';

test('presence that appears and closes during the idle decision cancels its latch', async () => {
  let answer!: (value: boolean) => void;
  let cancelled = 0, stopped = 0;
  const decision = new Promise<boolean>(resolve => { answer = resolve; });
  const service = Object.create(QueueService.prototype) as {
    draining: boolean; hostLifecyclePending: boolean; hostPresenceRevision: number;
    connections: Set<unknown>; executor: { callHandler: (name: string) => Promise<unknown> };
    stop: () => Promise<void>; checkHostLifecycle: () => Promise<void>;
  };
  service.draining = false;
  service.hostLifecyclePending = false;
  service.hostPresenceRevision = 0;
  service.connections = new Set();
  service.executor = { callHandler: async name => name === 'hostShutdownDue' ? decision : (++cancelled) };
  service.stop = async () => { stopped++; };
  const pending = service.checkHostLifecycle();
  service.hostPresenceRevision += 2;
  answer(true);
  await pending;
  assert.equal(cancelled, 1);
  assert.equal(stopped, 0);
});
