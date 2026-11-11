import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueRuntime } from '../service/runtime-owner';
import { submissionSchema, type Run } from '../shared/contracts';
import type { Adapter } from '../core/host/adapter';

test('the only online host can be selected while another known host is offline, with durable provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-selection-'));
  const client = { isConnected: false };
  const adapter = { client, hostId: 'a', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'), connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; }, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => adapter, timers: false });
  try {
    await runtime.started; await runtime.bootstrap;
    const token = runtime.hostRegistry.connect('b', 'endpoint-b', { adapter, admission: runtime.admission });
    runtime.hostRegistry.disconnect('b', token);
    assert.equal(runtime.engine.selectIngressHost(), 'a');
    assert.equal(runtime.engine.selectIngressHost('b'), 'b');
    const payload = { type: 'review_entry', input: {} };
    const implicit = await runtime.engine.startOperation({ key: 'implicit', kind: 'review_entry', payload, deferSchedule: true });
    const explicit = await runtime.engine.startOperation({ key: 'explicit', kind: 'review_entry', payload, hostId: 'b', deferSchedule: true });
    if (!('accepted' in implicit) || !('accepted' in explicit)) throw Error('backpressured');
    assert.deepEqual(implicit.operation.hostSelection, { hostId: 'a', basis: 'sole_online_host' });
    assert.deepEqual(explicit.operation.hostSelection, { hostId: 'b', basis: 'explicit' });
    const submission = submissionSchema.parse({ submissionId: 'selection', title: 'Task', repoPath: '/repo', planningCommit: 'a'.repeat(40), handoffPath: 'h', originAgentId: 'origin' });
    const task = runtime.store.insert(submission, 'b', 'h', 'a'.repeat(40), { hostSelection: explicit.operation.hostSelection });
    const run: Run = { id: 'run', taskId: task.id, role: 'reviewer', generation: 1, head: '', base: '', agentId: null, workspaceId: 'ws', profile: null, status: 'intent', createdAt: new Date().toISOString(), lastObservedAt: null, active: false, idleSince: null, completion: null, released: false };
    runtime.store.putRun(run);
    assert.deepEqual(runtime.store.run('run')?.hostSelection, explicit.operation.hostSelection);
    runtime.store.putRun(run);
    assert.deepEqual(runtime.store.run('run')?.hostSelection, explicit.operation.hostSelection);
  } finally { await runtime.drain(); }
});

test('a repository hostKind selects the unique online host of that kind with durable provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-kind-selection-'));
  const client = { isConnected: true };
  const adapter = { client, hostId: 'paseo-primary', socketPath: join(dir, 'callback.sock'), helperPath: join(dir, 'helper.mjs'), connect: async () => { client.isConnected = true; }, close: async () => { client.isConnected = false; }, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
  const runtime = new QueueRuntime({ dataDir: dir, adapterFactory: () => adapter, timers: false });
  try {
    await runtime.started; await runtime.bootstrap;
    const t3 = { client: { isConnected: true }, hostId: 't3code:env', socketPath: join(dir, 't3.sock'), helperPath: join(dir, 't3-helper.mjs'), connect: async () => {}, close: async () => {}, catalog: async () => ({ providers: [] }) } as unknown as Adapter;
    runtime.hostRegistry.connect('t3code:env', 'endpoint-t3', { adapter: t3, admission: runtime.admission });
    runtime.store.putRepository({ origin: null, path: '/repo' }, null, '', null, null, null, undefined, undefined, 't3code');
    assert.equal(runtime.engine.selectIngressHost(undefined, '/repo'), 't3code:env');
    const accepted = await runtime.engine.startOperation({ key: 'kind', kind: 'review_entry', payload: { type: 'review_entry', input: {} }, repoPath: '/repo', deferSchedule: true });
    if (!('accepted' in accepted)) throw Error('backpressured');
    assert.deepEqual(accepted.operation.hostSelection, { hostId: 't3code:env', basis: 'repository_host', reason: 'Repository hostKind t3code' });
  } finally { await runtime.drain(); }
});
