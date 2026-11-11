import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HostRegistry, type KnownHost } from '../core/host/host-registry';

test('host claims, reconnect and shutdown grace retain separate identities', () => {
  let known: readonly KnownHost[] = [];
  let now = 0;
  const store = { read: () => known, write: (value: readonly KnownHost[]) => { known = value; }, transaction: <T>(fn: () => T) => fn() };
  const registry = new HostRegistry(store, () => now);
  const old = registry.connect('a', 'credential-a', 'first');
  assert.throws(() => registry.connect('a', 'other', 'conflict'));
  assert.throws(() => registry.connect('a', 'credential-a', 'duplicate'));
  registry.disconnect('a', old);
  const current = registry.connect('a', 'credential-a', 'replacement');
  const b = registry.connect('b', 'credential-b', 'other host');
  registry.disconnect('a', old);
  assert.equal(registry.get('a'), 'replacement');
  registry.disconnect('a', current);
  assert.equal(registry.get('b'), 'other host');
  registry.disconnect('b', b);
  now = 600_000;
  assert.equal(registry.shouldShutdown(null), false);
  assert.equal(registry.shouldShutdown(1), false);
  assert.equal(registry.shouldShutdown(0), true);
  registry.connect('a', 'credential-a', 'back');
  assert.equal(registry.shouldShutdown(0), false);
  const restarted = new HostRegistry(store, () => now);
  assert.equal(restarted.get('a'), undefined);
  assert.throws(() => restarted.connect('a', 'other', 'wrong'));
  assert.equal(restarted.known().length, 2);
});

test('registration is atomic and admission state is isolated by observed host', () => {
  let known: readonly KnownHost[] = [];
  let legacy = 'a';
  const store = {
    read: () => known,
    write: (hosts: readonly KnownHost[]) => { known = hosts; },
    transaction: <T>(fn: () => T) => {
      const previous = known;
      try { return fn(); } catch (error) { known = previous; throw error; }
    },
  };
  const registry = new HostRegistry(store);
  assert.throws(() => registry.connect('b', 'endpoint', {}, () => {
    if (legacy !== 'b') throw new Error('legacy mismatch');
  }));
  assert.deepEqual(known, []);
  legacy = 'a';
  const a = registry.connect('a', 'endpoint', {}, () => assert.equal(legacy, 'a'));
  const first = registry.resource('a', () => ({ pressure: true }));
  const second = registry.resource('b', () => ({ pressure: false }));
  assert.notEqual(first, second);
  assert.equal(second.pressure, false);
  registry.disconnect('a', a);
  assert.equal(registry.resource('a', () => ({ pressure: false })), first);
  assert.throws(() => registry.connect('b', 'endpoint', {}), /different identity/);
  assert.equal(registry.get('b'), undefined);
  const restarted = new HostRegistry(store);
  assert.equal(restarted.get('a'), undefined);
  restarted.connect('a', 'endpoint', {});
  assert.equal(known.length, 1);
});

test('disconnect time survives restart and reconnect cancels the grace', () => {
  let known: readonly KnownHost[] = [];
  let disconnected: number | null = null;
  let now = 100;
  const store = { read: () => known, write: (value: readonly KnownHost[]) => { known = value; }, transaction: <T>(fn: () => T) => fn(), readDisconnectedAt: () => disconnected, writeDisconnectedAt: (value: number | null) => { disconnected = value; } };
  const first = new HostRegistry(store, () => now);
  const token = first.connect('host', 'endpoint', {});
  first.disconnect('host', token);
  now += 600_000;
  const restarted = new HostRegistry(store, () => now);
  assert.equal(restarted.shouldShutdown(1), false);
  assert.equal(restarted.shouldShutdown(0), true);
  const next = restarted.connect('host', 'endpoint', {});
  assert.equal(restarted.shouldShutdown(0), false);
  restarted.disconnect('host', next);
  assert.equal(restarted.shouldShutdown(0), false);
});
