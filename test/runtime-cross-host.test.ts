import { observeIdle } from './support/fakes';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import type { Adapter } from '../core/host/adapter';

test('another registered host stays available when the primary disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-cross-host-'));
  const client = { isConnected: false };
  const primary = { client, hostId: 'a', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'), connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; }, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const second = { observe: observeIdle('b-workspace') } as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => primary, timers: false });
  try {
    await runtime.started; await runtime.bootstrap;
    const admission = runtime.hostRegistry.resource('b', () => Object.create(Object.getPrototypeOf(runtime.admission)) as typeof runtime.admission);
    runtime.hostRegistry.connect('b', 'b-endpoint', { adapter: second, admission });
    client.isConnected = false;
    assert.equal(runtime.health().connected, true);
    assert.equal(runtime.hostShutdownDue(), false);
    const observed = await runtime.engine.withHost('b', () => runtime.engine.host.observe('agent'));
    assert.equal(observed.workspaceId, 'b-workspace');
  } finally { await runtime.drain(); }
});
