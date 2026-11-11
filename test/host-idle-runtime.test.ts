import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import type { Adapter } from '../core/host/adapter';
import { NUCLEUS_REPOSITORY_ORIGIN } from '../shared/contracts';

test('idle shutdown waits for live runs and a reconnect before latching cancels it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-host-'));
  const client = { isConnected: false };
  const raw = { client, hostId: 'host', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'report.mjs'),
    connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; },
    catalog: async () => ({ providers: [] }), observe: async () => ({ id: 'w', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => raw, timers: false });
  try {
    await runtime.started;
    await runtime.bootstrap;
    client.isConnected = false;
    assert.equal(runtime.hostShutdownDue(), false);
    (runtime.hostRegistry as unknown as { lastDisconnect: number }).lastDisconnect = Date.now() - 600_001;
    const runs = runtime.hostRuns as unknown as { liveRuns: () => unknown[] };
    const original = runs.liveRuns;
    runs.liveRuns = () => [{}];
    assert.equal(runtime.hostShutdownDue(), false);
    runs.liveRuns = original;
    client.isConnected = true;
    assert.equal(runtime.hostShutdownDue(), false, "a reconnect awaiting identity proof keeps the service alive");
    await runtime.ensureBootstrap();
    assert.equal(runtime.hostShutdownDue(), false);
    client.isConnected = false;
    runtime.hostShutdownDue();
    (runtime.hostRegistry as unknown as { lastDisconnect: number }).lastDisconnect = Date.now() - 600_001;
    assert.equal(runtime.hostShutdownDue(), true);
  } finally { await runtime.drain(); }
});


test('local host runs launch while the app host is offline during the grace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'offline-host-'));
  const client = { isConnected: false };
  const raw = { client, hostId: 'host', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'report.mjs'),
    connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; },
    catalog: async () => ({ providers: [] }), observe: async () => ({ id: 'w', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => raw, timers: false });
  try {
    await runtime.started;
    await runtime.bootstrap;
    client.isConnected = false;
    assert.equal(runtime.hostShutdownDue(), false, 'the grace has not expired');
    for (const source of ['client', 'admission'] as const) {
      const id = `offline-${source}`;
      runtime.hostRuns.submit({ id, epoch: runtime.hostRuns.authority().epoch, caller: `test:${source}`,
        repository: { origin: 'https://github.com/example/project', path: '/fixture' }, selector: source,
        runClass: 'light', classSource: 'default', priority: 'interactive', runTimeoutMs: 60_000, submissionSource: source },
      { launch: run => { runtime.hostRuns.markLaunched(run.id); } });
      assert.equal(runtime.hostRuns.get(id)?.state, 'running', `${source} runs while the host is offline`);
    }
  } finally { await runtime.drain(); }
});

test('losing plugin presence while a host is connected raises a board fault and messages the planner once', { timeout: 5_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-lost-'));
  const client = { isConnected: false };
  const notices: { agentId: string; text: string }[] = [];
  let resolveNotified!: () => void;
  const notified = new Promise<void>(resolve => { resolveNotified = resolve; });
  const raw = { client, hostId: 'host', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'report.mjs'),
    connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; },
    catalog: async () => ({ providers: [] }), observe: async () => ({ id: 'w', workspaceId: 'ws', status: 'idle', active: false, permissions: false, error: '' }),
    notify: async (agentId: string, _id: string, text: string) => { notices.push({ agentId, text }); resolveNotified(); },
  } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => raw, timers: false, pluginLostGraceMs: 20 });
  try {
    await runtime.started;
    await runtime.bootstrap;
    runtime.store.upsertProject({ key: 'nucleus', name: 'Nucleus', repositories: [{ origin: NUCLEUS_REPOSITORY_ORIGIN, path: '/nucleus' }] });
    runtime.store.setProjectPlanner({ key: 'nucleus', agentId: 'planner-1', setBy: 'test' });
    assert.equal(runtime.store.projectPlannerRecipient(runtime.store.queueProject()), 'planner-1');
    runtime.hostPresenceClosed();
    // The notification also waits for Paseo call admission after bootstrap.
    await notified;
    assert.match(runtime.snapshot().error, /plugin is not present while Paseo is still connected/);
    assert.match(runtime.health().pluginPresenceError ?? '', /recovery thread cannot act/);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.agentId, 'planner-1');
    assert.match(notices[0]!.text, /paseo plugin reload nucleus/);
    runtime.hostPresenceClosed();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(notices.length, 1, 'a still-missing plugin does not send a second planner message');
    runtime.hostPresenceOpened();
    assert.equal(runtime.snapshot().error, '');
    runtime.hostPresenceClosed();
    runtime.hostPresenceOpened();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(notices.length, 1, 'a presence that returns inside the grace is silent');
  } finally { await runtime.drain(); }
});
