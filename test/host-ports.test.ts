import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambientHostPorts, onOwnerHost } from '../core/host/host-ports';
import { Resolution } from '../core/resolution';
import type { Adapter } from '../core/host/adapter';
import type { Store } from '../core/store/store';

test('the ambient set answers the single-host install and reads the adapter identity', async () => {
  const ports = ambientHostPorts(() => 'paseo:a');
  assert.equal(ports.taskAvailable({ id: 'task' } as never), true);
  assert.equal(ports.taskAvailable({ id: 'task' } as never, { hostId: 'other' } as never), true);
  assert.equal(ports.outage('paseo:a'), null);
  assert.equal(ports.workerProviderUnavailable({ id: 'task' } as never), false);
  assert.equal(ports.online('paseo:a'), true);
  assert.equal(ports.inventoryMatches('paseo:a'), true);
  assert.equal(ports.originAvailable('paseo:a'), true);
  assert.equal(ports.awaitBridge, null, 'the unwired root refuses a host-dependent call at once');
  assert.equal(ports.bridgeWaitMs, 90_000);
  assert.equal(ports.canReuseUnqualifiedOriginWorkspace(), true);
  assert.equal(await ports.identifyOriginHost('paseo:a:agent'), 'paseo:a');
  assert.equal(ports.catalogKnown(), true);
});

test('the ambient set takes no host context: work runs in the caller turn', () => {
  const ports = ambientHostPorts(() => undefined);
  let ran = false;
  const answer = ports.withHost('paseo:a', () => { ran = true; return 'here'; });
  assert.equal(answer, 'here');
  assert.equal(ran, true);
});

test('the task-owner host rule binds the owner host and keeps the ambient context otherwise', () => {
  const bound: string[] = [];
  const ports = { withHost<T>(id: string, fn: () => T): T { bound.push(id); return fn(); } };
  assert.equal(onOwnerHost(ports, { hostId: 't3code:b' }, () => 'routed'), 'routed');
  assert.deepEqual(bound, ['t3code:b']);
  assert.equal(onOwnerHost(ports, { hostId: null }, () => 'ambient'), 'ambient');
  assert.equal(onOwnerHost(ports, null, () => 'ambient'), 'ambient');
  assert.deepEqual(bound, ['t3code:b'], 'an owner with no proven host adds no context');
});

test('a resolution that was not wired keeps the one ambient set', async () => {
  const resolution = new Resolution({} as Store, { hostId: 'paseo:a' } as unknown as Adapter, () => [], () => false);
  assert.equal(resolution.hostAvailable({ id: 'task', hostId: 'paseo:a' } as never), true);
  assert.equal(resolution.hostOnline('paseo:a'), true);
  assert.equal(resolution.originHostAvailable('paseo:a'), true);
  assert.equal(resolution.inventoryHostMatches('paseo:a'), true);
  assert.equal(resolution.canReuseUnqualifiedOriginWorkspace(), true);
  assert.equal(resolution.catalogKnown(), true);
  assert.equal(resolution.awaitHostBridge, null);
  assert.equal(resolution.hostBridgeWaitMs, 90_000);
  assert.equal(await resolution.identifyOriginHost('paseo:a:agent'), 'paseo:a', 'the ambient identity is the adapter own');
  assert.equal(resolution.onTaskHost({ hostId: 'paseo:a' }, () => 'ran'), 'ran');
  resolution.hostBridgeWaitMs = 5_000;
  assert.equal(resolution.hostPorts.bridgeWaitMs, 5_000, 'the test override is the one set the root reads');
  resolution.awaitHostBridge = async () => true;
  assert.equal(await resolution.hostPorts.awaitBridge?.(1), true);
});

test('the task-owner rule reads the replaceable withHost port, not the set behind it', () => {
  const resolution = new Resolution({} as Store, { hostId: 'paseo:a' } as unknown as Adapter, () => [], () => false);
  const bound: string[] = [];
  // A caller may replace the port (the engine wires its own host context); the
  // owner-named rule must move with it instead of reading the set directly.
  resolution.withHost = <T>(id: string, fn: () => T): T => { bound.push(`port:${id}`); return fn(); };
  assert.equal(resolution.onTaskHost({ hostId: 't3code:b' }, () => 'ran'), 'ran');
  assert.deepEqual(bound, ['port:t3code:b']);
  assert.equal(resolution.onTaskHost({ hostId: null }, () => 'ambient'), 'ambient');
  assert.deepEqual(bound, ['port:t3code:b'], 'no proven host keeps the caller context');
  const set = ambientHostPorts(() => 'paseo:a');
  set.withHost = <T>(id: string, fn: () => T): T => { bound.push(`set:${id}`); return fn(); };
  resolution.hostPorts = set;
  assert.equal(resolution.onTaskHost({ hostId: 't3code:c' }, () => 'ran'), 'ran');
  assert.deepEqual(bound, ['port:t3code:b', 'port:t3code:c'], 'a replaced port is the rule, even after a new set arrives');
  delete (resolution as { withHost?: unknown }).withHost;
  resolution.onTaskHost({ hostId: 't3code:d' }, () => 'ran');
  assert.deepEqual(bound, ['port:t3code:b', 'port:t3code:c', 'set:t3code:d'], 'the unwired port reads the one set');
});

test('one wired set replaces every host question at once', async () => {
  const resolution = new Resolution({} as Store, { hostId: 'paseo:a' } as unknown as Adapter, () => [], () => false);
  const asked: string[] = [];
  resolution.hostPorts = {
    ...ambientHostPorts(() => 't3code:b'),
    taskAvailable: task => { asked.push(`task:${task.id}`); return false; },
    online: id => { asked.push(`online:${id}`); return id === 't3code:b'; },
    catalogKnown: () => { asked.push('catalog'); return false; },
  };
  assert.equal(resolution.hostAvailable({ id: 'task' } as never), false);
  assert.equal(resolution.hostOnline('t3code:b'), true);
  assert.equal(resolution.hostOnline('paseo:a'), false, 'no question keeps its ambient answer beside the wired set');
  assert.equal(resolution.catalogKnown(), false, 'an unloaded catalog is never the ambient yes after wire-up');
  assert.equal(await resolution.identifyOriginHost('t3code:b:agent'), 't3code:b');
  assert.deepEqual(asked, ['task:task', 'online:t3code:b', 'online:paseo:a', 'catalog']);
});
